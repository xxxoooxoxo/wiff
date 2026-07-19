import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KimiBackend } from "../src/backends/kimi.mjs";

const STUB_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.WIFF_KIMI_STUB_ARGS_FILE) {
  fs.writeFileSync(
    process.env.WIFF_KIMI_STUB_ARGS_FILE,
    JSON.stringify({ args, cwd: process.cwd() }),
  );
}
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
if (args[0] === "provider") {
  process.stdout.write(JSON.stringify({
    providers: { "managed:kimi-code": {} },
    ...(process.env.WIFF_KIMI_STUB_DEFAULT_MODEL
      ? { defaultModel: process.env.WIFF_KIMI_STUB_DEFAULT_MODEL }
      : {}),
    models: {
      "kimi-code/k3": {
        provider: "managed:kimi-code",
        model: "k3",
        maxContextSize: 1048576,
        displayName: "K3",
        supportEfforts: ["low", "high", "max"],
        defaultEffort: "max",
      },
      "kimi-code/kimi-for-coding": {
        provider: "managed:kimi-code",
        model: "kimi-for-coding",
        maxContextSize: 262144,
        displayName: "K2.7 Coding",
      },
    },
  }));
  process.exit(0);
}
const prompt = args[args.indexOf("-p") + 1];
if (prompt.includes("FAIL")) {
  process.stderr.write("\\u001b[31mconfig.invalid: Model \\"k3\\" is not configured\\u001b[0m");
  process.exit(1);
}
emit({
  role: "assistant",
  content: "Starting now.",
  tool_calls: [
    { type: "function", id: "tool-1", function: { name: "Bash", arguments: "{\\"command\\":\\"echo hi\\"}" } },
    { type: "function", id: "tool-2", function: { name: "Write", arguments: "{\\"path\\":\\"result.txt\\",\\"content\\":\\"hi\\"}" } },
  ],
});
emit({ role: "tool", tool_call_id: "tool-1", content: "hi" });
emit({
  role: "assistant",
  content: prompt.includes("SCHEMA")
    ? String.fromCharCode(96).repeat(3) + "json\\n{\\"verdict\\":\\"ship it\\"}\\n" + String.fromCharCode(96).repeat(3)
    : "done",
});
emit({
  role: "meta",
  type: "session.resume_hint",
  session_id: "session-kimi-1",
  command: "kimi -r session-kimi-1",
});
`;

async function withStub(runTest, { defaultModel } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiff-kimi-stub-"));
  const command = path.join(dir, "kimi-stub");
  const argsFile = path.join(dir, "args.json");
  await writeFile(command, STUB_SOURCE, "utf8");
  await chmod(command, 0o755);
  const previous = process.env.WIFF_KIMI_STUB_ARGS_FILE;
  const previousDefaultModel = process.env.WIFF_KIMI_STUB_DEFAULT_MODEL;
  process.env.WIFF_KIMI_STUB_ARGS_FILE = argsFile;
  if (defaultModel === undefined) delete process.env.WIFF_KIMI_STUB_DEFAULT_MODEL;
  else process.env.WIFF_KIMI_STUB_DEFAULT_MODEL = defaultModel;
  try {
    await runTest({
      backend: new KimiBackend({ command }),
      cwd: dir,
      stubInvocation: async () => JSON.parse(await readFile(argsFile, "utf8")),
    });
  } finally {
    if (previous === undefined) delete process.env.WIFF_KIMI_STUB_ARGS_FILE;
    else process.env.WIFF_KIMI_STUB_ARGS_FILE = previous;
    if (previousDefaultModel === undefined) delete process.env.WIFF_KIMI_STUB_DEFAULT_MODEL;
    else process.env.WIFF_KIMI_STUB_DEFAULT_MODEL = previousDefaultModel;
    await rm(dir, { recursive: true, force: true });
  }
}

function options(cwd, overrides = {}) {
  return {
    model: "kimi-code/k3",
    effort: "high",
    sandbox: "read-only",
    cwd,
    ...overrides,
  };
}

test("kimi backend runs an agent, maps tool calls, and uses the trailing session id", async () => {
  await withStub(async ({ backend, cwd, stubInvocation }) => {
    const events = [];
    const response = await backend.runAgent({
      prompt: "do the thing",
      options: options(cwd),
      instructions: "Be careful.",
      onEvent: (event) => events.push(event),
    });

    assert.equal(response.result, "done");
    assert.equal(response.threadId, "session-kimi-1");
    assert.equal(response.turnId, undefined);
    assert.equal(response.usage, undefined);
    assert.equal(
      events.filter((event) => event.method === "workflow/agentThreadStarted").length,
      1,
    );
    assert.deepEqual(
      events
        .filter((event) => event.method === "item/completed")
        .map((event) => event.params.item),
      [
        { type: "agentMessage", text: "Starting now." },
        { type: "commandExecution", command: "echo hi" },
        { type: "fileChange", changes: [{ path: "result.txt" }] },
        { type: "agentMessage", text: "done" },
      ],
    );
    assert.ok(
      events
        .filter((event) => event.method === "item/completed")
        .every((event) => event.params.threadId === "session-kimi-1"),
    );

    const { args, cwd: actualCwd } = await stubInvocation();
    assert.equal(args[0], "-p");
    assert.match(args[1], /^Constraint: you are a read-only agent\./);
    assert.match(args[1], /<developer_instructions>\nBe careful\.\n<\/developer_instructions>/);
    assert.match(args[1], /do the thing$/);
    assert.deepEqual(args.slice(2), ["--output-format", "stream-json", "-m", "kimi-code/k3"]);
    assert.equal(await realpath(actualCwd), await realpath(cwd));
  });
});

test("kimi backend parses fenced JSON schema responses", async () => {
  await withStub(async ({ backend, cwd, stubInvocation }) => {
    const schema = { type: "object", properties: { verdict: { type: "string" } } };
    const response = await backend.runAgent({
      prompt: "SCHEMA",
      options: options(cwd, { schema }),
    });
    assert.deepEqual(response.result, { verdict: "ship it" });
    const { args } = await stubInvocation();
    assert.match(args[1], /Reply with ONLY a JSON value matching this JSON Schema:/);
    assert.match(args[1], /"verdict"/);
    assert.ok(args[1].indexOf("SCHEMA") < args[1].indexOf("Reply with ONLY a JSON value"));
    assert.match(args[1], /Reply with ONLY a JSON value matching this JSON Schema: .*}$/);
  });
});

test("kimi backend requires worktree isolation for workspace writes", async () => {
  await withStub(async ({ backend, cwd }) => {
    await assert.rejects(
      backend.runAgent({ prompt: "write", options: options(cwd, { sandbox: "workspace-write" }) }),
      /requires isolation: "worktree"/,
    );
  });
});

test("kimi backend surfaces CLI stderr without ANSI escapes", async () => {
  await withStub(async ({ backend, cwd }) => {
    await assert.rejects(
      backend.runAgent({ prompt: "FAIL", options: options(cwd) }),
      (error) => {
        assert.match(error.message, /Kimi agent did not complete: config\.invalid/);
        assert.doesNotMatch(error.message, /\u001b/);
        return true;
      },
    );
  });
});

test("kimi backend lists configured model aliases", async () => {
  await withStub(async ({ backend, stubInvocation }) => {
    const models = await backend.listModels();
    assert.deepEqual(models.map((model) => model.id), [
      "kimi-code/k3",
      "kimi-code/kimi-for-coding",
    ]);
    assert.equal(models[0].displayName, "K3");
    assert.deepEqual(models[0].efforts, ["low", "high", "max"]);
    assert.equal(models[0].defaultEffort, "max");
    assert.equal(models[0].isDefault, true);
    assert.equal(models[1].isDefault, undefined);
    assert.match(models[0].note, /no per-invocation effort flag/);
    assert.deepEqual((await stubInvocation()).args, ["provider", "list", "--json"]);
  });
});

test("kimi backend honors a default model marker when the catalog provides one", async () => {
  await withStub(
    async ({ backend }) => {
      const models = await backend.listModels();
      assert.equal(models[0].isDefault, true);
      assert.equal(models[1].isDefault, false);
    },
    { defaultModel: "kimi-code/k3" },
  );
});
