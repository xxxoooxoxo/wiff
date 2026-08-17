import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeBackend } from "../src/backends/claude.mjs";
import {
  buildCodexAppServerArgs,
  CodexBackend,
  codexModelSelection,
  parseCodexMcpServerNames,
  parseGoalDirective,
} from "../src/backends/codex.mjs";
import { BackendRouter, inferProvider } from "../src/backends/index.mjs";

// Bounded so a condition that never becomes true fails fast and by name,
// instead of spinning silently until the CI job timeout kills the run.
async function waitFor(description, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}


const STUB_SOURCE = `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8");
  const args = process.argv.slice(2);
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  if (process.env.WIFF_STUB_ARGS_FILE) {
    require("node:fs").writeFileSync(process.env.WIFF_STUB_ARGS_FILE, JSON.stringify(args));
  }
  if (prompt === "FAIL") {
    process.stderr.write("stub exploded");
    process.exit(1);
  }
  emit({ type: "system", subtype: "init", session_id: "sess-1" });
  if (prompt === "HANG") {
    setTimeout(() => process.exit(0), 60_000);
    return;
  }
  if (prompt === "ERROR-RESULT") {
    emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "it broke", session_id: "sess-1", uuid: "turn-1" });
    process.exit(0);
  }
  emit({
    type: "assistant",
    message: { content: [
      { type: "thinking", thinking: "pondering" },
      { type: "tool_use", name: "Bash", input: { command: "echo hi" } },
      { type: "tool_use", name: "Edit", input: { file_path: "/tmp/x.txt" } },
      { type: "text", text: "ok:" + prompt },
    ] },
  });
  const result = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok:" + prompt,
    session_id: "sess-1",
    uuid: "turn-1",
    total_cost_usd: 0.01,
    usage: { input_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 20, output_tokens: 7 },
  };
  const schemaIndex = args.indexOf("--json-schema");
  if (schemaIndex !== -1) result.structured_output = { echo: prompt, schema: JSON.parse(args[schemaIndex + 1]) };
  emit(result);
  process.exit(0);
});
`;

const CODEX_STUB_SOURCE = `#!/usr/bin/env node
const readline = require("node:readline");
let goal = null;
let turnCount = 0;
const inputs = [];
let lastTurnParams = null;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/start") {
    require("node:fs").writeFileSync(
      require("node:path").join(require("node:path").dirname(process.argv[1]), "thread.json"),
      JSON.stringify(message.params),
    );
    send({ id: message.id, result: { thread: { id: "thread-goal" } } });
    return;
  }
  if (message.method === "thread/goal/set") {
    goal = {
      threadId: message.params.threadId,
      objective: message.params.objective,
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    send({ id: message.id, result: { goal } });
    send({ method: "thread/goal/updated", params: { threadId: goal.threadId, turnId: null, goal } });
    return;
  }
  if (message.method === "thread/goal/get") {
    send({ id: message.id, result: { goal } });
    return;
  }
  if (message.method === "turn/start") {
    turnCount += 1;
    inputs.push(message.params.input[0].text);
    lastTurnParams = message.params;
    require("node:fs").writeFileSync(
      require("node:path").join(require("node:path").dirname(process.argv[1]), "turn.json"),
      JSON.stringify(lastTurnParams),
    );
    const turnId = "turn-" + turnCount;
    send({ id: message.id, result: { turn: { id: turnId } } });
    setImmediate(() => {
      if (goal) {
        goal = {
          ...goal,
          status:
            goal.objective.includes("block")
              ? "blocked"
              : turnCount >= 2
                ? "complete"
                : "active",
          tokensUsed: turnCount * 10,
          updatedAt: turnCount + 1,
        };
        send({
          method: "thread/goal/updated",
          params: { threadId: goal.threadId, turnId, goal },
        });
      }
      send({
        method: "item/completed",
        params: {
          threadId: "thread-goal",
          turnId,
          item: { type: "agentMessage", text: inputs.join(" -> ") },
        },
      });
      send({
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread-goal", tokenUsage: { total: { totalTokens: turnCount * 10 } } },
      });
      send({
        method: "turn/completed",
        params: { threadId: "thread-goal", turn: { id: turnId, status: "completed" } },
      });
    });
  }
});
`;

async function withStub(runTest) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiff-claude-stub-"));
  const command = path.join(dir, "claude-stub");
  const argsFile = path.join(dir, "args.json");
  await writeFile(command, STUB_SOURCE, "utf8");
  await chmod(command, 0o755);
  const previous = process.env.WIFF_STUB_ARGS_FILE;
  process.env.WIFF_STUB_ARGS_FILE = argsFile;
  try {
    await runTest({
      backend: new ClaudeBackend({ command }),
      cwd: dir,
      stubArgs: async () => JSON.parse(await readFile(argsFile, "utf8")),
    });
  } finally {
    if (previous === undefined) delete process.env.WIFF_STUB_ARGS_FILE;
    else process.env.WIFF_STUB_ARGS_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

async function withCodexStub(runTest) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiff-codex-stub-"));
  const command = path.join(dir, "codex-stub");
  await writeFile(command, CODEX_STUB_SOURCE, "utf8");
  await chmod(command, 0o755);
  const backend = new CodexBackend({ command, mcpServerNames: [], requestTimeoutMs: 1_000 });
  try {
    await runTest({ backend, cwd: dir });
  } finally {
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function options(cwd, overrides = {}) {
  return { model: "claude-sonnet-5", effort: "high", sandbox: "read-only", cwd, ...overrides };
}

function codexOptions(cwd, overrides = {}) {
  return { model: "gpt-5.6-sol", effort: "low", sandbox: "read-only", cwd, ...overrides };
}

test("inferProvider maps model prefixes", () => {
  assert.equal(inferProvider("gpt-5.6-sol"), "codex");
  assert.equal(inferProvider("o3-mini"), "codex");
  assert.equal(inferProvider("codex-mini"), "codex");
  assert.equal(inferProvider("claude-opus-4-8"), "claude");
  assert.equal(inferProvider("opus"), "claude");
  assert.equal(inferProvider("fable"), "claude");
  assert.equal(inferProvider("kimi-code/k3"), "kimi");
  assert.equal(inferProvider("KIMI-CODE/kimi-for-coding"), "kimi");
  assert.equal(inferProvider("grok-4.6"), "cursor");
  assert.equal(inferProvider("cursor-grok-4.6"), "cursor");
  assert.equal(inferProvider("gemini-2.5-pro"), "gemini");
  assert.equal(inferProvider("mystery-model"), null);
  assert.equal(inferProvider(undefined), null);
});

test("codexModelSelection maps effort and fast suffixes", () => {
  assert.deepEqual(codexModelSelection("gpt-5.6-sol", "medium"), {
    model: "gpt-5.6-sol",
    effort: "medium",
    serviceTier: undefined,
  });
  assert.deepEqual(codexModelSelection("gpt-5.6-sol-fast", "low"), {
    model: "gpt-5.6-sol",
    effort: "low",
    serviceTier: "priority",
  });
  assert.deepEqual(codexModelSelection("gpt-5.6-sol-xhigh-fast", "low"), {
    model: "gpt-5.6-sol",
    effort: "xhigh",
    serviceTier: "priority",
  });
  assert.deepEqual(codexModelSelection("o3-mini", "high"), {
    model: "o3-mini",
    effort: "high",
    serviceTier: undefined,
  });
});

test("parses /goal agent directives and rejects an empty objective", () => {
  assert.equal(parseGoalDirective("/goal make the tests pass"), "make the tests pass");
  assert.equal(parseGoalDirective("  /goal\n  make the tests pass\n"), "make the tests pass");
  assert.equal(parseGoalDirective("ordinary prompt"), null);
  assert.equal(parseGoalDirective("/goalkeeper is not a command"), null);
  assert.throws(() => parseGoalDirective("/goal   "), /non-empty objective/);
});

test("Codex app-server startup disables every configured MCP server", () => {
  const names = parseCodexMcpServerNames(
    JSON.stringify([
      { name: "postgres", enabled: true },
      { name: "browser-tools", enabled: true },
      { name: "postgres", enabled: true },
    ]),
  );
  assert.deepEqual(names, ["postgres", "browser-tools"]);

  const args = buildCodexAppServerArgs(names);
  assert.deepEqual(
    args.filter((value, index) => args[index - 1] === "--disable"),
    ["multi_agent", "plugins", "apps"],
  );
  const overrides = args
    .map((value, index) => value === "-c" ? args[index + 1] : null)
    .filter(Boolean);
  assert.deepEqual(overrides, [
    "mcp_servers.codex.enabled=false",
    "mcp_servers.postgres.enabled=false",
    "mcp_servers.browser-tools.enabled=false",
  ]);
  assert.throws(
    () => buildCodexAppServerArgs(["unsafe=name"]),
    /Cannot safely disable Codex MCP server/,
  );
});

test("Codex MCP listing rejects malformed output", () => {
  assert.throws(() => parseCodexMcpServerNames("{}"), /was not an array/);
  assert.throws(() => parseCodexMcpServerNames("not json"), /Unexpected token|JSON/);
});

test("Codex backend retries MCP discovery after a transient failure", async () => {
  let discoveries = 0;
  const backend = new CodexBackend({
    command: process.execPath,
    requestTimeoutMs: 1_000,
    mcpServerDiscovery: async () => {
      discoveries += 1;
      if (discoveries === 1) throw new Error("transient discovery failure");
      return [];
    },
  });
  await assert.rejects(backend.start(), /transient discovery failure/);
  await assert.rejects(backend.start(), /app-server exited|stdin is not writable|timed out/);
  assert.equal(discoveries, 2);
  await backend.close();
});

test("Codex /goal stages continue on one thread until the goal completes", async () => {
  await withCodexStub(async ({ backend, cwd }) => {
    const events = [];
    const response = await backend.runAgent({
      prompt: "/goal make the tests pass",
      options: codexOptions(cwd),
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });

    assert.equal(
      response.result,
      "make the tests pass -> Continue working toward the active goal. Inspect the current state and take the next useful actions. Only mark the goal complete when its objective is genuinely satisfied.",
    );
    assert.equal(response.threadId, "thread-goal");
    assert.equal(response.turnId, "turn-2");
    assert.equal(response.usage.total.totalTokens, 20);
    assert.equal(
      events.filter((event) => event.method === "thread/goal/updated").at(-1).params.goal.status,
      "complete",
    );
  });
});

test("Codex /goal stages fail when the goal becomes blocked", async () => {
  await withCodexStub(async ({ backend, cwd }) => {
    await assert.rejects(
      backend.runAgent({
        prompt: "/goal block on missing credentials",
        options: codexOptions(cwd),
        signal: new AbortController().signal,
      }),
      /stopped before completion with status "blocked"/,
    );
  });
});

test("Codex backend sends Fast mode as the priority service tier", async () => {
  await withCodexStub(async ({ backend, cwd }) => {
    await backend.runAgent({
      prompt: "review",
      options: codexOptions(cwd, { model: "gpt-5.6-sol-xhigh-fast", effort: "low" }),
      signal: new AbortController().signal,
    });
    const thread = JSON.parse(await readFile(path.join(cwd, "thread.json"), "utf8"));
    const turn = JSON.parse(await readFile(path.join(cwd, "turn.json"), "utf8"));
    assert.equal(thread.model, "gpt-5.6-sol");
    assert.equal(turn.model, "gpt-5.6-sol");
    assert.equal(turn.effort, "xhigh");
    assert.equal(turn.serviceTier, "priority");
  });
});

test("router picks backends by provider, model prefix, then default", async () => {
  const created = [];
  const fake = (name) => () => {
    const backend = {
      name,
      calls: [],
      closed: false,
      async runAgent(request) {
        this.calls.push(request);
        return { result: `${name}-result` };
      },
      async close() {
        this.closed = true;
      },
    };
    created.push(backend);
    return backend;
  };
  const router = new BackendRouter({
    defaultProvider: "codex",
    factories: { codex: fake("codex"), claude: fake("claude"), cursor: fake("cursor"), kimi: fake("kimi") },
  });

  assert.equal((await router.runAgent({ options: { model: "gpt-5.6-sol" } })).result, "codex-result");
  assert.equal((await router.runAgent({ options: { model: "claude-opus-4-8" } })).result, "claude-result");
  assert.equal((await router.runAgent({ options: { model: "kimi-code/k3" } })).result, "kimi-result");
  assert.equal((await router.runAgent({ options: { model: "grok-4.6" } })).result, "cursor-result");
  assert.equal(
    (await router.runAgent({ options: { model: "gpt-5.6-sol", provider: "claude" } })).result,
    "claude-result",
  );
  assert.equal((await router.runAgent({ options: { model: "mystery-model" } })).result, "codex-result");
  assert.equal(created.length, 4, "backends are lazily created once per provider");

  await assert.rejects(
    router.runAgent({ options: { model: "gemini-2.5-pro" } }),
    /No backend registered for provider "gemini"/,
  );
  await assert.rejects(
    router.runAgent({
      prompt: "/goal finish the task",
      options: { model: "claude-opus-4-8" },
    }),
    /require the Codex backend/,
  );

  await router.close();
  assert.ok(created.every((backend) => backend.closed));
});

test("router follows ordered fallback models and records the transition", async () => {
  const attempts = [];
  const events = [];
  const router = new BackendRouter({
    defaultProvider: "codex",
    factories: {
      claude: () => ({
        async runAgent(request) {
          attempts.push(request.options.model);
          throw new Error("Claude unavailable");
        },
      }),
      codex: () => ({
        async runAgent(request) {
          attempts.push(request.options.model);
          return { result: "fallback-result" };
        },
      }),
    },
  });

  const response = await router.runAgent({
    prompt: "do the work",
    options: {
      model: "claude-opus-5",
      fallbackModels: ["gpt-5.6-sol"],
    },
    onEvent: (event) => events.push(event),
  });

  assert.equal(response.result, "fallback-result");
  assert.deepEqual(attempts, ["claude-opus-5", "gpt-5.6-sol"]);
  assert.equal(events[0].method, "workflow/agentFallback");
  assert.equal(events[0].params.nextModel, "gpt-5.6-sol");
  await router.close();
});

test("a Codex fallback can satisfy /goal when the primary backend cannot", async () => {
  let codexRequest;
  const router = new BackendRouter({
    defaultProvider: "codex",
    factories: {
      claude: () => ({
        async runAgent() {
          throw new Error("Claude should not receive a native goal");
        },
      }),
      codex: () => ({
        async runAgent(request) {
          codexRequest = request;
          return { result: "goal-fallback-result" };
        },
      }),
    },
  });

  const response = await router.runAgent({
    prompt: "/goal finish safely",
    options: {
      model: "claude-opus-5",
      fallbackModels: ["gpt-5.6-sol"],
    },
  });

  assert.equal(response.result, "goal-fallback-result");
  assert.equal(codexRequest.options.model, "gpt-5.6-sol");
  assert.equal(codexRequest.goalObjective, "finish safely");
  await router.close();
});

test("router aggregates model listings and captures per-provider failures", async () => {
  const router = new BackendRouter({
    defaultProvider: "codex",
    factories: {
      codex: () => ({
        async listModels() {
          return [{ id: "gpt-5.6-sol", efforts: ["low", "high"], isDefault: true }];
        },
      }),
      claude: () => ({
        async listModels() {
          throw new Error("claude CLI not found");
        },
      }),
      bare: () => ({}),
    },
  });
  const backends = await router.listModels();
  assert.equal(backends.codex.models[0].id, "gpt-5.6-sol");
  assert.equal(backends.claude.error, "claude CLI not found");
  assert.deepEqual(backends.bare.models, []);
});

test("claude backend lists current model ids and moving family aliases", async () => {
  const models = await new ClaudeBackend().listModels();
  assert.deepEqual(models.map((model) => model.id), [
    "claude-fable-5",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "fable",
    "opus",
    "sonnet",
    "haiku",
  ]);
  assert.ok(models.every((model) => model.efforts.includes("xhigh")));
  assert.match(models.find((model) => model.id === "claude-opus-5").description, /agentic coding/);
  assert.match(models.find((model) => model.id === "opus").note, /Moving family alias/);
});

test("router rejects an unknown default provider", () => {
  assert.throws(() => new BackendRouter({ defaultProvider: "copilot" }), /Unknown workflow backend/);
});

test("claude backend runs an agent and normalizes the result", async () => {
  await withStub(async ({ backend, cwd, stubArgs }) => {
    const events = [];
    const response = await backend.runAgent({
      prompt: "do the thing",
      options: options(cwd),
      instructions: "You are a careful reviewer.",
      onEvent: (event) => events.push(event),
    });
    assert.equal(response.result, "ok:do the thing");
    assert.equal(response.threadId, "sess-1");
    assert.equal(response.turnId, "turn-1");
    assert.deepEqual(response.usage.total, {
      totalTokens: 42,
      inputTokens: 25,
      cachedInputTokens: 10,
      outputTokens: 7,
    });

    const methods = events.map((event) => event.method);
    assert.deepEqual(methods[0], "workflow/agentThreadStarted");
    const items = events
      .filter((event) => event.method === "item/completed")
      .map((event) => event.params.item);
    assert.deepEqual(items.map((item) => item.type), [
      "reasoning",
      "commandExecution",
      "fileChange",
      "agentMessage",
    ]);

    const args = await stubArgs();
    assert.ok(args.includes("--no-session-persistence"));
    assert.ok(args.includes("--strict-mcp-config"));
    assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-5");
    assert.equal(args[args.indexOf("--effort") + 1], "high");
    assert.equal(args[args.indexOf("--append-system-prompt") + 1], "You are a careful reviewer.");
    assert.equal(args[args.indexOf("--tools") + 1], "Read,Glob,Grep");
  });
});

test("claude backend returns native structured output for schema agents", async () => {
  await withStub(async ({ backend, cwd, stubArgs }) => {
    const schema = { type: "object", properties: { echo: { type: "string" } } };
    const response = await backend.runAgent({
      prompt: "structured please",
      options: options(cwd, { schema }),
    });
    assert.equal(response.result.echo, "structured please");
    assert.deepEqual(response.result.schema, schema);
    const args = await stubArgs();
    assert.equal(JSON.parse(args[args.indexOf("--json-schema") + 1]).type, "object");
  });
});

test("claude backend maps sandbox levels to permission flags", async () => {
  await withStub(async ({ backend, cwd, stubArgs }) => {
    await assert.rejects(
      backend.runAgent({ prompt: "write", options: options(cwd, { sandbox: "workspace-write" }) }),
      /requires isolation: "worktree"/,
    );

    await backend.runAgent({
      prompt: "write",
      options: options(cwd, { sandbox: "workspace-write", isolation: "worktree" }),
    });
    let args = await stubArgs();
    assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.equal(args[args.indexOf("--allowedTools") + 1], "Bash");

    await backend.runAgent({
      prompt: "anything",
      options: options(cwd, { sandbox: "danger-full-access" }),
    });
    args = await stubArgs();
    assert.ok(args.includes("--dangerously-skip-permissions"));

    await backend.runAgent({
      prompt: "look",
      options: options(cwd, { effort: "minimal" }),
    });
    args = await stubArgs();
    assert.equal(args[args.indexOf("--effort") + 1], "low");
  });
});

test("claude backend surfaces process and turn failures", async () => {
  await withStub(async ({ backend, cwd }) => {
    await assert.rejects(
      backend.runAgent({ prompt: "FAIL", options: options(cwd) }),
      /Claude agent did not complete: stub exploded/,
    );
    await assert.rejects(
      backend.runAgent({ prompt: "ERROR-RESULT", options: options(cwd) }),
      /Claude agent did not complete: it broke/,
    );
  });
});

test("claude backend aborts by killing the child", async () => {
  await withStub(async ({ backend, cwd }) => {
    const controller = new AbortController();
    const events = [];
    const pending = backend.runAgent({
      prompt: "HANG",
      options: options(cwd),
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });
    await waitFor("the backend to emit its first event", () => events.length > 0);
    controller.abort(new Error("stop now"));
    await assert.rejects(pending, /stop now/);
  });
});
