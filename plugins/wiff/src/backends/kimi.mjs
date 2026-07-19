import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { serializeError } from "../util.mjs";

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const READ_ONLY_INSTRUCTION =
  "Constraint: you are a read-only agent. Do not create, modify, or delete files, and do not run commands with side effects.";
const EFFORT_NOTE =
  "The kimi CLI has no per-invocation effort flag; thinking effort comes from config.toml.";

function stripAnsi(value) {
  return value.replace(ANSI_ESCAPE, "");
}

function parseToolArguments(toolCall) {
  const raw = toolCall?.function?.arguments;
  if (typeof raw !== "string") return raw && typeof raw === "object" ? raw : {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Translate one kimi stream-json assistant event into the Codex app-server
// item shapes the journal digests and viewer already understand.
function itemsForAssistantEvent(event) {
  const items = [];
  if (typeof event.content === "string" && event.content) {
    items.push({ type: "agentMessage", text: event.content });
  }
  for (const toolCall of event.tool_calls ?? []) {
    const name = toolCall?.function?.name;
    const args = parseToolArguments(toolCall);
    if (/^bash$/i.test(name ?? "") && typeof args.command === "string") {
      items.push({ type: "commandExecution", command: args.command });
    } else if (
      /write|edit|replace|apply|patch|delete|move|rename/i.test(name ?? "") &&
      typeof (args.path ?? args.file_path) === "string"
    ) {
      items.push({ type: "fileChange", changes: [{ path: args.path ?? args.file_path }] });
    } else if (/search/i.test(name ?? "") && typeof args.query === "string") {
      items.push({ type: "webSearch", query: args.query });
    } else {
      items.push({ type: "toolCall", tool: name });
    }
  }
  return items;
}

function parseStructuredResult(content) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse((fenced?.[1] ?? trimmed).trim());
}

// Backend adapter that runs each agent as a headless `kimi -p` process with
// stream-json output. See ./index.mjs for the backend contract.
//
// Sandbox mapping — kimi print mode auto-approves every tool and has no OS
// sandbox or permission gate:
//   read-only          advisory prompt instruction only; not enforced.
//   workspace-write    requires isolation: "worktree" (the worktree is the
//                      write-isolation mechanism).
//   danger-full-access runs as-is.
export class KimiBackend {
  #children = new Set();
  #closed = false;

  constructor({ command = "kimi" } = {}) {
    this.command = command;
  }

  #buildPrompt(prompt, options, instructions) {
    if (options.sandbox === "workspace-write" && options.isolation !== "worktree") {
      throw new Error(
        'Kimi agents have no OS sandbox: sandbox "workspace-write" requires isolation: "worktree".',
      );
    }
    if (!["read-only", "workspace-write", "danger-full-access"].includes(options.sandbox)) {
      throw new Error(`Unsupported agent sandbox for the kimi backend: ${options.sandbox}`);
    }

    const parts = [];
    if (options.sandbox === "read-only") parts.push(READ_ONLY_INSTRUCTION);
    if (instructions !== undefined) {
      parts.push(`<developer_instructions>\n${instructions}\n</developer_instructions>`);
    }
    parts.push(prompt);
    if (options.schema !== undefined) {
      parts.push(
        `Reply with ONLY a JSON value matching this JSON Schema: ${JSON.stringify(options.schema)}`,
      );
    }
    return parts.join("\n\n");
  }

  async runAgent({ prompt, options, instructions, signal, onEvent }) {
    if (this.#closed) throw new Error("Kimi backend is closed.");
    if (signal?.aborted) throw signal.reason ?? new Error("Agent aborted.");

    const finalPrompt = this.#buildPrompt(prompt, options, instructions);
    const args = [
      "-p",
      finalPrompt,
      "--output-format",
      "stream-json",
      "-m",
      options.model,
      // options.effort is accepted by the backend contract but kimi-code has
      // no per-invocation effort flag; config.toml controls thinking effort.
    ];
    const child = spawn(this.command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEX_WORKFLOW_CHILD: "1" },
    });
    this.#children.add(child);

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-32_000);
    });

    let threadId;
    let finalContent;
    const emit = (method, params) => {
      try {
        onEvent?.({ method, params });
      } catch {
        // Transcript capture must not break an agent turn.
      }
    };
    const pendingItems = [];
    const emitItem = (item) => {
      if (threadId) emit("item/completed", { threadId, item });
      else pendingItems.push(item);
    };
    const flushPendingItems = () => {
      for (const item of pendingItems.splice(0)) {
        emit("item/completed", { threadId, item });
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
      if (!threadId && typeof event.session_id === "string") {
        threadId = event.session_id;
        emit("workflow/agentThreadStarted", { threadId });
        flushPendingItems();
      }
      if (event.role !== "assistant") return;
      if (typeof event.content === "string" && event.content.trim()) {
        finalContent = event.content;
      }
      for (const item of itemsForAssistantEvent(event)) {
        emitItem(item);
      }
    });

    const abortListener = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abortListener, { once: true });

    try {
      const exit = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, killSignal) => resolve({ code, killSignal }));
      });
      const [{ code, killSignal }] = await Promise.all([exit, once(lines, "close")]);
      flushPendingItems();
      if (signal?.aborted) throw signal.reason ?? new Error("Agent aborted.");
      if (code !== 0 || finalContent === undefined) {
        const detail =
          stripAnsi(stderr).trim() ||
          (code !== 0
            ? `exited (${killSignal ?? code ?? "unknown"})`
            : "completed without a final assistant message");
        throw new Error(`Kimi agent did not complete: ${detail}`);
      }

      let result = finalContent;
      if (options.schema !== undefined) {
        try {
          result = parseStructuredResult(finalContent);
        } catch (error) {
          throw new Error(`Kimi structured output was not valid JSON: ${error.message}`);
        }
      }

      return { result, threadId, turnId: undefined, usage: undefined };
    } catch (error) {
      emit("workflow/agentError", { threadId, error: serializeError(error) });
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortListener);
      this.#children.delete(child);
      if (!child.killed) child.kill("SIGTERM");
    }
  }

  async listModels() {
    if (this.#closed) throw new Error("Kimi backend is closed.");
    const child = spawn(this.command, ["provider", "list", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEX_WORKFLOW_CHILD: "1" },
    });
    this.#children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-32_000);
    });

    try {
      const { code, killSignal } = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (exitCode, exitSignal) =>
          resolve({ code: exitCode, killSignal: exitSignal }),
        );
      });
      if (code !== 0) {
        const detail =
          stripAnsi(stderr).trim() || `exited (${killSignal ?? code ?? "unknown"})`;
        throw new Error(`Kimi model listing failed: ${detail}`);
      }

      let catalog;
      try {
        catalog = JSON.parse(stdout);
      } catch (error) {
        throw new Error(`Kimi model listing returned invalid JSON: ${error.message}`);
      }
      const catalogDefault = catalog?.defaultModel ?? catalog?.default_model;
      return Object.entries(catalog?.models ?? {}).map(([id, model]) => {
        const modelDefault = model?.isDefault ?? model?.is_default;
        const isDefault =
          id === "kimi-code/k3"
            ? true
            : typeof modelDefault === "boolean"
            ? modelDefault
            : typeof catalogDefault === "string"
              ? id === catalogDefault
              : undefined;
        return {
          id,
          displayName: model?.displayName,
          description: model?.description,
          efforts: model?.supportEfforts,
          defaultEffort: model?.defaultEffort,
          isDefault,
          note: EFFORT_NOTE,
        };
      });
    } catch (error) {
      if (/^Kimi model listing/.test(error.message)) throw error;
      throw new Error(`Kimi model listing failed: ${stripAnsi(error.message)}`);
    } finally {
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
