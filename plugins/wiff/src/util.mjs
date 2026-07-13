import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { name: "Error", message: String(error) };
}

export function jsonClone(value, label = "value") {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} must be JSON-serializable: ${error.message}`);
  }
  if (encoded === undefined) {
    throw new Error(`${label} must be a JSON value.`);
  }
  return JSON.parse(encoded);
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(sortJson(jsonClone(value)));
}

export function hashValue(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function ensureDir(directory) {
  await mkdir(directory, { recursive: true });
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function atomicWriteJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

export async function appendJsonl(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export async function readJsonl(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

export function safeFilename(value) {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || "agent").slice(0, 120);
}

export function createRunId() {
  return `wf_${randomUUID()}`;
}

export function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export class JsonlWriter {
  #queue = Promise.resolve();

  constructor(filePath) {
    this.filePath = filePath;
  }

  append(value) {
    this.#queue = this.#queue.then(() => appendJsonl(this.filePath, value));
    this.#queue.catch(() => {});
    return this.#queue;
  }

  flush() {
    return this.#queue;
  }
}
