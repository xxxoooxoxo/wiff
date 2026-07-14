import assert from "node:assert/strict";
import test from "node:test";
import { CursorBackend } from "../src/backends/cursor.mjs";
import { inferProvider } from "../src/backends/index.mjs";

// In-memory stand-in for @cursor/sdk's Agent/Run surface.
function makeFakeSdk({ behavior = "success" } = {}) {
  const state = { creates: [], sends: [], cancelled: 0, disposed: 0 };

  class FakeRun {
    id = "run-1";
    status = "running";

    constructor(agent, message) {
      this.agent = agent;
      this.message = message;
    }

    async *stream() {
      yield { type: "thinking", text: "planning", agent_id: this.agent.agentId, run_id: this.id };
      yield {
        type: "tool_call",
        status: "completed",
        name: "run_terminal_cmd",
        args: { command: "ls -la" },
      };
      yield {
        type: "tool_call",
        status: "completed",
        name: "edit_file",
        args: { path: "src/x.mjs" },
      };
      yield {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      };
      yield {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, totalTokens: 20 },
      };
      if (behavior === "hang") {
        await new Promise((resolve) => {
          this.resolveHang = resolve;
        });
      }
      this.status = behavior === "error" ? "error" : "finished";
    }

    async wait() {
      if (behavior === "error") {
        return { id: this.id, status: "error", error: { message: "model exploded" } };
      }
      if (this.status === "cancelled") return { id: this.id, status: "cancelled" };
      const structuredTool = this.agent.options.local?.customTools?.structured_output;
      if (structuredTool && behavior !== "skip-structured") {
        await structuredTool.execute({ verdict: "ship it" });
      }
      return {
        id: this.id,
        status: "finished",
        result: behavior === "skip-structured" ? "not json {" : "done",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, totalTokens: 20 },
      };
    }

    async cancel() {
      state.cancelled += 1;
      this.status = "cancelled";
      this.resolveHang?.();
    }
  }

  class FakeAgent {
    static async create(options) {
      state.creates.push(options);
      return new FakeAgent(options);
    }

    constructor(options) {
      this.options = options;
      this.agentId = "agent-1";
    }

    async send(message) {
      state.sends.push(message);
      const run = new FakeRun(this, message);
      state.lastRun = run;
      return run;
    }

    async [Symbol.asyncDispose]() {
      state.disposed += 1;
    }
  }

  return { module: { Agent: FakeAgent }, state };
}

function options(overrides = {}) {
  return { model: "composer-2.5", effort: "high", sandbox: "read-only", cwd: "/tmp", label: "worker", ...overrides };
}

test("inferProvider routes composer models to cursor", () => {
  assert.equal(inferProvider("composer-2.5"), "cursor");
  assert.equal(inferProvider("cursor-small"), "cursor");
});

test("cursor backend runs an agent through the SDK and normalizes the result", async () => {
  const { module, state } = makeFakeSdk();
  const backend = new CursorBackend({ loadSdk: async () => module });
  const events = [];
  const response = await backend.runAgent({
    prompt: "do the thing",
    options: options(),
    instructions: "Be careful.",
    onEvent: (event) => events.push(event),
  });

  assert.equal(response.result, "done");
  assert.equal(response.threadId, "agent-1");
  assert.equal(response.turnId, "run-1");
  assert.deepEqual(response.usage.total, {
    totalTokens: 20,
    inputTokens: 12,
    cachedInputTokens: 3,
    outputTokens: 5,
  });

  const create = state.creates[0];
  assert.deepEqual(create.model, { id: "composer-2.5" });
  assert.equal(create.local.cwd, "/tmp");
  assert.deepEqual(create.local.settingSources, []);
  assert.equal(create.local.sandboxOptions.enabled, true);

  const sent = state.sends[0];
  assert.match(sent, /<developer_instructions>\nBe careful\.\n<\/developer_instructions>/);
  assert.match(sent, /do the thing/);
  assert.match(sent, /read-only agent/);

  assert.equal(events[0].method, "workflow/agentThreadStarted");
  const items = events
    .filter((event) => event.method === "item/completed")
    .map((event) => event.params.item.type);
  assert.deepEqual(items, ["reasoning", "commandExecution", "fileChange", "agentMessage"]);
  assert.equal(state.disposed, 1);
});

test("cursor backend captures schema output via the structured_output custom tool", async () => {
  const { module, state } = makeFakeSdk();
  const backend = new CursorBackend({ loadSdk: async () => module });
  const schema = { type: "object", properties: { verdict: { type: "string" } } };
  const response = await backend.runAgent({ prompt: "judge", options: options({ schema }) });
  assert.deepEqual(response.result, { verdict: "ship it" });
  assert.deepEqual(state.creates[0].local.customTools.structured_output.inputSchema, schema);
  assert.match(state.sends[0], /structured_output tool exactly once/);
});

test("cursor backend fails clearly when schema output is missing and unparsable", async () => {
  const { module } = makeFakeSdk({ behavior: "skip-structured" });
  const backend = new CursorBackend({ loadSdk: async () => module });
  await assert.rejects(
    backend.runAgent({ prompt: "judge", options: options({ schema: { type: "object" } }) }),
    /finished without calling structured_output/,
  );
});

test("cursor backend maps sandbox levels", async () => {
  const { module, state } = makeFakeSdk();
  const backend = new CursorBackend({ loadSdk: async () => module });

  await assert.rejects(
    backend.runAgent({ prompt: "w", options: options({ sandbox: "workspace-write" }) }),
    /requires isolation: "worktree"/,
  );

  await backend.runAgent({
    prompt: "w",
    options: options({ sandbox: "workspace-write", isolation: "worktree" }),
  });
  assert.equal(state.creates.at(-1).local.sandboxOptions.enabled, true);

  await backend.runAgent({ prompt: "w", options: options({ sandbox: "danger-full-access" }) });
  assert.equal(state.creates.at(-1).local.sandboxOptions.enabled, false);
});

test("cursor backend surfaces turn failures and aborts via run.cancel", async () => {
  const errored = makeFakeSdk({ behavior: "error" });
  const backend = new CursorBackend({ loadSdk: async () => errored.module });
  await assert.rejects(
    backend.runAgent({ prompt: "x", options: options() }),
    /Cursor agent did not complete: model exploded/,
  );

  const hanging = makeFakeSdk({ behavior: "hang" });
  const hangingBackend = new CursorBackend({ loadSdk: async () => hanging.module });
  const controller = new AbortController();
  const pending = hangingBackend.runAgent({
    prompt: "x",
    options: options(),
    signal: controller.signal,
  });
  while (!hanging.state.lastRun) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort(new Error("stop now"));
  await assert.rejects(pending, /stop now/);
  assert.ok(hanging.state.cancelled >= 1);
});

test("cursor backend lists models via Cursor.models.list", async () => {
  const { module } = makeFakeSdk();
  module.Cursor = {
    models: {
      async list() {
        return [{ id: "composer-2.5", displayName: "Composer 2.5", aliases: ["composer"] }];
      },
    },
  };
  const backend = new CursorBackend({ loadSdk: async () => module });
  const models = await backend.listModels();
  assert.deepEqual(models, [
    { id: "composer-2.5", displayName: "Composer 2.5", description: undefined, aliases: ["composer"] },
  ]);
});

test("cursor backend reports a missing SDK clearly", async () => {
  const backend = new CursorBackend({
    loadSdk: async () => {
      throw new Error("Cannot find module '@cursor/sdk'");
    },
  });
  await assert.rejects(
    backend.runAgent({ prompt: "x", options: options() }),
    /requires the optional @cursor\/sdk dependency/,
  );
});
