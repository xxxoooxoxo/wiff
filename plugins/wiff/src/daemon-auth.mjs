import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { daemonPaths, defaultStateRoot } from "./state.mjs";
import { ensureDir, writeExclusiveFile } from "./util.mjs";

const SECRET_PATTERN = /^[0-9a-f]{64}$/;

export async function daemonSecret(stateRoot = defaultStateRoot(), { create = true } = {}) {
  const paths = daemonPaths(stateRoot);
  await ensureDir(paths.controlDirectory);
  await chmod(paths.controlDirectory, 0o700);
  try {
    const value = (await readFile(paths.secretPath, "utf8")).trim();
    if (!SECRET_PATTERN.test(value)) throw new Error("Wiff daemon secret is malformed.");
    await chmod(paths.secretPath, 0o600);
    return value;
  } catch (error) {
    if (error?.code !== "ENOENT" || !create) throw error;
  }

  const candidate = randomBytes(32).toString("hex");
  await writeExclusiveFile(paths.secretPath, `${candidate}\n`, 0o600);
  return daemonSecret(paths.stateRoot, { create: false });
}

export function daemonProof(secret, label, nonce) {
  return createHmac("sha256", secret).update(`${label}:${nonce}`).digest("hex");
}

export function daemonOwnershipPort(secret, stateRoot) {
  const digest = createHmac("sha256", secret).update(`owner:${stateRoot}`).digest();
  return 20_000 + (digest.readUInt32BE(0) % 10_000);
}

export function verifyDaemonProof(secret, label, nonce, proof) {
  if (typeof proof !== "string" || !/^[0-9a-f]{64}$/.test(proof)) return false;
  const expected = Buffer.from(daemonProof(secret, label, nonce), "hex");
  const supplied = Buffer.from(proof, "hex");
  return timingSafeEqual(expected, supplied);
}
