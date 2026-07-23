import { execFile, spawn } from "node:child_process";
import readline from "node:readline";
import { promisify } from "node:util";
import { serializeError } from "../util.mjs";

const execFileAsync = promisify(execFile);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function parseCodexMcpServerNames(stdout) {
  const listing = JSON.parse(stdout);
  if (!Array.isArray(listing)) throw new Error("Codex MCP listing was not an array.");
  return [
    ...new Set(
      listing
        .map((entry) => entry?.name)
        .filter((name) => typeof name === "string" && name.trim())
        .map((name) => name.trim()),
    ),
  ];
}

export function buildCodexAppServerArgs(mcpServerNames) {
  const args = [
    "app-server",
    "--stdio",
    "--disable",
    "multi_agent",
    "--disable",
    "plugins",
    "--disable",
    "apps",
  ];
  for (const name of new Set(["codex", ...mcpServerNames])) {
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      throw new Error(
        `Cannot safely disable Codex MCP server "${name}"; server names must contain only letters, digits, dash, or underscore.`,
      );
    }
    args.push("-c", `mcp_servers.${name}.enabled=false`);
  }
  return args;
}

// Backend adapter that runs agents as native Codex threads over a single
// long-lived `codex app-server` JSON-RPC child. See ./index.mjs for the
// backend contract this implements.
export class CodexBackend {
  #child;
  #nextId = 1;
  #pending = new Map();
  #turns = new Map();
  #startPromise;
  #closed = false;
  #stderr = "";

  constructor({
    command = "codex",
    requestTimeoutMs = 30_000,
    mcpDiscoveryTimeoutMs = 10_000,
    mcpServerNames,
    mcpServerDiscovery,
  } = {}) {
    this.command = command;
    this.requestTimeoutMs = requestTimeoutMs;
    this.mcpDiscoveryTimeoutMs = mcpDiscoveryTimeoutMs;
    this.mcpServerNames = mcpServerNames;
    this.mcpServerDiscovery = mcpServerDiscovery;
  }

  async start() {
    if (this.#closed) throw new Error("Codex app-server client is closed.");
    if (this.#startPromise) return this.#startPromise;
    const starting = this.#start();
    this.#startPromise = starting;
    starting.catch(() => {
      if (this.#startPromise !== starting) return;
      if (this.#child && !this.#child.killed) this.#child.kill("SIGTERM");
      this.#child = undefined;
      this.#startPromise = undefined;
    });
    return starting;
  }

  async #mcpServerNames() {
    if (this.mcpServerNames !== undefined) return this.mcpServerNames;
    if (this.mcpServerDiscovery) return this.mcpServerDiscovery();
    let stdout;
    try {
      ({ stdout } = await execFileAsync(
        this.command,
        ["--disable", "plugins", "--disable", "apps", "mcp", "list", "--json"],
        {
          env: { ...process.env, CODEX_WORKFLOW_CHILD: "1" },
          timeout: this.mcpDiscoveryTimeoutMs,
          maxBuffer: 1024 * 1024,
        },
      ));
    } catch (error) {
      throw new Error(
        `Unable to enumerate configured Codex MCP servers; refusing to start a Wiff child with inherited MCPs: ${error.message}`,
      );
    }
    try {
      return parseCodexMcpServerNames(stdout);
    } catch (error) {
      throw new Error(
        `Unable to parse the configured Codex MCP server list; refusing to start a Wiff child with inherited MCPs: ${error.message}`,
      );
    }
  }

  async #start() {
    const mcpServerNames = await this.#mcpServerNames();
    this.#stderr = "";
    const child = spawn(
      this.command,
      buildCodexAppServerArgs(mcpServerNames),
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CODEX_WORKFLOW_CHILD: "1" },
      },
    );
    this.#child = child;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-32_000);
    });
    child.on("error", (error) => {
      if (this.#child === child) this.#failAll(error);
    });
    child.on("exit", (code, signal) => {
      if (this.#child !== child) return;
      if (!this.#closed) {
        const detail = this.#stderr.trim();
        this.#failAll(
          new Error(
            `Codex app-server exited (${signal ?? code ?? "unknown"}).${detail ? ` ${detail}` : ""}`,
          ),
        );
      }
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#handleLine(line));

    await this.#request("initialize", {
      clientInfo: {
        name: "wiff",
        title: "wiff",
        version: "0.6.1",
      },
      capabilities: { experimentalApi: true },
    });
    this.#send({ method: "initialized", params: {} });
  }

  #send(message) {
    if (!this.#child?.stdin.writable) {
      throw new Error("Codex app-server stdin is not writable.");
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #request(method, params, timeoutMs = this.requestTimeoutMs) {
    const id = this.#nextId++;
    const pending = deferred();
    const timer = setTimeout(() => {
      if (!this.#pending.delete(id)) return;
      pending.reject(new Error(`Codex app-server request timed out: ${method}`));
    }, timeoutMs);
    timer.unref?.();
    this.#pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        pending.resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        pending.reject(error);
      },
    });
    this.#send({ id, method, params });
    return pending.promise;
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Codex app-server request failed."));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.#send({
        id: message.id,
        error: {
          code: -32000,
          message: "Interactive requests are unavailable inside a deterministic workflow agent.",
        },
      });
      return;
    }

    if (message.method) this.#handleNotification(message);
  }

  #handleNotification(message) {
    const threadId = message.params?.threadId;
    const context = threadId ? this.#turns.get(threadId) : undefined;
    if (!context) return;

    try {
      context.onEvent?.(message);
    } catch {
      // Transcript capture must not break an agent turn.
    }

    if (message.method === "item/completed") {
      const item = message.params?.item;
      if (item?.type === "agentMessage") context.finalMessage = item.text;
    } else if (message.method === "thread/tokenUsage/updated") {
      context.usage = message.params?.tokenUsage;
    } else if (message.method === "turn/completed") {
      context.completion.resolve(message.params?.turn);
    }
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const context of this.#turns.values()) context.completion.reject(error);
    this.#turns.clear();
  }

  async listModels() {
    await this.start();
    const response = await this.#request("model/list", {});
    return (response?.data ?? [])
      .filter((model) => !model.hidden)
      .map((model) => ({
        id: model.id,
        displayName: model.displayName,
        description: model.description,
        efforts: (model.supportedReasoningEfforts ?? []).map((effort) => effort.reasoningEffort),
        defaultEffort: model.defaultReasoningEffort,
        isDefault: model.isDefault || undefined,
      }));
  }

  async runAgent({ prompt, options, instructions, signal, onEvent }) {
    await this.start();
    if (signal?.aborted) throw signal.reason ?? new Error("Agent aborted.");

    const threadParams = {
      model: options.model,
      cwd: options.cwd,
      approvalPolicy: "never",
      sandbox: options.sandbox,
      serviceName: "wiff",
      ephemeral: false,
      config: {
        features: { multi_agent: false },
      },
    };
    if (instructions !== undefined) threadParams.developerInstructions = instructions;
    const threadResponse = await this.#request("thread/start", threadParams);
    const threadId = threadResponse?.thread?.id;
    if (!threadId) throw new Error("Codex app-server did not return a thread id.");

    const context = {
      threadId,
      turnId: undefined,
      finalMessage: undefined,
      usage: undefined,
      completion: deferred(),
      onEvent,
    };
    this.#turns.set(threadId, context);
    onEvent?.({ method: "workflow/agentThreadStarted", params: { threadId } });

    let abortListener;
    try {
      const turnParams = {
        threadId,
        input: [{ type: "text", text: prompt }],
        model: options.model,
        effort: options.effort,
      };
      if (options.schema !== undefined) turnParams.outputSchema = options.schema;
      const turnResponse = await this.#request("turn/start", turnParams);
      context.turnId = turnResponse?.turn?.id;
      if (!context.turnId) throw new Error("Codex app-server did not return a turn id.");

      abortListener = () => {
        this.#request(
          "turn/interrupt",
          { threadId, turnId: context.turnId },
          10_000,
        ).catch(() => {});
      };
      signal?.addEventListener("abort", abortListener, { once: true });
      if (signal?.aborted) abortListener();

      const turn = await context.completion.promise;
      if (signal?.aborted) throw signal.reason ?? new Error("Agent aborted.");
      if (turn?.status !== "completed") {
        const error = turn?.error ? JSON.stringify(turn.error) : turn?.status ?? "unknown";
        throw new Error(`Codex agent turn did not complete: ${error}`);
      }
      if (typeof context.finalMessage !== "string") {
        throw new Error("Codex agent completed without a final message.");
      }

      let result = context.finalMessage;
      if (options.schema !== undefined) {
        try {
          result = JSON.parse(context.finalMessage);
        } catch (error) {
          throw new Error(`Codex structured output was not valid JSON: ${error.message}`);
        }
      }
      return {
        result,
        threadId,
        turnId: context.turnId,
        usage: context.usage,
      };
    } catch (error) {
      onEvent?.({
        method: "workflow/agentError",
        params: { threadId, turnId: context.turnId, error: serializeError(error) },
      });
      throw error;
    } finally {
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      this.#turns.delete(threadId);
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error("Codex app-server client closed."));
    if (this.#child && !this.#child.killed) this.#child.kill("SIGTERM");
  }
}

// Backwards-compatible name from before the pluggable-backend refactor.
export { CodexBackend as AppServerClient };
