import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  daemonOwnershipPort,
  daemonProof,
  daemonSecret,
  verifyDaemonProof,
} from "../src/daemon-auth.mjs";
import {
  callDaemon,
  ensureDaemon,
  readDaemonRecord,
  stopDaemon,
} from "../src/daemon-client.mjs";
import { daemonPaths } from "../src/state.mjs";
import { WIFF_VERSION } from "../src/version.mjs";

const SERVER_PATH = new URL("../src/server.mjs", import.meta.url);
const PACKAGE_PATH = new URL("../package.json", import.meta.url);
const DAEMON_BACKEND_PATH = fileURLToPath(
  new URL("../test-support/daemon-backend.mjs", import.meta.url),
);

async function startServer(stateRoot, childMode = false, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER_PATH.pathname], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_WORKFLOW_HOME: stateRoot,
      CODEX_WORKFLOW_CHILD: childMode ? "1" : "0",
      WIFF_DAEMON_IDLE_MS: "60000",
      ...extraEnv,
    },
  });
  const lines = readline.createInterface({ input: child.stdout });
  const responses = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const respond = responses.get(message.id);
    if (!respond) return;
    responses.delete(message.id);
    respond(message);
  });

  function request(id, method, params = {}) {
    return new Promise((resolve) => {
      responses.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async function close() {
    if (child.exitCode !== null) return;
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
  }

  await request(1, "initialize", { protocolVersion: "2025-11-25" });
  return { child, close, request };
}

async function withServer(childMode, runTest, prepare) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "wiff-server-"));
  await prepare?.(stateRoot);
  const server = await startServer(stateRoot, childMode);

  try {
    return await runTest(server.request);
  } finally {
    await server.close();
    await stopDaemon({ stateRoot });
    await rm(stateRoot, { recursive: true, force: true });
  }
}

async function callTool(request, id, name, args = {}) {
  const response = await request(id, "tools/call", { name, arguments: args });
  if (response.result?.isError) {
    throw new Error(response.result.content?.[0]?.text ?? `${name} failed`);
  }
  return response.result.structuredContent;
}

async function waitForTerminal(request, runId, startingId = 10) {
  const deadline = Date.now() + 10_000;
  let id = startingId;
  while (Date.now() < deadline) {
    const { run } = await callTool(request, id++, "workflow_wait", { runId, timeoutMs: 1_000 });
    if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) return run;
  }
  throw new Error(`Workflow ${runId} did not finish within 10000ms.`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} did not exit within 10000ms.`);
}

async function startAuthenticatedControlServer(stateRoot, onRequest) {
  const secret = await daemonSecret(stateRoot);
  const paths = daemonPaths(stateRoot, secret);
  await mkdir(path.dirname(paths.endpoint), { recursive: true });
  await chmod(path.dirname(paths.endpoint), 0o700);
  await rm(paths.endpoint, { force: true });
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.authNonce = null;
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = JSON.parse(line);
        if (request.method === "hello") {
          socket.authNonce = request.nonce;
          socket.write(
            `${JSON.stringify({
              id: request.id,
              result: {
                version: WIFF_VERSION,
                instanceId: "test-control-server",
                proof: daemonProof(secret, "server", request.nonce),
              },
            })}\n`,
          );
          continue;
        }
        assert.equal(
          verifyDaemonProof(
            secret,
            `client:${request.method}`,
            socket.authNonce,
            request.proof,
          ),
          true,
        );
        void onRequest({ request, server, socket });
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.endpoint, resolve);
  });
  return {
    paths,
    server,
    async close() {
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
  };
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

test("MCP handshake reports the package version", async () => {
  const packageJson = JSON.parse(await readFile(PACKAGE_PATH, "utf8"));
  const version = await withServer(false, async (request) => {
    const response = await request(2, "initialize", { protocolVersion: "2025-11-25" });
    return response.result.serverInfo.version;
  });
  assert.equal(version, packageJson.version);
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

test("a workflow survives the MCP bridge that launched it", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "wiff-daemon-parent-"));
  const extraEnv = { WIFF_DAEMON_BACKEND_MODULE: DAEMON_BACKEND_PATH };
  let first;
  let second;
  try {
    first = await startServer(stateRoot, false, extraEnv);
    const launched = await callTool(first.request, 2, "workflow_start", {
      cwd: process.cwd(),
      script: `
        export const meta = { name: "bridge-survival", description: "Outlive the MCP bridge" };
        return await agent("DELAY:500", { key: "slow" });
      `,
    });
    const daemon = await readDaemonRecord({ stateRoot });
    assert.equal(launched.run.ownerPid, daemon.pid);
    assert.notEqual(launched.run.ownerPid, first.child.pid);

    first.child.kill("SIGKILL");
    await new Promise((resolve) => first.child.once("exit", resolve));
    first = null;
    assert.equal(processAlive(daemon.pid), true);

    second = await startServer(stateRoot, false, extraEnv);
    const completed = await waitForTerminal(second.request, launched.run.runId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result, "result:DELAY:500");
    assert.equal(completed.attempt, 1);
  } finally {
    await first?.close();
    await second?.close();
    await stopDaemon({ stateRoot });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a graceful daemon restart resumes durable interrupted work", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "wiff-daemon-restart-"));
  const extraEnv = { WIFF_DAEMON_BACKEND_MODULE: DAEMON_BACKEND_PATH };
  let bridge;
  try {
    bridge = await startServer(stateRoot, false, extraEnv);
    const launched = await callTool(bridge.request, 2, "workflow_start", {
      cwd: process.cwd(),
      script: `
        export const meta = { name: "daemon-restart", description: "Resume after daemon restart" };
        return await agent("IGNORE-ABORT:500", { key: "slow" });
      `,
    });

    let run = launched.run;
    let id = 3;
    while (run.stats.running === 0) {
      ({ run } = await callTool(bridge.request, id++, "workflow_wait", {
        runId: run.runId,
        timeoutMs: 250,
      }));
    }
    const before = await readDaemonRecord({ stateRoot });
    const activeWait = callTool(bridge.request, id++, "workflow_wait", {
      runId: run.runId,
      timeoutMs: 5_000,
    }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.kill(before.pid, "SIGTERM");
    await waitForProcessExit(before.pid);
    const reconnectedWait = await activeWait;
    assert.ok(reconnectedWait?.run);

    const completed = await waitForTerminal(bridge.request, run.runId, id);
    const after = await readDaemonRecord({ stateRoot });
    assert.notEqual(after.pid, before.pid);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result, "result:IGNORE-ABORT:500");
    assert.equal(completed.attempt, 2);
    assert.equal(completed.durable, true);
  } finally {
    await bridge?.close();
    await stopDaemon({ stateRoot });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("concurrent bridges converge on one daemon owner", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "wiff-daemon-race-"));
  const counterPath = path.join(stateRoot, "backend-owners.txt");
  const extraEnv = {
    WIFF_DAEMON_BACKEND_MODULE: DAEMON_BACKEND_PATH,
    WIFF_DAEMON_BACKEND_COUNTER_FILE: counterPath,
  };
  let first;
  let second;
  try {
    [first, second] = await Promise.all([
      startServer(stateRoot, false, extraEnv),
      startServer(stateRoot, false, extraEnv),
    ]);
    const [left, right] = await Promise.all([
      callTool(first.request, 2, "workflow_start", {
        cwd: process.cwd(),
        script: `export const meta = { name: "left", description: "left" }; return "left";`,
      }),
      callTool(second.request, 2, "workflow_start", {
        cwd: process.cwd(),
        script: `export const meta = { name: "right", description: "right" }; return "right";`,
      }),
    ]);
    const daemon = await readDaemonRecord({ stateRoot });
    assert.equal(left.run.ownerPid, daemon.pid);
    assert.equal(right.run.ownerPid, daemon.pid);
    const backendOwners = (await readFile(counterPath, "utf8")).trim().split("\n");
    assert.deepEqual(backendOwners, [String(daemon.pid)]);
  } finally {
    await first?.close();
    await second?.close();
    await stopDaemon({ stateRoot });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("malformed ownership probes cannot crash the daemon", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "wiff-daemon-owner-probe-"));
  let bridge;
  try {
    bridge = await startServer(stateRoot);
    const launched = await callTool(bridge.request, 2, "workflow_start", {
      cwd: process.cwd(),
      script: `export const meta = { name: "probe", description: "probe" }; return "ok";`,
    });
    const secret = await daemonSecret(stateRoot);
    const port = daemonOwnershipPort(secret, daemonPaths(stateRoot).stateRoot);
    await Promise.all(
      Array.from(
        { length: 20 },
        () =>
          new Promise((resolve) => {
            const socket = net.createConnection({ host: "127.0.0.1", port });
            socket.once("connect", () => {
              socket.write("not-json\n");
              socket.destroy();
              resolve();
            });
            socket.once("error", resolve);
          }),
      ),
    );
    const { run } = await callTool(bridge.request, 3, "workflow_status", {
      runId: launched.run.runId,
    });
    const daemon = await readDaemonRecord({ stateRoot });
    assert.equal(processAlive(daemon.pid), true);
    assert.notEqual(run.status, "failed");
  } finally {
    await bridge?.close();
    await stopDaemon({ stateRoot });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a stale lock is recovered even when its pid was reused", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "wiff-daemon-stale-pid-"));
  let bridge;
  try {
    const secret = await daemonSecret(stateRoot);
    const paths = daemonPaths(stateRoot, secret);
    await writeFile(
      paths.lockPath,
      `${JSON.stringify({
        pid: process.pid,
        instanceId: "not-this-process",
        version: WIFF_VERSION,
        endpoint: paths.endpoint,
        startedAt: new Date(0).toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    bridge = await startServer(stateRoot);
    const launched = await callTool(bridge.request, 2, "workflow_start", {
      cwd: process.cwd(),
      script: `export const meta = { name: "stale", description: "stale" }; return "ok";`,
    });
    const daemon = await readDaemonRecord({ stateRoot });
    assert.notEqual(daemon.pid, process.pid);
    assert.equal(launched.run.ownerPid, daemon.pid);
  } finally {
    await bridge?.close();
    await stopDaemon({ stateRoot });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("an endpoint imposter never receives workflow payloads", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "wiff-daemon-imposter-"));
  const received = [];
  let imposter;
  try {
    const secret = await daemonSecret(stateRoot);
    const paths = daemonPaths(stateRoot, secret);
    await mkdir(path.dirname(paths.endpoint), { recursive: true });
    await chmod(path.dirname(paths.endpoint), 0o700);
    await rm(paths.endpoint, { force: true });
    imposter = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        for (const line of chunk.split("\n").filter(Boolean)) {
          const request = JSON.parse(line);
          received.push(request);
          socket.end(
            `${JSON.stringify({
              id: request.id,
              result: { version: WIFF_VERSION, proof: "0".repeat(64) },
            })}\n`,
          );
          imposter.close();
        }
      });
    });
    await new Promise((resolve, reject) => {
      imposter.once("error", reject);
      imposter.listen(paths.endpoint, resolve);
    });

    const launched = await callDaemon(
      "start",
      {
        cwd: process.cwd(),
        script: `export const meta = { name: "secret", description: "secret" }; return "ok";`,
      },
      { stateRoot },
    );
    assert.equal(launched.durable, true);
    assert.ok(received.length >= 1);
    assert.deepEqual([...new Set(received.map(({ method }) => method))], ["hello"]);
  } finally {
    await new Promise((resolve) => imposter?.close(resolve));
    await stopDaemon({ stateRoot });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a delivered start with a lost response is never retried", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "wiff-daemon-start-ambiguity-"));
  let starts = 0;
  let control;
  try {
    control = await startAuthenticatedControlServer(
      stateRoot,
      ({ request, socket }) => {
        if (request.method === "ping") {
          socket.end(
            `${JSON.stringify({ id: request.id, result: { version: WIFF_VERSION } })}\n`,
          );
          return;
        }
        if (request.method === "start") {
          starts += 1;
          socket.destroy();
        }
      },
    );

    await assert.rejects(
      callDaemon(
        "start",
        {
          cwd: process.cwd(),
          script: `export const meta = { name: "ambiguous", description: "ambiguous" }; return "ok";`,
        },
        { stateRoot },
      ),
      /launch outcome is unknown/,
    );
    assert.equal(starts, 1);
  } finally {
    await control?.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("workflow_start accepts request payloads larger than the old 1 MiB cap", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "wiff-daemon-large-request-"));
  let bridge;
  try {
    bridge = await startServer(stateRoot);
    const payload = "x".repeat(2 * 1024 * 1024);
    const launched = await callTool(bridge.request, 2, "workflow_start", {
      cwd: process.cwd(),
      args: { payload },
      script: `export const meta = { name: "large", description: "large" }; return args.payload.length;`,
    });
    const completed = await waitForTerminal(bridge.request, launched.run.runId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result, payload.length);
  } finally {
    await bridge?.close();
    await stopDaemon({ stateRoot });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("abrupt daemon death remains interrupted until explicit resume", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "wiff-daemon-abrupt-"));
  const extraEnv = { WIFF_DAEMON_BACKEND_MODULE: DAEMON_BACKEND_PATH };
  let bridge;
  try {
    bridge = await startServer(stateRoot, false, extraEnv);
    const launched = await callTool(bridge.request, 2, "workflow_start", {
      cwd: process.cwd(),
      script: `
        export const meta = { name: "abrupt", description: "abrupt" };
        return await agent("DELAY:1000", { key: "slow" });
      `,
    });
    let run = launched.run;
    let id = 3;
    while (run.stats.running === 0) {
      ({ run } = await callTool(bridge.request, id++, "workflow_wait", {
        runId: run.runId,
        timeoutMs: 250,
      }));
    }
    const before = await readDaemonRecord({ stateRoot });
    process.kill(before.pid, "SIGKILL");
    await waitForProcessExit(before.pid);

    ({ run } = await callTool(bridge.request, id++, "workflow_status", {
      runId: run.runId,
    }));
    assert.equal(run.status, "interrupted");
    assert.equal(run.restartSafe, false);
    assert.equal(run.attempt, 1);

    ({ run } = await callTool(bridge.request, id++, "workflow_start", {
      resumeFromRunId: run.runId,
      cwd: process.cwd(),
    }));
    const completed = await waitForTerminal(bridge.request, run.runId, id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.attempt, 2);
  } finally {
    await bridge?.close();
    await stopDaemon({ stateRoot });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("the authenticated shutdown command exits with a wait in flight", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "wiff-daemon-shutdown-"));
  const extraEnv = { WIFF_DAEMON_BACKEND_MODULE: DAEMON_BACKEND_PATH };
  let bridge;
  try {
    bridge = await startServer(stateRoot, false, extraEnv);
    const launched = await callTool(bridge.request, 2, "workflow_start", {
      cwd: process.cwd(),
      script: `
        export const meta = { name: "shutdown", description: "shutdown" };
        return await agent("DELAY:1000", { key: "slow" });
      `,
    });
    let run = launched.run;
    let id = 3;
    while (run.stats.running === 0) {
      ({ run } = await callTool(bridge.request, id++, "workflow_wait", {
        runId: run.runId,
        timeoutMs: 250,
      }));
    }
    const before = await readDaemonRecord({ stateRoot });
    const activeWait = callTool(bridge.request, id++, "workflow_wait", {
      runId: run.runId,
      timeoutMs: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await stopDaemon({ stateRoot });
    await waitForProcessExit(before.pid);
    assert.ok((await activeWait).run);
  } finally {
    await bridge?.close();
    await stopDaemon({ stateRoot });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a version-mismatched daemon is handed off to the current version", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "wiff-daemon-version-"));
  let control;
  try {
    control = await startAuthenticatedControlServer(
      stateRoot,
      ({ request, socket }) => {
        if (request.method === "ping") {
          socket.end(`${JSON.stringify({ id: request.id, result: { version: "0.8.0" } })}\n`);
          return;
        }
        if (request.method === "shutdown") {
          control.server.close();
          socket.end(`${JSON.stringify({ id: request.id, result: { shuttingDown: true } })}\n`);
        }
      },
    );

    const daemon = await ensureDaemon({ stateRoot });
    assert.equal(daemon.version, WIFF_VERSION);
    const record = await readDaemonRecord({ stateRoot });
    assert.equal(record.version, WIFF_VERSION);
  } finally {
    await control?.close().catch(() => {});
    await stopDaemon({ stateRoot });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("stopDaemon ignores a stale daemon record whose pid was reused", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "wiff-daemon-stale-record-"));
  const paths = daemonPaths(stateRoot);
  try {
    await daemonSecret(stateRoot);
    await writeFile(
      paths.recordPath,
      `${JSON.stringify({
        pid: process.pid,
        instanceId: "stale-record",
        version: WIFF_VERSION,
        stateRoot,
      })}\n`,
    );
    await stopDaemon({ stateRoot });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
