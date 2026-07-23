import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";

const SERVER_PATH = new URL("../src/server.mjs", import.meta.url);

async function withServer(childMode, runTest, prepare) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "wiff-server-"));
  await prepare?.(stateRoot);
  const child = spawn(process.execPath, [SERVER_PATH.pathname], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_WORKFLOW_HOME: stateRoot,
      CODEX_WORKFLOW_CHILD: childMode ? "1" : "0",
    },
  });
  const lines = readline.createInterface({ input: child.stdout });
  const responses = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    responses.get(message.id)?.(message);
  });

  function request(id, method, params = {}) {
    return new Promise((resolve) => {
      responses.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  try {
    await request(1, "initialize", { protocolVersion: "2025-11-25" });
    return await runTest(request);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(stateRoot, { recursive: true, force: true });
  }
}

async function listTools(childMode) {
  return withServer(childMode, async (request) => {
    const response = await request(2, "tools/list");
    return response.result.tools;
  });
}

test("normal MCP server exposes workflow tools", async () => {
  const tools = await listTools(false);
  assert.deepEqual(
    tools.map(({ name }) => name),
    ["workflow_start", "workflow_status", "workflow_wait", "workflow_cancel", "workflow_models"],
  );
});

test("workflow child agents cannot recursively invoke workflow tools", async () => {
  assert.deepEqual(await listTools(true), []);
});

test("workflow status text reports queued, executing, and stalled owner state", async () => {
  const runId = "wf_stalled_status_test";
  const response = await withServer(
    false,
    async (request) =>
      request(2, "tools/call", {
        name: "workflow_status",
        arguments: { runId },
      }),
    async (stateRoot) => {
      const runDirectory = path.join(stateRoot, "runs", runId);
      await mkdir(runDirectory, { recursive: true });
      const runPath = path.join(runDirectory, "run.json");
      await writeFile(
        runPath,
        `${JSON.stringify({
          schemaVersion: 1,
          runId,
          status: "running",
          ownerPid: process.pid,
          ownerHeartbeatAt: new Date(Date.now() - 60_000).toISOString(),
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          revision: 1,
          stats: {
            requested: 5,
            queued: 2,
            running: 1,
            completed: 1,
            failed: 1,
            cached: 0,
          },
          runPath,
          journalPath: path.join(runDirectory, "journal.jsonl"),
        })}\n`,
      );
    },
  );
  const text = response.result.content[0].text;
  assert.match(text, /2 queued, 1 executing/);
  assert.match(text, /Owner: stalled \(\d+s since heartbeat\)/);
  assert.equal(response.result.structuredContent.run.status, "running");
  assert.equal(response.result.structuredContent.run.ownerResponsive, false);
});
