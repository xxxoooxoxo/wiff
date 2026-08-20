import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function normalizedStateRoot(stateRoot) {
  const resolved = path.resolve(stateRoot);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function defaultStateRoot() {
  return (
    process.env.WIFF_HOME ??
    process.env.CODEX_WORKFLOW_HOME ??
    path.join(os.homedir(), ".wiff")
  );
}

export function daemonEndpoint(stateRoot = defaultStateRoot(), endpointSecret = "") {
  const normalizedRoot = normalizedStateRoot(stateRoot);
  const digest = createHash("sha256")
    .update(`${normalizedRoot}\0${endpointSecret}`)
    .digest("hex")
    .slice(0, 24);
  if (process.platform === "win32") return `\\\\.\\pipe\\wiff-${digest}`;
  const privateEndpoint = path.join(normalizedRoot, "control", "daemon.sock");
  if (Buffer.byteLength(privateEndpoint, "utf8") <= 90) return privateEndpoint;
  const user = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `wiff-${user}-${digest}`, "daemon.sock");
}

export function daemonPaths(stateRoot = defaultStateRoot(), endpointSecret = "") {
  const normalizedRoot = normalizedStateRoot(stateRoot);
  const controlDirectory = path.join(normalizedRoot, "control");
  return {
    stateRoot: normalizedRoot,
    controlDirectory,
    endpoint: daemonEndpoint(stateRoot, endpointSecret),
    lockPath: path.join(controlDirectory, "daemon.lock"),
    secretPath: path.join(controlDirectory, "daemon.secret"),
    recordPath: path.join(normalizedRoot, "daemon.json"),
    logPath: path.join(normalizedRoot, "daemon.log"),
  };
}
