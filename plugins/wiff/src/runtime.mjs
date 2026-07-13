import { execFile, fork } from "node:child_process";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AppServerClient } from "./app-server-client.mjs";
import { Semaphore } from "./semaphore.mjs";
import {
  JsonlWriter,
  atomicWriteJson,
  createRunId,
  ensureDir,
  hashText,
  hashValue,
  jsonClone,
  readJson,
  readJsonl,
  safeFilename,
  serializeError,
} from "./util.mjs";
import { validateWorkflowSource } from "./workflow-source.mjs";

const execFileAsync = promisify(execFile);

const MAX_SCRIPT_BYTES = 512 * 1024;
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1_000;
const AGENT_TYPE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MAX_PERSONA_BYTES = 64 * 1024;
const PERSONA_DEFAULT_KEYS = new Set(["model", "effort", "sandbox"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const CANCEL_FILE_NAME = "cancel.json";
const WORKER_PATH = fileURLToPath(new URL("./workflow-worker.mjs", import.meta.url));
const SOURCE_DIRECTORY = path.dirname(WORKER_PATH);

function defaultStateRoot() {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return process.env.CODEX_WORKFLOW_HOME ?? path.join(codexHome, "workflows");
}

function defaultAgentsDir() {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return process.env.CODEX_WORKFLOW_AGENTS_DIR ?? path.join(codexHome, "agents");
}

function defaultConcurrency() {
  const processors = os.availableParallelism?.() ?? os.cpus().length;
  return Math.min(16, Math.max(2, processors - 2));
}

function parsePersona(text, sourcePath) {
  let body = text;
  const defaults = {};
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const closingLineEnd = text.indexOf("\n", end + 1);
      body = closingLineEnd === -1 ? "" : text.slice(closingLineEnd + 1);
      for (const line of text.slice(3, end).split("\n")) {
        const match = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.+?)\s*$/.exec(line);
        if (match && PERSONA_DEFAULT_KEYS.has(match[1])) defaults[match[1]] = match[2];
      }
    }
  }
  const instructions = body.trim();
  if (!instructions) throw new Error(`Agent type persona has no instructions: ${sourcePath}`);
  return { defaults, instructions, sourcePath };
}

function validateRunId(runId) {
  if (typeof runId !== "string" || !/^wf_[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new Error("Invalid workflow run id.");
  }
  return runId;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function markInterrupted(run) {
  run.status = "interrupted";
  run.error = {
    name: "InterruptedError",
    message: "The workflow host exited before this run reached a terminal state. Resume it to continue.",
  };
  run.completedAt = new Date().toISOString();
  run.updatedAt = run.completedAt;
  run.revision = (run.revision ?? 0) + 1;
  return run;
}

function timeoutSignal(parentSignal, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms.`)),
    timeoutMs,
  );
  timer.unref?.();
  return {
    signal: parentSignal
      ? AbortSignal.any([parentSignal, controller.signal])
      : controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function loadCache(journalPath) {
  const cache = new Map();
  for (const event of await readJsonl(journalPath)) {
    if (event.type === "agent.completed") {
      cache.set(event.key, {
        inputHash: event.inputHash,
        result: event.result,
        threadId: event.threadId,
        turnId: event.turnId,
        worktreePath: event.worktreePath,
        worktreeKept: event.worktreeKept,
      });
    }
  }
  return cache;
}

async function assertDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error("cwd must be an absolute path.");
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error(`cwd is not a directory: ${directory}`);
}

export class WorkflowManager {
  #active = new Map();
  #waiters = new Map();
  #writeQueues = new Map();
  #worktreeMutex = Promise.resolve();
  #initialized = false;

  constructor({ stateRoot = defaultStateRoot(), backend, maxConcurrency, agentsDir } = {}) {
    this.stateRoot = stateRoot;
    this.runsDirectory = path.join(stateRoot, "runs");
    this.agentsDir = agentsDir ?? defaultAgentsDir();
    this.backend = backend ?? new AppServerClient();
    this.semaphore = new Semaphore(maxConcurrency ?? defaultConcurrency());
  }

  async initialize() {
    if (this.#initialized) return;
    this.#initialized = true;
    await ensureDir(this.runsDirectory);
    for (const entry of await readdir(this.runsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const runPath = path.join(this.runsDirectory, entry.name, "run.json");
      try {
        const run = await readJson(runPath);
        if (run.status === "running" && !isProcessAlive(run.ownerPid)) {
          await atomicWriteJson(runPath, markInterrupted(run));
        }
      } catch {
        // Ignore unrelated or incomplete directories.
      }
    }
  }

  async start(input) {
    await this.initialize();
    const resumeRunId = input?.resumeFromRunId;
    let run;
    let source;
    let runDirectory;
    let runId;

    if (resumeRunId !== undefined) {
      runId = validateRunId(resumeRunId);
      if (this.#active.has(runId)) throw new Error(`Workflow ${runId} is already running.`);
      runDirectory = path.join(this.runsDirectory, runId);
      run = await readJson(path.join(runDirectory, "run.json"));
      if (run.status === "running" && isProcessAlive(run.ownerPid)) {
        throw new Error(`Workflow ${runId} is already running.`);
      }
      const resumeCwd = input.cwd ?? run.cwd;
      source = await this.#readSource(input, resumeCwd, path.join(runDirectory, "script.js"));
      run.cwd = resumeCwd;
      if (input.scriptPath) {
        run.sourceInputPath = path.isAbsolute(input.scriptPath)
          ? input.scriptPath
          : path.resolve(resumeCwd, input.scriptPath);
      }
      run.args = input.args === undefined ? run.args : jsonClone(input.args, "args");
      run.attempt = (run.attempt ?? 1) + 1;
      run.resumedAt = new Date().toISOString();
    } else {
      runId = createRunId();
      runDirectory = path.join(this.runsDirectory, runId);
      if (typeof input?.cwd !== "string") throw new Error("cwd is required.");
      source = await this.#readSource(input, input.cwd);
      const now = new Date().toISOString();
      run = {
        schemaVersion: 1,
        runId,
        status: "running",
        cwd: input.cwd,
        args: jsonClone(input.args ?? null, "args"),
        sourceInputPath: input.scriptPath
          ? path.resolve(input.cwd, input.scriptPath)
          : null,
        scriptPath: path.join(runDirectory, "script.js"),
        journalPath: path.join(runDirectory, "journal.jsonl"),
        runPath: path.join(runDirectory, "run.json"),
        createdAt: now,
        attempt: 1,
        revision: 0,
      };
    }

    await assertDirectory(run.cwd);
    if (Buffer.byteLength(source, "utf8") > MAX_SCRIPT_BYTES) {
      throw new Error(`Workflow script exceeds ${MAX_SCRIPT_BYTES} bytes.`);
    }
    validateWorkflowSource(source);
    await ensureDir(path.join(runDirectory, "agents"));
    await rm(path.join(runDirectory, CANCEL_FILE_NAME), { force: true });
    await writeFile(path.join(runDirectory, "script.js"), source, "utf8");

    const now = new Date().toISOString();
    Object.assign(run, {
      status: "running",
      ownerPid: process.pid,
      sourceHash: hashText(source),
      phase: null,
      result: undefined,
      error: undefined,
      completedAt: undefined,
      startedAt: now,
      updatedAt: now,
      stats: { requested: 0, running: 0, completed: 0, failed: 0, cached: 0 },
      failures: [],
      worktrees: [],
    });
    run.revision = (run.revision ?? 0) + 1;
    await this.#persistRun(run);

    const execution = {
      abortController: new AbortController(),
      worker: undefined,
      promise: undefined,
      stopKind: undefined,
      cancelWatcher: undefined,
    };
    this.#active.set(runId, execution);
    execution.cancelWatcher = this.#watchCancellation(run, execution);
    execution.promise = this.#execute(run, source, execution)
      .finally(() => {
        clearInterval(execution.cancelWatcher);
        this.#active.delete(runId);
        this.#notify(runId);
      });

    return jsonClone(run);
  }

  async #readSource(input, cwd, fallbackPath) {
    if (typeof input?.script === "string" && typeof input?.scriptPath === "string") {
      throw new Error("Provide script or scriptPath, not both.");
    }
    if (typeof input?.script === "string") return input.script;
    if (typeof input?.scriptPath === "string") {
      const sourcePath = path.isAbsolute(input.scriptPath)
        ? input.scriptPath
        : path.resolve(cwd, input.scriptPath);
      return readFile(sourcePath, "utf8");
    }
    if (fallbackPath) return readFile(fallbackPath, "utf8");
    throw new Error("Provide either script or scriptPath.");
  }

  async #execute(run, source, execution) {
    const journal = new JsonlWriter(run.journalPath);
    const cache = await loadCache(run.journalPath);
    await journal.append({
      type: run.attempt > 1 ? "run.resumed" : "run.started",
      at: new Date().toISOString(),
      runId: run.runId,
      attempt: run.attempt,
      sourceHash: run.sourceHash,
    });

    try {
      const result = await this.#runWorker({ run, source, execution, journal, cache });
      run.status = "completed";
      run.result = jsonClone(result, "workflow result");
      await journal.append({
        type: "run.completed",
        at: new Date().toISOString(),
        runId: run.runId,
        result: run.result,
      });
    } catch (error) {
      const stopped = execution.abortController.signal.aborted;
      const interrupted = stopped && execution.stopKind === "interrupted";
      run.status = interrupted ? "interrupted" : stopped ? "cancelled" : "failed";
      run.error = serializeError(
        stopped
          ? execution.abortController.signal.reason ?? new Error("Workflow cancelled.")
          : error,
      );
      await journal.append({
        type: interrupted ? "run.interrupted" : stopped ? "run.cancelled" : "run.failed",
        at: new Date().toISOString(),
        runId: run.runId,
        error: run.error,
      });
    } finally {
      run.completedAt = new Date().toISOString();
      run.updatedAt = run.completedAt;
      run.revision += 1;
      await journal.flush();
      await this.#persistRun(run);
      await rm(path.join(path.dirname(run.runPath), CANCEL_FILE_NAME), { force: true });
      this.#notify(run.runId);
    }
    return run;
  }

  #runWorker({ run, source, execution, journal, cache }) {
    const worker = fork(WORKER_PATH, [], {
      execArgv: ["--permission", `--allow-fs-read=${SOURCE_DIRECTORY}`],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { NODE_NO_WARNINGS: "1" },
    });
    execution.worker = worker;
    let settled = false;
    let stderr = "";
    worker.stderr.setEncoding("utf8");
    worker.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });

    const completion = new Promise((resolve, reject) => {
      const fail = (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      worker.on("message", (message) => {
        if (message?.type === "meta") {
          run.meta = message.meta;
          run.name = message.meta.name;
          run.description = message.meta.description;
          void journal
            .append({ type: "meta", at: new Date().toISOString(), meta: message.meta })
            .then(() => this.#touch(run))
            .catch(fail);
        } else if (message?.type === "phase") {
          run.phase = message.name;
          void journal
            .append({ type: "phase", at: new Date().toISOString(), name: message.name })
            .then(() => this.#touch(run))
            .catch(fail);
        } else if (message?.type === "log") {
          void journal
            .append({ type: "log", at: new Date().toISOString(), value: message.value })
            .catch(fail);
        } else if (message?.type === "agent.request") {
          this.#handleAgentRequest({ run, worker, message, journal, cache, execution })
            .catch(fail);
        } else if (message?.type === "done" && !settled) {
          settled = true;
          resolve(message.result);
        } else if (message?.type === "failed" && !settled) {
          settled = true;
          const error = new Error(message.error?.message ?? "Workflow worker failed.");
          error.name = message.error?.name ?? "WorkflowError";
          if (message.error?.stack) error.stack = message.error.stack;
          reject(error);
        }
      });
      worker.on("error", (error) => {
        fail(error);
      });
      worker.on("exit", (code, signal) => {
        if (!settled) {
          settled = true;
          const detail = stderr.trim();
          reject(
            new Error(
              `Workflow worker exited (${signal ?? code ?? "unknown"}).${detail ? ` ${detail}` : ""}`,
            ),
          );
        }
      });
    });

    const abort = () => {
      if (!worker.killed) worker.kill("SIGTERM");
    };
    execution.abortController.signal.addEventListener("abort", abort, { once: true });
    worker.send({ type: "start", source, args: run.args });

    return completion.finally(() => {
      execution.abortController.signal.removeEventListener("abort", abort);
      if (!worker.killed) worker.kill("SIGTERM");
    });
  }

  #watchCancellation(run, execution) {
    const cancelPath = path.join(path.dirname(run.runPath), CANCEL_FILE_NAME);
    let checking = false;
    const check = async () => {
      if (checking || execution.abortController.signal.aborted) return;
      checking = true;
      try {
        const request = await readJson(cancelPath);
        if (request.runId === run.runId) {
          execution.stopKind = "cancelled";
          execution.abortController.abort(new Error("Workflow cancelled by user."));
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          execution.stopKind = "interrupted";
          execution.abortController.abort(
            new Error(`Workflow cancellation watcher failed: ${error.message}`),
          );
        }
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(check, 100);
    timer.unref?.();
    void check();
    return timer;
  }

  async #handleAgentRequest({ run, worker, message, journal, cache, execution }) {
    const respond = (payload) => {
      if (worker.connected) worker.send({ type: "agent.response", id: message.id, ...payload });
    };
    try {
      if (execution.abortController.signal.aborted) {
        throw execution.abortController.signal.reason ?? new Error("Workflow cancelled.");
      }
      if (run.stats.requested >= 1_000) throw new Error("Workflow agent limit (1000) exceeded.");

      const persona =
        message.options?.agentType !== undefined
          ? await this.#resolveAgentType(message.options.agentType, run.cwd)
          : null;
      const options = this.#normalizeAgentOptions(message.options, run.cwd, persona);
      const key = options.key ?? `${message.phase || "default"}:${message.sequence}`;
      const inputHash = hashValue({ prompt: message.prompt, options });
      run.stats.requested += 1;

      const cached = cache.get(key);
      if (cached?.inputHash === inputHash) {
        run.stats.cached += 1;
        if (cached.worktreeKept && cached.worktreePath) {
          const stillThere = await stat(cached.worktreePath).then(
            (info) => info.isDirectory(),
            () => false,
          );
          if (stillThere) run.worktrees.push({ key, path: cached.worktreePath });
        }
        await journal.append({
          type: "agent.cached",
          at: new Date().toISOString(),
          key,
          inputHash,
          sequence: message.sequence,
          threadId: cached.threadId,
          turnId: cached.turnId,
          worktreePath: cached.worktreePath,
          worktreeKept: cached.worktreeKept,
        });
        await this.#touch(run);
        respond({ ok: true, value: cached.result });
        return;
      }

      const worktree =
        options.isolation === "worktree" ? await this.#createWorktree(run, key) : null;
      const transcriptPath = path.join(
        path.dirname(run.runPath),
        "agents",
        `${safeFilename(key)}-${message.sequence}.jsonl`,
      );
      const transcript = new JsonlWriter(transcriptPath);
      run.stats.running += 1;
      await journal.append({
        type: "agent.started",
        at: new Date().toISOString(),
        key,
        label: options.label,
        phase: message.phase,
        sequence: message.sequence,
        inputHash,
        transcriptPath,
        options,
        worktreePath: worktree?.path,
      });
      await this.#touch(run);

      const timed = timeoutSignal(
        execution.abortController.signal,
        options.timeoutMs,
        `Agent ${key}`,
      );
      try {
        const response = await this.semaphore.run(
          () =>
            this.backend.runAgent({
              prompt: message.prompt,
              options: worktree ? { ...options, cwd: worktree.path } : options,
              instructions: persona?.instructions,
              signal: timed.signal,
              onEvent: (event) => transcript.append({ at: new Date().toISOString(), event }),
            }),
          timed.signal,
        );
        await transcript.flush();
        const worktreeState = worktree ? await this.#releaseWorktree(worktree) : null;
        if (worktreeState?.kept) run.worktrees.push({ key, path: worktreeState.path });
        run.stats.running -= 1;
        run.stats.completed += 1;
        const event = {
          type: "agent.completed",
          at: new Date().toISOString(),
          key,
          inputHash,
          sequence: message.sequence,
          result: jsonClone(response.result, "agent result"),
          threadId: response.threadId,
          turnId: response.turnId,
          usage: response.usage,
          transcriptPath,
          worktreePath: worktreeState?.path,
          worktreeKept: worktreeState?.kept,
        };
        cache.set(key, event);
        await journal.append(event);
        await this.#touch(run);
        respond({ ok: true, value: event.result });
      } catch (error) {
        await transcript.flush();
        const worktreeState = worktree ? await this.#releaseWorktree(worktree) : null;
        if (worktreeState?.kept) run.worktrees.push({ key, path: worktreeState.path });
        run.stats.running -= 1;
        run.stats.failed += 1;
        const failure = {
          type: "agent.failed",
          at: new Date().toISOString(),
          key,
          inputHash,
          sequence: message.sequence,
          error: serializeError(error),
          transcriptPath,
          worktreePath: worktreeState?.path,
          worktreeKept: worktreeState?.kept,
        };
        run.failures.push(failure);
        await journal.append(failure);
        await this.#touch(run);
        respond({ ok: false, error: failure.error });
      } finally {
        timed.clear();
      }
    } catch (error) {
      respond({ ok: false, error: serializeError(error) });
    }
  }

  async #resolveAgentType(agentType, runCwd) {
    if (typeof agentType !== "string" || !AGENT_TYPE_PATTERN.test(agentType)) {
      throw new Error(
        "agentType must be a simple name (letters, digits, dot, dash, underscore).",
      );
    }
    const candidates = [
      path.join(runCwd, ".codex", "agents", `${agentType}.md`),
      path.join(this.agentsDir, `${agentType}.md`),
    ];
    for (const candidate of candidates) {
      let text;
      try {
        text = await readFile(candidate, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
        throw error;
      }
      if (Buffer.byteLength(text, "utf8") > MAX_PERSONA_BYTES) {
        throw new Error(`Agent type persona exceeds ${MAX_PERSONA_BYTES} bytes: ${candidate}`);
      }
      return parsePersona(text, candidate);
    }
    throw new Error(`Unknown agentType "${agentType}". Looked for: ${candidates.join(", ")}`);
  }

  #git(cwd, args, label) {
    return execFileAsync("git", ["-C", cwd, ...args]).then(
      ({ stdout }) => stdout,
      (error) => {
        throw new Error(`${label} failed: ${error.stderr?.trim() || error.message}`);
      },
    );
  }

  #withWorktreeLock(operation) {
    const result = this.#worktreeMutex.then(operation);
    this.#worktreeMutex = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #createWorktree(run, key) {
    return this.#withWorktreeLock(async () => {
      const repoRoot = (
        await this.#git(
          run.cwd,
          ["rev-parse", "--show-toplevel"],
          'agent isolation "worktree" requires the run cwd to be inside a git repository; git rev-parse',
        )
      ).trim();
      const worktreePath = path.join(
        path.dirname(run.runPath),
        "worktrees",
        `${safeFilename(key)}-${hashText(key).slice(0, 8)}`,
      );
      await ensureDir(path.dirname(worktreePath));
      const exists = await stat(worktreePath).then(
        (info) => info.isDirectory(),
        () => false,
      );
      if (exists) {
        // A previous interrupted attempt left an unharvested worktree; rerun from scratch.
        await execFileAsync("git", [
          "-C",
          repoRoot,
          "worktree",
          "remove",
          "--force",
          worktreePath,
        ]).catch(() => {});
        await rm(worktreePath, { recursive: true, force: true });
        await execFileAsync("git", ["-C", repoRoot, "worktree", "prune"]).catch(() => {});
      }
      await this.#git(
        repoRoot,
        ["worktree", "add", "--detach", worktreePath, "HEAD"],
        "git worktree add",
      );
      return { path: worktreePath, repoRoot };
    });
  }

  #releaseWorktree(worktree) {
    return this.#withWorktreeLock(async () => {
      const status = await this.#git(worktree.path, ["status", "--porcelain"], "git status").catch(
        () => null,
      );
      if (status !== null && status.trim() === "") {
        await execFileAsync("git", [
          "-C",
          worktree.repoRoot,
          "worktree",
          "remove",
          "--force",
          worktree.path,
        ]).catch(() => {});
        return { path: worktree.path, kept: false };
      }
      return { path: worktree.path, kept: true };
    });
  }

  #normalizeAgentOptions(input, runCwd, persona) {
    const personaDefaults = persona?.defaults ?? {};
    const options = {
      key: input.key,
      label: input.label ?? input.key ?? "agent",
      model:
        input.model ??
        personaDefaults.model ??
        process.env.CODEX_WORKFLOW_DEFAULT_MODEL ??
        "gpt-5.6-sol",
      effort: input.effort ?? personaDefaults.effort ?? "high",
      sandbox: input.sandbox ?? personaDefaults.sandbox ?? "read-only",
      schema: input.schema,
      cwd: input.cwd ?? runCwd,
      timeoutMs: input.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    };
    if (input.agentType !== undefined) {
      options.agentType = input.agentType;
      options.instructionsHash = hashText(persona.instructions);
    }
    if (input.isolation !== undefined) {
      if (input.isolation !== "worktree") {
        throw new Error(`Unsupported agent isolation: ${input.isolation}`);
      }
      options.isolation = "worktree";
    }
    if (options.key !== undefined && (typeof options.key !== "string" || !options.key.trim())) {
      throw new Error("agent key must be a non-empty string.");
    }
    if (typeof options.label !== "string" || !options.label.trim()) {
      throw new Error("agent label must be a non-empty string.");
    }
    if (typeof options.model !== "string" || !options.model.trim()) {
      throw new Error("agent model must be a non-empty string.");
    }
    if (typeof options.effort !== "string" || !options.effort.trim()) {
      throw new Error("agent effort must be a non-empty string.");
    }
    if (!new Set(["read-only", "workspace-write", "danger-full-access"]).has(options.sandbox)) {
      throw new Error(`Unsupported agent sandbox: ${options.sandbox}`);
    }
    if (!path.isAbsolute(options.cwd)) throw new Error("agent cwd must be absolute.");
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
      throw new Error("agent timeoutMs must be an integer of at least 1000.");
    }
    return jsonClone(options, "agent options");
  }

  async #touch(run) {
    run.updatedAt = new Date().toISOString();
    run.revision += 1;
    await this.#persistRun(run);
    this.#notify(run.runId);
  }

  async #persistRun(run) {
    const snapshot = jsonClone(run, "run state");
    const previous = this.#writeQueues.get(run.runId) ?? Promise.resolve();
    const write = previous.then(() => atomicWriteJson(run.runPath, snapshot));
    this.#writeQueues.set(run.runId, write);
    try {
      await write;
    } finally {
      if (this.#writeQueues.get(run.runId) === write) this.#writeQueues.delete(run.runId);
    }
  }

  async status(runId) {
    await this.initialize();
    validateRunId(runId);
    const runPath = path.join(this.runsDirectory, runId, "run.json");
    const run = await readJson(runPath);
    if (run.status === "running" && !isProcessAlive(run.ownerPid)) {
      await atomicWriteJson(runPath, markInterrupted(run));
    }
    return run;
  }

  async wait(runId, timeoutMs = 55_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 55_000) {
      throw new Error("timeoutMs must be an integer between 0 and 55000.");
    }
    const current = await this.status(runId);
    if (TERMINAL_STATUSES.has(current.status) || timeoutMs === 0) return current;
    const startingRevision = current.revision;
    await new Promise((resolve) => {
      let checking = false;
      const waiter = async () => {
        if (checking) return;
        checking = true;
        try {
          const next = await this.status(runId);
          if (next.revision > startingRevision || TERMINAL_STATUSES.has(next.status)) {
            cleanup();
            resolve();
          }
        } catch {
          cleanup();
          resolve();
        } finally {
          checking = false;
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(poller);
        this.#waiters.get(runId)?.delete(waiter);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);
      const poller = setInterval(waiter, Math.min(250, Math.max(timeoutMs, 1)));
      poller.unref?.();
      this.#waiters.set(runId, this.#waiters.get(runId) ?? new Set());
      this.#waiters.get(runId).add(waiter);
      void waiter();
    });
    return this.status(runId);
  }

  async cancel(runId) {
    validateRunId(runId);
    const execution = this.#active.get(runId);
    if (!execution) {
      let run = await this.status(runId);
      if (TERMINAL_STATUSES.has(run.status)) return run;
      await atomicWriteJson(path.join(path.dirname(run.runPath), CANCEL_FILE_NAME), {
        runId,
        requestedAt: new Date().toISOString(),
        requestedByPid: process.pid,
      });
      const deadline = Date.now() + 10_000;
      while (!TERMINAL_STATUSES.has(run.status) && Date.now() < deadline) {
        const remaining = deadline - Date.now();
        run = await this.wait(runId, Math.min(1_000, Math.max(remaining, 0)));
      }
      return run;
    }
    execution.stopKind = "cancelled";
    execution.abortController.abort(new Error("Workflow cancelled by user."));
    return execution.promise;
  }

  #notify(runId) {
    for (const waiter of this.#waiters.get(runId) ?? []) waiter();
  }

  async close() {
    const executions = [...this.#active.values()];
    for (const execution of executions) {
      execution.stopKind = "interrupted";
      execution.abortController.abort(new Error("Workflow host is shutting down."));
    }
    await Promise.allSettled(executions.map(({ promise }) => promise));
    await this.backend.close?.();
  }
}
