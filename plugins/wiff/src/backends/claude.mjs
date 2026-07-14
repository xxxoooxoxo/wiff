import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { serializeError } from "../util.mjs";

const READ_ONLY_TOOLS = "Read,Glob,Grep";

// Claude effort tiers are a superset of Codex's; only "minimal" needs mapping.
const EFFORT_MAP = { minimal: "low" };

// Translate one claude stream-json content block into the Codex app-server
// item shape the journal digests and viewer already understand.
function itemForContentBlock(block) {
  if (block.type === "text" && block.text) {
    return { type: "agentMessage", text: block.text };
  }
  if (block.type === "thinking" && block.thinking) {
    return { type: "reasoning", text: block.thinking };
  }
  if (block.type === "tool_use") {
    if (block.name === "Bash" && block.input?.command) {
      return { type: "commandExecution", command: block.input.command };
    }
    if (
      ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(block.name) &&
      block.input?.file_path
    ) {
      return { type: "fileChange", changes: [{ path: block.input.file_path }] };
    }
    if (block.name === "WebSearch" && block.input?.query) {
      return { type: "webSearch", query: block.input.query };
    }
    if (block.name === "StructuredOutput") return null;
    return { type: "toolCall", tool: block.name };
  }
  return null;
}

function normalizeUsage(resultEvent) {
  const usage = resultEvent?.usage;
  if (!usage) return undefined;
  const inputTokens = usage.input_tokens ?? 0;
  const cachedInputTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  return {
    total: {
      totalTokens: inputTokens + cachedInputTokens + cacheCreationInputTokens + outputTokens,
      inputTokens: inputTokens + cacheCreationInputTokens,
      cachedInputTokens,
      outputTokens,
    },
    totalCostUsd: resultEvent.total_cost_usd,
  };
}

// Backend adapter that runs each agent as a headless `claude -p` process with
// stream-json output. See ./index.mjs for the backend contract.
//
// Sandbox mapping — unlike Codex, `claude -p` has no OS-enforced sandbox, so
// sandbox levels map to permission policy:
//   read-only          only Read/Glob/Grep tools are available.
//   workspace-write    requires isolation: "worktree" (the worktree is the
//                      write-isolation mechanism); edits are auto-accepted and
//                      Bash is allowed, enforced by policy rather than the OS.
//   danger-full-access --dangerously-skip-permissions.
export class ClaudeBackend {
  #children = new Set();
  #closed = false;

  constructor({ command = "claude" } = {}) {
    this.command = command;
  }

  #buildArgs(options, instructions) {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      // Fleet children must not pollute the user's resume list, run their
      // hooks, or drag in every configured MCP server.
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--model",
      options.model,
      "--effort",
      EFFORT_MAP[options.effort] ?? options.effort,
    ];
    if (instructions !== undefined) args.push("--append-system-prompt", instructions);
    if (options.schema !== undefined) args.push("--json-schema", JSON.stringify(options.schema));

    if (options.sandbox === "read-only") {
      args.push("--tools", READ_ONLY_TOOLS);
    } else if (options.sandbox === "workspace-write") {
      if (options.isolation !== "worktree") {
        throw new Error(
          'Claude agents have no OS sandbox: sandbox "workspace-write" requires isolation: "worktree".',
        );
      }
      args.push("--permission-mode", "acceptEdits", "--allowedTools", "Bash");
    } else if (options.sandbox === "danger-full-access") {
      args.push("--dangerously-skip-permissions");
    } else {
      throw new Error(`Unsupported agent sandbox for the claude backend: ${options.sandbox}`);
    }
    return args;
  }

  // The claude CLI has no headless model-list command, so report the stable
  // aliases it resolves itself; full claude-* model ids are also accepted.
  async listModels() {
    const efforts = ["low", "medium", "high", "xhigh", "max"];
    const note = "Alias resolved by the claude CLI; full claude-* model ids are also accepted.";
    return [
      { id: "fable", displayName: "Fable", description: "Latest Claude Fable model.", efforts, note },
      { id: "opus", displayName: "Opus", description: "Latest Claude Opus model.", efforts, note },
      { id: "sonnet", displayName: "Sonnet", description: "Latest Claude Sonnet model.", efforts, note },
      { id: "haiku", displayName: "Haiku", description: "Latest Claude Haiku model.", efforts, note },
    ];
  }

  async runAgent({ prompt, options, instructions, signal, onEvent }) {
    if (this.#closed) throw new Error("Claude backend is closed.");
    if (signal?.aborted) throw signal.reason ?? new Error("Agent aborted.");

    const child = spawn(this.command, this.#buildArgs(options, instructions), {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_WORKFLOW_CHILD: "1" },
    });
    this.#children.add(child);

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-32_000);
    });

    let threadId;
    let resultEvent;
    const emit = (method, params) => {
      try {
        onEvent?.({ method, params });
      } catch {
        // Transcript capture must not break an agent turn.
      }
    };
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "system" && event.subtype === "init") {
        threadId = event.session_id;
        emit("workflow/agentThreadStarted", { threadId });
      } else if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          const item = itemForContentBlock(block);
          if (item) emit("item/completed", { threadId, item });
        }
      } else if (event.type === "result") {
        resultEvent = event;
      }
    });

    const abortListener = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abortListener, { once: true });

    try {
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
      const exit = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, killSignal) => resolve({ code, killSignal }));
      });
      // Wait for readline too so a final unterminated line is not dropped.
      const [{ code, killSignal }] = await Promise.all([exit, once(lines, "close")]);
      if (signal?.aborted) throw signal.reason ?? new Error("Agent aborted.");
      if (resultEvent === undefined || resultEvent.is_error || resultEvent.subtype !== "success") {
        const detail =
          (typeof resultEvent?.result === "string" && resultEvent.result.trim()) ||
          resultEvent?.subtype ||
          stderr.trim() ||
          `exited (${killSignal ?? code ?? "unknown"})`;
        throw new Error(`Claude agent did not complete: ${detail}`);
      }

      let result = resultEvent.result;
      if (options.schema !== undefined) {
        if (resultEvent.structured_output !== undefined) {
          result = resultEvent.structured_output;
        } else {
          try {
            result = JSON.parse(resultEvent.result);
          } catch (error) {
            throw new Error(`Claude structured output was not valid JSON: ${error.message}`);
          }
        }
      } else if (typeof result !== "string") {
        throw new Error("Claude agent completed without a final message.");
      }

      return {
        result,
        threadId: threadId ?? resultEvent.session_id,
        turnId: resultEvent.uuid,
        usage: normalizeUsage(resultEvent),
      };
    } catch (error) {
      emit("workflow/agentError", { threadId, error: serializeError(error) });
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortListener);
      this.#children.delete(child);
      if (!child.killed) child.kill("SIGTERM");
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const child of this.#children) {
      if (!child.killed) child.kill("SIGTERM");
    }
    this.#children.clear();
  }
}
