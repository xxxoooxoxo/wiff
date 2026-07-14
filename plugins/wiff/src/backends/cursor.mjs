import { serializeError } from "../util.mjs";

const STRUCTURED_OUTPUT_TOOL = "structured_output";

// Translate one Cursor SDK message into the Codex app-server item shapes the
// journal digests and viewer already understand.
function itemsForSdkMessage(message) {
  if (message.type === "assistant") {
    return (message.message?.content ?? [])
      .filter((block) => block.type === "text" && block.text)
      .map((block) => ({ type: "agentMessage", text: block.text }));
  }
  if (message.type === "thinking" && message.text) {
    return [{ type: "reasoning", text: message.text }];
  }
  if (message.type === "tool_call" && message.status === "completed") {
    const args = message.args ?? {};
    if (typeof args.command === "string") {
      return [{ type: "commandExecution", command: args.command }];
    }
    if (typeof args.path === "string" && /write|edit|apply|delete/i.test(message.name ?? "")) {
      return [{ type: "fileChange", changes: [{ path: args.path }] }];
    }
    if (message.name === STRUCTURED_OUTPUT_TOOL) return [];
    return [{ type: "toolCall", tool: message.name }];
  }
  return [];
}

function normalizeUsage(usage) {
  if (!usage) return undefined;
  return {
    total: {
      totalTokens: usage.totalTokens ?? 0,
      inputTokens: (usage.inputTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      cachedInputTokens: usage.cacheReadTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    },
  };
}

// Backend adapter that runs each agent through the official Cursor SDK
// (`@cursor/sdk`, an optional dependency) in local mode: the agent loop runs
// inline in this process against the agent's cwd. See ./index.mjs for the
// backend contract.
//
// Contract mapping notes:
//   instructions  The SDK has no system-prompt channel, so persona
//                 instructions are prepended to the prompt.
//   schema        The SDK has no native structured output; the schema is
//                 exposed as an in-process `structured_output` custom tool
//                 the agent is instructed to call, falling back to parsing
//                 the final message as JSON.
//   sandbox       Cursor's local sandbox only gates command execution:
//                 `read-only` and `workspace-write` run with the sandbox
//                 enabled, and `workspace-write` requires isolation:
//                 "worktree" (same policy as the claude backend);
//                 `danger-full-access` disables the sandbox.
export class CursorBackend {
  #loadSdk;
  #sdkPromise;
  #active = new Set();
  #closed = false;

  constructor({ loadSdk } = {}) {
    this.#loadSdk = loadSdk ?? (() => import("@cursor/sdk"));
  }

  async #sdk() {
    this.#sdkPromise ??= this.#loadSdk();
    try {
      return await this.#sdkPromise;
    } catch (error) {
      this.#sdkPromise = undefined;
      throw new Error(
        `The cursor backend requires the optional @cursor/sdk dependency (npm install @cursor/sdk): ${error.message}`,
      );
    }
  }

  async runAgent({ prompt, options, instructions, signal, onEvent }) {
    if (this.#closed) throw new Error("Cursor backend is closed.");
    if (signal?.aborted) throw signal.reason ?? new Error("Agent aborted.");
    const { Agent } = await this.#sdk();

    if (options.sandbox === "workspace-write" && options.isolation !== "worktree") {
      throw new Error(
        'Cursor agents have no read/write OS sandbox: sandbox "workspace-write" requires isolation: "worktree".',
      );
    }

    let structuredOutput;
    const localOptions = {
      cwd: options.cwd,
      // Fleet children must be deterministic: no ambient user/project rules.
      settingSources: [],
      sandboxOptions: { enabled: options.sandbox !== "danger-full-access" },
    };
    if (options.schema !== undefined) {
      localOptions.customTools = {
        [STRUCTURED_OUTPUT_TOOL]: {
          description:
            "Report your final structured result. Call this exactly once before finishing.",
          inputSchema: options.schema,
          execute: (args) => {
            structuredOutput = args;
            return "Structured output recorded.";
          },
        },
      };
    }

    const parts = [];
    if (instructions !== undefined) {
      parts.push(`<developer_instructions>\n${instructions}\n</developer_instructions>`);
    }
    parts.push(prompt);
    if (options.sandbox === "read-only") {
      parts.push(
        "Constraint: you are a read-only agent. Do not create, modify, or delete files, and do not run commands with side effects.",
      );
    }
    if (options.schema !== undefined) {
      parts.push(
        `You MUST call the ${STRUCTURED_OUTPUT_TOOL} tool exactly once with your final result before finishing.`,
      );
    }

    const agent = await Agent.create({
      model: { id: options.model },
      name: options.label,
      local: localOptions,
    });
    const entry = { agent, run: undefined };
    this.#active.add(entry);
    let abortListener;
    try {
      onEvent?.({
        method: "workflow/agentThreadStarted",
        params: { threadId: agent.agentId },
      });
      const run = await agent.send(parts.join("\n\n"));
      entry.run = run;

      abortListener = () => {
        run.cancel().catch(() => {});
      };
      signal?.addEventListener("abort", abortListener, { once: true });
      if (signal?.aborted) abortListener();

      let usage;
      for await (const message of run.stream()) {
        if (message.type === "usage") usage = message.usage;
        for (const item of itemsForSdkMessage(message)) {
          try {
            onEvent?.({
              method: "item/completed",
              params: { threadId: agent.agentId, item },
            });
          } catch {
            // Transcript capture must not break an agent turn.
          }
        }
      }
      const outcome = await run.wait();
      if (signal?.aborted) throw signal.reason ?? new Error("Agent aborted.");
      if (outcome.status !== "finished") {
        const detail = outcome.error?.message ?? outcome.status;
        throw new Error(`Cursor agent did not complete: ${detail}`);
      }

      let result = outcome.result;
      if (options.schema !== undefined) {
        if (structuredOutput !== undefined) {
          result = structuredOutput;
        } else {
          try {
            result = JSON.parse(outcome.result);
          } catch (error) {
            throw new Error(
              `Cursor agent finished without calling ${STRUCTURED_OUTPUT_TOOL} and its final message was not valid JSON: ${error.message}`,
            );
          }
        }
      } else if (typeof result !== "string") {
        throw new Error("Cursor agent completed without a final message.");
      }

      return {
        result,
        threadId: agent.agentId,
        turnId: run.id,
        usage: normalizeUsage(outcome.usage ?? usage),
      };
    } catch (error) {
      try {
        onEvent?.({
          method: "workflow/agentError",
          params: { threadId: agent.agentId, error: serializeError(error) },
        });
      } catch {
        // Transcript capture must not break error propagation.
      }
      throw error;
    } finally {
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      this.#active.delete(entry);
      await this.#dispose(entry);
    }
  }

  async #dispose(entry) {
    try {
      if (entry.run?.status === "running") await entry.run.cancel();
    } catch {
      // Best-effort cleanup.
    }
    try {
      await entry.agent[Symbol.asyncDispose]?.();
    } catch {
      // Best-effort cleanup.
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const entries = [...this.#active];
    this.#active.clear();
    await Promise.allSettled(entries.map((entry) => this.#dispose(entry)));
  }
}
