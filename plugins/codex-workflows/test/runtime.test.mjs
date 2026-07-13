import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { WorkflowManager } from "../src/runtime.mjs";

const execFileAsync = promisify(execFile);
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

class FakeBackend {
  calls = [];

  async runAgent({ prompt, options, instructions, signal, onEvent }) {
    const call = { prompt, options, instructions };
    this.calls.push(call);
    if (prompt.startsWith("WRITE:")) {
      await writeFile(path.join(options.cwd, prompt.slice("WRITE:".length)), "made by agent\n");
    }
    onEvent?.({ method: "fake/started", params: { prompt } });
    if (prompt === "WAIT") {
      await new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (prompt === "SLOW") {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (prompt.startsWith("FAIL")) throw new Error(prompt);
    const result = options.schema
      ? { verdict: prompt.includes("bad") ? "reject" : "fix", rationale: prompt }
      : `result:${prompt}`;
    onEvent?.({ method: "fake/completed", params: { prompt } });
    return {
      result,
      threadId: `thread-${this.calls.length}`,
      turnId: `turn-${this.calls.length}`,
      usage: { total: { totalTokens: 10 } },
    };
  }

  async close() {}
}

async function withManager(runTest, managerOptions = {}) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-workflows-test-"));
  const backend = new FakeBackend();
  const manager = new WorkflowManager({ stateRoot, backend, maxConcurrency: 4, ...managerOptions });
  try {
    await manager.initialize();
    await runTest({ manager, backend, stateRoot });
  } finally {
    await manager.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
}

async function makeGitRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codex-workflows-repo-"));
  const git = (...args) => execFileAsync("git", ["-C", repo, ...args]);
  await git("init", "--quiet");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await writeFile(path.join(repo, "tracked.txt"), "hello\n");
  await git("add", "tracked.txt");
  await git("commit", "--quiet", "-m", "init");
  return repo;
}

async function exists(target) {
  return stat(target).then(
    () => true,
    () => false,
  );
}

async function waitForTerminal(manager, runId) {
  let run = await manager.status(runId);
  while (!TERMINAL.has(run.status)) {
    run = await manager.wait(runId, 5_000);
  }
  return run;
}

test("runs parallel agents and a sequential pipeline", async () => {
  await withManager(async ({ manager, backend }) => {
    const script = `
      export const meta = {
        name: "parallel-pipeline",
        description: "Exercise runtime helpers",
        phases: [{ title: "Run", detail: "Run agents" }],
      };
      phase("Run");
      const first = await parallel([
        () => agent("one", { key: "one" }),
        () => agent("two", { key: "two" }),
      ], { concurrency: 2 });
      const second = await pipeline(
        first,
        (value) => agent("stage:" + value, { key: "stage:" + value }),
        { concurrency: 1 },
      );
      return { first, second };
    `;
    const started = await manager.start({ script, cwd: process.cwd() });
    const run = await waitForTerminal(manager, started.runId);

    assert.equal(run.status, "completed");
    assert.deepEqual(run.result, {
      first: ["result:one", "result:two"],
      second: ["result:stage:result:one", "result:stage:result:two"],
    });
    assert.equal(backend.calls.length, 4);
    assert.equal(run.stats.completed, 4);
    assert.equal(run.stats.failed, 0);
  });
});

test("parallel fails the workflow when any agent rejects", async () => {
  await withManager(async ({ manager }) => {
    const script = `
      export const meta = { name: "fail-hard", description: "Prove failure propagation" };
      await parallel([
        () => agent("ok", { key: "ok" }),
        () => agent("FAIL expected", { key: "failure" }),
      ]);
      return "unreachable";
    `;
    const started = await manager.start({ script, cwd: process.cwd() });
    const run = await waitForTerminal(manager, started.runId);

    assert.equal(run.status, "failed");
    assert.match(run.error.message, /parallel task/);
    assert.equal(run.stats.failed, 1);
    assert.equal(run.failures.length, 1);
  });
});

test("parallelSettled permits explicitly handled agent failures", async () => {
  await withManager(async ({ manager }) => {
    const script = `
      export const meta = { name: "settled", description: "Handle partial failure explicitly" };
      const results = await parallelSettled([
        () => agent("ok", { key: "ok" }),
        () => agent("FAIL handled", { key: "handled-failure" }),
      ]);
      return results.map((entry) => ({ status: entry.status, message: entry.reason?.message }));
    `;
    const started = await manager.start({ script, cwd: process.cwd() });
    const run = await waitForTerminal(manager, started.runId);
    assert.equal(run.status, "completed");
    assert.deepEqual(run.result, [
      { status: "fulfilled" },
      { status: "rejected", message: "FAIL handled" },
    ]);
    assert.equal(run.stats.failed, 1);
  });
});

test("resume replays successful unchanged agent calls", async () => {
  await withManager(async ({ manager, backend }) => {
    const script = `
      export const meta = { name: "resume", description: "Prove keyed replay" };
      return await agent("cached work", { key: "stable-key" });
    `;
    const started = await manager.start({ script, cwd: process.cwd() });
    const first = await waitForTerminal(manager, started.runId);
    assert.equal(first.status, "completed");
    assert.equal(backend.calls.length, 1);

    const resumed = await manager.start({ resumeFromRunId: started.runId });
    const second = await waitForTerminal(manager, resumed.runId);
    assert.equal(second.status, "completed");
    assert.equal(second.result, "result:cached work");
    assert.equal(second.stats.cached, 1);
    assert.equal(backend.calls.length, 1);
  });
});

test("cancel aborts a live agent and marks the run cancelled", async () => {
  await withManager(async ({ manager }) => {
    const script = `
      export const meta = { name: "cancel", description: "Prove cancellation" };
      return await agent("WAIT", { key: "wait", timeoutMs: 60000 });
    `;
    const started = await manager.start({ script, cwd: process.cwd() });
    let run = await manager.status(started.runId);
    while (run.stats.running === 0 && !TERMINAL.has(run.status)) {
      run = await manager.wait(started.runId, 5_000);
    }
    const cancelled = await manager.cancel(started.runId);
    assert.equal(cancelled.status, "cancelled");
    assert.match(cancelled.error.message, /cancelled|shutting down/i);
  });
});

test("a second manager observes a live owner without interrupting it", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-workflows-host-test-"));
  const owner = new WorkflowManager({ stateRoot, backend: new FakeBackend(), maxConcurrency: 2 });
  const observer = new WorkflowManager({ stateRoot, backend: new FakeBackend(), maxConcurrency: 2 });
  try {
    await owner.initialize();
    const started = await owner.start({
      cwd: process.cwd(),
      script: `
        export const meta = { name: "cross-host", description: "Stay live across MCP hosts" };
        return await agent("SLOW", { key: "slow" });
      `,
    });
    let running = await owner.status(started.runId);
    while (running.stats.running === 0) running = await owner.wait(started.runId, 1_000);

    await observer.initialize();
    assert.equal((await observer.status(started.runId)).status, "running");
    const completed = await waitForTerminal(observer, started.runId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result, "result:SLOW");
  } finally {
    await Promise.allSettled([owner.close(), observer.close()]);
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a second manager can cancel a workflow owned by another host", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-workflows-cancel-test-"));
  const owner = new WorkflowManager({ stateRoot, backend: new FakeBackend(), maxConcurrency: 2 });
  const controller = new WorkflowManager({ stateRoot, backend: new FakeBackend(), maxConcurrency: 2 });
  try {
    await owner.initialize();
    const started = await owner.start({
      cwd: process.cwd(),
      script: `
        export const meta = { name: "cross-host-cancel", description: "Cancel across MCP hosts" };
        return await agent("WAIT", { key: "wait", timeoutMs: 60000 });
      `,
    });
    let running = await owner.status(started.runId);
    while (running.stats.running === 0) running = await owner.wait(started.runId, 1_000);

    await controller.initialize();
    const cancelled = await controller.cancel(started.runId);
    assert.equal(cancelled.status, "cancelled");
    assert.match(cancelled.error.message, /cancelled/i);
  } finally {
    await Promise.allSettled([owner.close(), controller.close()]);
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Date and randomness are blocked inside workflow JavaScript", async () => {
  await withManager(async ({ manager }) => {
    const script = `
      export const meta = { name: "determinism", description: "Prove blocked globals" };
      const errors = [];
      try { Date.now(); } catch (error) { errors.push(error.message); }
      try { Math.random(); } catch (error) { errors.push(error.message); }
      return errors;
    `;
    const started = await manager.start({ script, cwd: process.cwd() });
    const run = await waitForTerminal(manager, started.runId);
    assert.equal(run.status, "completed");
    assert.match(run.result[0], /Date\.now/);
    assert.match(run.result[1], /Math\.random/);
  });
});

test("workflow globals cannot escape into the host Function constructor", async () => {
  await withManager(async ({ manager }) => {
    const script = `
      export const meta = { name: "isolation", description: "Prove host isolation" };
      const errors = [];
      for (const value of [agent, args, Math.max]) {
        try {
          value.constructor.constructor("return process")();
          errors.push("escaped");
        } catch (error) {
          errors.push(error.message);
        }
      }
      return errors;
    `;
    const started = await manager.start({ script, cwd: process.cwd(), args: { safe: true } });
    const run = await waitForTerminal(manager, started.runId);
    assert.equal(run.status, "completed");
    assert.equal(run.result.includes("escaped"), false);
    assert.equal(run.result.length, 3);
  });
});

test("worktree isolation gives each agent its own checkout and keeps only dirty ones", async () => {
  const repo = await makeGitRepo();
  try {
    await withManager(async ({ manager, backend, stateRoot }) => {
      const script = `
        export const meta = { name: "worktrees", description: "Prove worktree isolation" };
        return await parallel([
          () => agent("WRITE:new-file.txt", { key: "writer", isolation: "worktree", sandbox: "workspace-write" }),
          () => agent("just read", { key: "reader", isolation: "worktree" }),
        ]);
      `;
      const started = await manager.start({ script, cwd: repo });
      const run = await waitForTerminal(manager, started.runId);
      assert.equal(run.status, "completed");

      const worktreesRoot = path.join(stateRoot, "runs", run.runId, "worktrees");
      const cwds = backend.calls.map((call) => call.options.cwd);
      assert.equal(cwds.length, 2);
      for (const cwd of cwds) {
        assert.ok(cwd.startsWith(worktreesRoot), `agent cwd ${cwd} should be a run worktree`);
      }
      assert.notEqual(cwds[0], cwds[1]);

      const writerCwd = backend.calls.find((call) => call.prompt.startsWith("WRITE:")).options.cwd;
      const readerCwd = backend.calls.find((call) => !call.prompt.startsWith("WRITE:")).options.cwd;
      assert.equal(await exists(path.join(writerCwd, "new-file.txt")), true);
      assert.equal(await exists(readerCwd), false, "clean worktree should be removed");
      assert.deepEqual(
        run.worktrees.map((entry) => entry.key),
        ["writer"],
      );
      assert.equal(run.worktrees[0].path, writerCwd);
      assert.equal(await exists(path.join(repo, "new-file.txt")), false, "repo stays untouched");
    });
  } finally {
    await execFileAsync("git", ["-C", repo, "worktree", "prune"]).catch(() => {});
    await rm(repo, { recursive: true, force: true });
  }
});

test("worktree isolation fails clearly outside a git repository", async () => {
  const plainDir = await mkdtemp(path.join(os.tmpdir(), "codex-workflows-plain-"));
  try {
    await withManager(async ({ manager }) => {
      const script = `
        export const meta = { name: "no-repo", description: "Prove git requirement" };
        return await agent("read", { key: "reader", isolation: "worktree" });
      `;
      const started = await manager.start({ script, cwd: plainDir });
      const run = await waitForTerminal(manager, started.runId);
      assert.equal(run.status, "failed");
      assert.match(run.error.message, /git repository/);
    });
  } finally {
    await rm(plainDir, { recursive: true, force: true });
  }
});

test("agentType resolves persona instructions and frontmatter defaults", async () => {
  const agentsDir = await mkdtemp(path.join(os.tmpdir(), "codex-workflows-agents-"));
  try {
    await writeFile(
      path.join(agentsDir, "reviewer.md"),
      "---\neffort: low\nsandbox: workspace-write\n---\nYou are a meticulous reviewer. Codeword: XYZZY.\n",
    );
    await withManager(
      async ({ manager, backend }) => {
        const script = `
          export const meta = { name: "personas", description: "Prove agentType injection" };
          const first = await agent("review this", { key: "typed", agentType: "reviewer" });
          const second = await agent("review that", {
            key: "typed-override",
            agentType: "reviewer",
            effort: "xhigh",
          });
          return [first, second];
        `;
        const started = await manager.start({ script, cwd: process.cwd() });
        const run = await waitForTerminal(manager, started.runId);
        assert.equal(run.status, "completed");

        const [first, second] = backend.calls;
        assert.match(first.instructions, /meticulous reviewer/);
        assert.equal(first.options.effort, "low");
        assert.equal(first.options.sandbox, "workspace-write");
        assert.equal(first.options.agentType, "reviewer");
        assert.ok(first.options.instructionsHash);
        assert.equal(second.options.effort, "xhigh", "explicit options beat persona defaults");
      },
      { agentsDir },
    );
  } finally {
    await rm(agentsDir, { recursive: true, force: true });
  }
});

test("unknown agentType fails the workflow with the searched paths", async () => {
  const agentsDir = await mkdtemp(path.join(os.tmpdir(), "codex-workflows-agents-"));
  try {
    await withManager(
      async ({ manager }) => {
        const script = `
          export const meta = { name: "missing-persona", description: "Prove agentType errors" };
          return await agent("review", { key: "typed", agentType: "nonexistent" });
        `;
        const started = await manager.start({ script, cwd: process.cwd() });
        const run = await waitForTerminal(manager, started.runId);
        assert.equal(run.status, "failed");
        assert.match(run.error.message, /Unknown agentType "nonexistent"/);
      },
      { agentsDir },
    );
  } finally {
    await rm(agentsDir, { recursive: true, force: true });
  }
});

test("editing a persona invalidates the resume cache", async () => {
  const agentsDir = await mkdtemp(path.join(os.tmpdir(), "codex-workflows-agents-"));
  try {
    await writeFile(path.join(agentsDir, "helper.md"), "Original persona.\n");
    await withManager(
      async ({ manager, backend }) => {
        const script = `
          export const meta = { name: "persona-cache", description: "Prove persona hash in cache key" };
          return await agent("stable work", { key: "stable", agentType: "helper" });
        `;
        const started = await manager.start({ script, cwd: process.cwd() });
        assert.equal((await waitForTerminal(manager, started.runId)).status, "completed");
        assert.equal(backend.calls.length, 1);

        const cachedResume = await manager.start({ resumeFromRunId: started.runId });
        assert.equal((await waitForTerminal(manager, cachedResume.runId)).stats.cached, 1);
        assert.equal(backend.calls.length, 1);

        await writeFile(path.join(agentsDir, "helper.md"), "Edited persona.\n");
        const invalidatedResume = await manager.start({ resumeFromRunId: started.runId });
        assert.equal((await waitForTerminal(manager, invalidatedResume.runId)).stats.cached, 0);
        assert.equal(backend.calls.length, 2);
        assert.match(backend.calls[1].instructions, /Edited persona/);
      },
      { agentsDir },
    );
  } finally {
    await rm(agentsDir, { recursive: true, force: true });
  }
});
