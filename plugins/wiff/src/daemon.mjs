#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  daemonOwnershipPort,
  daemonProof,
  daemonSecret,
  verifyDaemonProof,
} from "./daemon-auth.mjs";
import { WorkflowManager } from "./runtime.mjs";
import { daemonPaths, defaultStateRoot } from "./state.mjs";
import {
  atomicWriteJson,
  ensureDir,
  serializeError,
  writeExclusiveFile,
} from "./util.mjs";
import { WIFF_VERSION } from "./version.mjs";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_IDLE_MS = 15 * 60 * 1_000;
const stateRoot = defaultStateRoot();
const secret = await daemonSecret(stateRoot);
const paths = daemonPaths(stateRoot, secret);
const derivedOwnershipPort = daemonOwnershipPort(secret, paths.stateRoot);
const configuredOwnershipPort = Number(process.env.WIFF_DAEMON_OWNERSHIP_PORT);
const ownershipPort = Number.isInteger(configuredOwnershipPort) &&
  configuredOwnershipPort >= 1_024 && configuredOwnershipPort <= 65_535
  ? configuredOwnershipPort
  : derivedOwnershipPort;
const instanceId = randomUUID();
let closing = false;
let ready = false;
let lastActivityAt = Date.now();
let lockOwned = false;
const controllerSockets = new Set();
const pendingStarts = new Set();

async function readLock() {
  try {
    return JSON.parse(await readFile(paths.lockPath, "utf8"));
  } catch {
    return null;
  }
}

async function writeOwnerLock() {
  await ensureDir(paths.controlDirectory);
  await chmod(paths.controlDirectory, 0o700);
  await rm(paths.lockPath, { force: true });
  const record = {
    pid: process.pid,
    instanceId,
    version: WIFF_VERSION,
    endpoint: paths.endpoint,
    startedAt: new Date().toISOString(),
  };
  if (!(await writeExclusiveFile(paths.lockPath, `${JSON.stringify(record)}\n`, 0o600))) {
    throw new Error("Wiff daemon endpoint owner could not publish its lock record.");
  }
  lockOwned = true;
}

async function createBackend() {
  const modulePath = process.env.WIFF_DAEMON_BACKEND_MODULE?.trim();
  if (!modulePath) return undefined;
  const url = modulePath.startsWith("file:")
    ? modulePath
    : pathToFileURL(path.resolve(modulePath)).href;
  const loaded = await import(url);
  if (typeof loaded.createBackend !== "function") {
    throw new Error(`${modulePath} must export createBackend().`);
  }
  return loaded.createBackend();
}

if (process.platform !== "win32") {
  await ensureDir(path.dirname(paths.endpoint));
  await chmod(path.dirname(paths.endpoint), 0o700);
}

const ownershipServer = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    try {
      const request = JSON.parse(buffer.slice(0, newline));
      if (request.method !== "owner-hello" || !/^[0-9a-f]{64}$/.test(request.nonce)) {
        throw new Error("Invalid ownership challenge.");
      }
      socket.end(
        `${JSON.stringify({
          instanceId,
          proof: daemonProof(secret, "owner", request.nonce),
        })}\n`,
      );
    } catch {
      socket.destroy();
    }
  });
});

function probeOwnershipServer(timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: ownershipPort });
    const nonce = randomBytes(32).toString("hex");
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(authenticated) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(authenticated);
    }
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ method: "owner-hello", nonce })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        finish(verifyDaemonProof(secret, "owner", nonce, response.proof));
      } catch {
        finish(false);
      }
    });
    socket.once("error", () => finish(false));
  });
}

const ownsLease = await new Promise((resolve, reject) => {
  ownershipServer.once("error", reject);
  ownershipServer.listen({ host: "127.0.0.1", port: ownershipPort, exclusive: true }, () => {
    resolve(true);
  });
}).catch(async (error) => {
  if (error?.code !== "EADDRINUSE") throw error;
  if (await probeOwnershipServer()) return false;
  throw new Error(
    `Wiff ownership port ${ownershipPort} is already used by a non-Wiff process. Set WIFF_DAEMON_OWNERSHIP_PORT to an available local port.`,
  );
});
if (!ownsLease) process.exit(0);

const backend = await createBackend();
const manager = new WorkflowManager({ stateRoot: paths.stateRoot, backend });
await manager.initialize();
let recoveredRuns = [];

const server = net.createServer((socket) => {
  controllerSockets.add(socket);
  socket.authNonce = null;
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
      socket.end(
        `${JSON.stringify({
          id: null,
          error: serializeError(
            new Error(`Wiff daemon request exceeded ${MAX_REQUEST_BYTES} bytes.`),
          ),
        })}\n`,
      );
      buffer = "";
      return;
    }
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      void handleLine(socket, line);
    }
  });
  socket.once("close", () => controllerSockets.delete(socket));
  socket.on("error", () => {});
});

async function dispatch(method, args) {
  if (closing && method !== "ping") throw new Error("Wiff daemon is shutting down.");
  if (!ready && method !== "shutdown") throw new Error("Wiff daemon is recovering durable runs.");
  lastActivityAt = Date.now();
  if (method === "ping") {
    return {
      version: WIFF_VERSION,
      pid: process.pid,
      stateRoot: paths.stateRoot,
      shuttingDown: closing,
    };
  }
  if (method === "start") return manager.start({ ...(args ?? {}), durable: true });
  if (method === "status") return manager.status(args?.runId);
  if (method === "wait") return manager.wait(args?.runId, args?.timeoutMs ?? 55_000);
  if (method === "cancel") return manager.cancel(args?.runId);
  if (method === "models") return manager.listModels();
  if (method === "shutdown") {
    setTimeout(() => void close(true).finally(() => process.exit(0)), 10).unref?.();
    return { shuttingDown: true };
  }
  throw new Error(`Unknown daemon method: ${method}`);
}

async function handleLine(socket, line) {
  let request;
  try {
    request = JSON.parse(line);
    if (request.method === "hello") {
      if (typeof request.nonce !== "string" || !/^[0-9a-f]{64}$/.test(request.nonce)) {
        throw new Error("Invalid Wiff daemon authentication challenge.");
      }
      socket.authNonce = request.nonce;
      socket.write(
        `${JSON.stringify({
          id: request.id,
          result: {
            version: WIFF_VERSION,
            instanceId,
            proof: daemonProof(secret, "server", request.nonce),
          },
        })}\n`,
      );
      return;
    }
    if (
      !socket.authNonce ||
      !verifyDaemonProof(
        secret,
        `client:${request.method}`,
        socket.authNonce,
        request.proof,
      )
    ) {
      throw new Error("Wiff daemon authentication failed.");
    }
    const operation = dispatch(request.method, request.args);
    if (request.method === "start") pendingStarts.add(operation);
    const result = await operation.finally(() => pendingStarts.delete(operation));
    if (!socket.destroyed) socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
  } catch (error) {
    if (!socket.destroyed) {
      socket.end(`${JSON.stringify({ id: request?.id, error: serializeError(error) })}\n`);
    }
  }
}

async function claimEndpoint() {
  if (process.platform !== "win32") await rm(paths.endpoint, { force: true });
  const previousUmask = process.umask(0o077);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.endpoint, resolve);
    });
  } finally {
    process.umask(previousUmask);
  }
}

await claimEndpoint();
await writeOwnerLock();
if (process.platform !== "win32") await chmod(paths.endpoint, 0o600);
await atomicWriteJson(paths.recordPath, {
  pid: process.pid,
  instanceId,
  version: WIFF_VERSION,
  endpoint: paths.endpoint,
  stateRoot: paths.stateRoot,
  startedAt: new Date().toISOString(),
  recoveredRuns,
});
recoveredRuns = await manager.recoverDurableRuns();
await atomicWriteJson(paths.recordPath, {
  pid: process.pid,
  instanceId,
  version: WIFF_VERSION,
  endpoint: paths.endpoint,
  stateRoot: paths.stateRoot,
  startedAt: new Date().toISOString(),
  recoveredRuns,
});
ready = true;

const configuredIdleMs = Number(process.env.WIFF_DAEMON_IDLE_MS ?? DEFAULT_IDLE_MS);
const idleMs = Number.isFinite(configuredIdleMs) && configuredIdleMs >= 1_000
  ? configuredIdleMs
  : DEFAULT_IDLE_MS;
const idleTimer = setInterval(() => {
  if (manager.activeCount === 0 && Date.now() - lastActivityAt >= idleMs) void close(false);
}, Math.min(60_000, idleMs));
idleTimer.unref?.();

async function close(restartSafe) {
  if (closing) return;
  closing = true;
  clearInterval(idleTimer);
  for (const socket of controllerSockets) socket.destroy();
  await Promise.allSettled([...pendingStarts]);
  await manager.close({ restartSafe });
  const lock = await readLock();
  if (lockOwned && lock?.instanceId === instanceId) {
    await Promise.all([
      rm(paths.lockPath, { force: true }),
      rm(paths.recordPath, { force: true }),
    ]);
  }
  const serverClosed = new Promise((resolve) => server.close(resolve));
  for (const socket of controllerSockets) socket.destroy();
  await serverClosed;
  await new Promise((resolve) => ownershipServer.close(resolve));
}

function shutDownFromSignal() {
  void close(true).finally(() => process.exit(0));
}

process.on("SIGINT", shutDownFromSignal);
process.on("SIGTERM", shutDownFromSignal);
