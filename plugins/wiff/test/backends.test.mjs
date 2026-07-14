import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeBackend } from "../src/backends/claude.mjs";
import { BackendRouter, inferProvider } from "../src/backends/index.mjs";

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

function options(cwd, overrides = {}) {
  return { model: "claude-sonnet-5", effort: "high", sandbox: "read-only", cwd, ...overrides };
}

test("inferProvider maps model prefixes", () => {
  assert.equal(inferProvider("gpt-5.6-sol"), "codex");
  assert.equal(inferProvider("o3-mini"), "codex");
  assert.equal(inferProvider("codex-mini"), "codex");
  assert.equal(inferProvider("claude-opus-4-8"), "claude");
  assert.equal(inferProvider("opus"), "claude");
  assert.equal(inferProvider("fable"), "claude");
  assert.equal(inferProvider("gemini-2.5-pro"), "gemini");
  assert.equal(inferProvider("mystery-model"), null);
  assert.equal(inferProvider(undefined), null);
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
    factories: { codex: fake("codex"), claude: fake("claude") },
  });

  assert.equal((await router.runAgent({ options: { model: "gpt-5.6-sol" } })).result, "codex-result");
  assert.equal((await router.runAgent({ options: { model: "claude-opus-4-8" } })).result, "claude-result");
  assert.equal(
    (await router.runAgent({ options: { model: "gpt-5.6-sol", provider: "claude" } })).result,
    "claude-result",
  );
  assert.equal((await router.runAgent({ options: { model: "mystery-model" } })).result, "codex-result");
  assert.equal(created.length, 2, "backends are lazily created once per provider");

  await assert.rejects(
    router.runAgent({ options: { model: "gemini-2.5-pro" } }),
    /No backend registered for provider "gemini"/,
  );

  await router.close();
  assert.ok(created.every((backend) => backend.closed));
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

test("claude backend lists its stable model aliases", async () => {
  const models = await new ClaudeBackend().listModels();
  assert.deepEqual(models.map((model) => model.id), ["fable", "opus", "sonnet", "haiku"]);
  assert.ok(models.every((model) => model.efforts.includes("xhigh")));
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
    while (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error("stop now"));
    await assert.rejects(pending, /stop now/);
  });
});
