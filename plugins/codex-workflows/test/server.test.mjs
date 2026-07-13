import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";

const SERVER_PATH = new URL("../src/server.mjs", import.meta.url);

async function listTools(childMode) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-workflows-server-"));
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
    const response = await request(2, "tools/list");
    return response.result.tools;
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(stateRoot, { recursive: true, force: true });
  }
}

test("normal MCP server exposes workflow tools", async () => {
  const tools = await listTools(false);
  assert.deepEqual(
    tools.map(({ name }) => name),
    ["workflow_start", "workflow_status", "workflow_wait", "workflow_cancel"],
  );
});

test("workflow child agents cannot recursively invoke workflow tools", async () => {
  assert.deepEqual(await listTools(true), []);
});
