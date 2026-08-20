import { closeSync, openSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { daemonProof, daemonSecret, verifyDaemonProof } from "./daemon-auth.mjs";
import { daemonPaths, defaultStateRoot } from "./state.mjs";
import { ensureDir } from "./util.mjs";
import { WIFF_VERSION } from "./version.mjs";

const DAEMON_PATH = fileURLToPath(new URL("./daemon.mjs", import.meta.url));
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 70_000;
const readyByRoot = new Map();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) await delay(50);
  if (processAlive(pid)) throw new Error(`Wiff daemon process ${pid} did not exit within ${timeoutMs}ms.`);
}

function remoteError(payload) {
  const error = new Error(payload?.message ?? "Wiff daemon request failed.");
  error.name = payload?.name ?? "DaemonError";
  error.code = payload?.code;
  error.remote = true;
  if (payload?.stack) error.stack = payload.stack;
  return error;
}

function requestOnce(endpoint, secret, method, args, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const nonce = randomBytes(32).toString("hex");
    let buffer = "";
    let connected = false;
    let authenticated = false;
    let delivered = false;
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`Wiff daemon ${method} request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        if (error.connected === undefined) error.connected = connected;
        if (error.delivered === undefined) error.delivered = delivered;
        reject(error);
      } else resolve(value);
    }

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify({ id: 0, method: "hello", nonce })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          finish(new Error(`Invalid response from Wiff daemon: ${error.message}`));
          return;
        }
        if (message.error) {
          finish(remoteError(message.error));
          return;
        }
        if (!authenticated) {
          if (!verifyDaemonProof(secret, "server", nonce, message.result?.proof)) {
            finish(new Error("Wiff daemon identity verification failed."));
            return;
          }
          authenticated = true;
          const encodedRequest = `${JSON.stringify({
              id: 1,
              method,
              args,
              proof: daemonProof(secret, `client:${method}`, nonce),
            })}\n`;
          socket.write(encodedRequest);
          delivered = true;
          continue;
        }
        finish(null, message.result);
        return;
      }
    });
    socket.once("error", (error) => {
      error.connected = connected;
      finish(error);
    });
    socket.once("end", () => {
      if (!settled) finish(new Error(`Wiff daemon closed the ${method} request without a response.`));
    });
  });
}

async function ping(stateRoot, secret, timeoutMs = 1_000) {
  const { endpoint } = daemonPaths(stateRoot, secret);
  return requestOnce(endpoint, secret, "ping", {}, timeoutMs);
}

async function spawnDaemon(stateRoot, secret) {
  const paths = daemonPaths(stateRoot, secret);
  await ensureDir(paths.stateRoot);
  const logFd = openSync(paths.logPath, "a", 0o600);
  try {
    const child = spawn(process.execPath, [DAEMON_PATH], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        WIFF_HOME: paths.stateRoot,
        CODEX_WORKFLOW_CHILD: "0",
        WIFF_DAEMON_PROCESS: "1",
      },
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

async function waitForDaemon(stateRoot, secret, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastSpawnAt = Date.now();
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await ping(stateRoot, secret);
      if (result.version !== WIFF_VERSION) {
        throw new Error(
          `Wiff daemon version ${result.version ?? "unknown"} does not match bridge version ${WIFF_VERSION}.`,
        );
      }
      if (result.shuttingDown) throw new Error("Wiff daemon is shutting down.");
      return result;
    } catch (error) {
      lastError = error;
      if (Date.now() - lastSpawnAt >= 250) {
        try {
        await spawnDaemon(stateRoot, secret);
        } catch (spawnError) {
          lastError = spawnError;
        }
        lastSpawnAt = Date.now();
      }
      await delay(50);
    }
  }
  throw new Error(
    `Wiff daemon did not become ready within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : "."}`,
  );
}

async function startDaemon(stateRoot, secret, timeoutMs) {
  try {
    const existing = await ping(stateRoot, secret);
    if (existing.version === WIFF_VERSION && !existing.shuttingDown) return existing;
    if (existing.shuttingDown) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          await ping(stateRoot, secret, 250);
          await delay(50);
        } catch {
          break;
        }
      }
      await spawnDaemon(stateRoot, secret);
      return waitForDaemon(stateRoot, secret, timeoutMs);
    }
    await requestOnce(
      daemonPaths(stateRoot, secret).endpoint,
      secret,
      "shutdown",
      {},
      10_000,
    ).catch(() => {});
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await ping(stateRoot, secret, 250);
        await delay(50);
      } catch {
        break;
      }
    }
  } catch {
    // No live daemon owns this state root.
  }
  await spawnDaemon(stateRoot, secret);
  return waitForDaemon(stateRoot, secret, timeoutMs);
}

export async function ensureDaemon({
  stateRoot = defaultStateRoot(),
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
} = {}) {
  const root = daemonPaths(stateRoot).stateRoot;
  const existing = readyByRoot.get(root);
  if (existing) return existing;
  const pending = daemonSecret(root)
    .then(async (secret) => ({ ...(await startDaemon(root, secret, timeoutMs)), secret }))
    .catch((error) => {
      readyByRoot.delete(root);
      throw error;
    });
  readyByRoot.set(root, pending);
  return pending;
}

export async function callDaemon(method, args = {}, { stateRoot = defaultStateRoot() } = {}) {
  const root = daemonPaths(stateRoot).stateRoot;
  const daemon = await ensureDaemon({ stateRoot: root });
  try {
    return await requestOnce(daemonPaths(root, daemon.secret).endpoint, daemon.secret, method, args);
  } catch (error) {
    if (error.remote) throw error;
    if (method === "start" && error.delivered) {
      throw new Error(
        `The Wiff daemon connection closed after workflow_start was delivered; the launch outcome is unknown. Inspect ${root}/runs or the Wiff viewer before starting another run.`,
        { cause: error },
      );
    }
    readyByRoot.delete(root);
    const restarted = await ensureDaemon({ stateRoot: root });
    try {
      return await requestOnce(
        daemonPaths(root, restarted.secret).endpoint,
        restarted.secret,
        method,
        args,
      );
    } catch (retryError) {
      if (method === "start" && retryError.delivered) {
        throw new Error(
          `The Wiff daemon connection closed after workflow_start was delivered; the launch outcome is unknown. Inspect ${root}/runs or the Wiff viewer before starting another run.`,
          { cause: retryError },
        );
      }
      throw retryError;
    }
  }
}

export async function readDaemonRecord({ stateRoot = defaultStateRoot() } = {}) {
  return JSON.parse(await readFile(daemonPaths(stateRoot).recordPath, "utf8"));
}

export async function stopDaemon({ stateRoot = defaultStateRoot() } = {}) {
  const root = daemonPaths(stateRoot).stateRoot;
  readyByRoot.delete(root);
  const record = await readDaemonRecord({ stateRoot: root }).catch(() => null);
  let secret;
  try {
    secret = await daemonSecret(root, { create: false });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  try {
    await requestOnce(daemonPaths(root, secret).endpoint, secret, "shutdown", {}, 10_000);
  } catch (error) {
    if (error.remote) throw error;
    if (processAlive(record?.pid)) {
      const lock = await readFile(daemonPaths(root).lockPath, "utf8")
        .then((value) => JSON.parse(value))
        .catch(() => null);
      if (lock?.pid !== record.pid || lock?.instanceId !== record.instanceId) return;
      throw new Error(
        `Wiff daemon process ${record.pid} is alive but its authenticated control socket is unavailable.`,
        { cause: error },
      );
    }
    return;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await ping(root, secret, 250);
      await delay(50);
    } catch {
      await waitForProcessExit(record?.pid);
      return;
    }
  }
  throw new Error("Wiff daemon did not stop within 10000ms.");
}
