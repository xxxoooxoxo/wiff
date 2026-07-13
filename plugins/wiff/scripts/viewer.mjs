#!/usr/bin/env node
// Local read-only viewer for wiff runs.
// Usage: node scripts/viewer.mjs [--port 4979] [--root <state root>]
import { createServer } from "node:http";
import { open, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HTML_PATH = fileURLToPath(new URL("./viewer.html", import.meta.url));

function defaultStateRoot() {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return process.env.CODEX_WORKFLOW_HOME ?? path.join(codexHome, "workflows");
}

function parseArgs(argv) {
  const args = { port: 4979, root: defaultStateRoot() };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--port") args.port = Number(argv[++index]);
    else if (argv[index] === "--root") args.root = path.resolve(argv[++index]);
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error(`Invalid --port: ${args.port}`);
  }
  return args;
}

const { port, root } = parseArgs(process.argv.slice(2));
const runsDirectory = path.join(root, "runs");

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function parseJsonlText(text) {
  const events = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip torn tail lines while the writer is mid-append.
    }
  }
  return events;
}

async function readJsonl(filePath) {
  try {
    return parseJsonlText(await readFile(filePath, "utf8"));
  } catch {
    return [];
  }
}

// Read only the last maxBytes of a (possibly huge) transcript.
async function readTailEvents(filePath, maxBytes = 64 * 1024) {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return [];
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return parseJsonlText(text);
  } finally {
    await handle.close();
  }
}

// Turn one transcript notification into a human "now doing" line.
function describeEvent(entry) {
  const event = entry?.event;
  const item = event?.params?.item;
  if (!item) return null;
  const clip = (value, max = 220) => String(value).replace(/\s+/g, " ").trim().slice(0, max);
  if (item.type === "commandExecution" && item.command) {
    return { kind: "exec", text: `$ ${clip(item.command)}` };
  }
  if (item.type === "fileChange") {
    const files = (item.changes ?? []).map((change) => change.path?.split("/").pop()).filter(Boolean);
    if (files.length) {
      return {
        kind: "edit",
        text: `editing ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` +${files.length - 3} more` : ""}`,
      };
    }
  }
  if (item.type === "reasoning") {
    const text = item.summary_text ?? item.text;
    if (text) return { kind: "thinking", text: clip(text) };
  }
  if (item.type === "agentMessage" && item.text) {
    return { kind: "message", text: clip(item.text) };
  }
  if (item.type === "webSearch" && item.query) {
    return { kind: "search", text: `searching: ${clip(item.query)}` };
  }
  if ((item.type === "mcpToolCall" || item.type === "toolCall") && (item.tool ?? item.name)) {
    return { kind: "tool", text: `tool: ${item.tool ?? item.name}` };
  }
  return null;
}

function extractActivity(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const described = describeEvent(events[index]);
    if (described) return { ...described, at: events[index].at };
  }
  return null;
}

// Agents that have started but not completed/failed, per the journal.
function deriveRunningAgents(journal) {
  const running = new Map();
  for (const event of journal) {
    if (event.type === "agent.started") {
      running.set(event.key, {
        key: event.key,
        label: event.label ?? event.key,
        phase: event.phase ?? "default",
        startedAt: event.at,
        transcriptPath: event.transcriptPath,
        options: event.options ?? {},
      });
    } else if (event.type === "agent.completed" || event.type === "agent.failed") {
      running.delete(event.key);
    }
  }
  return [...running.values()];
}

async function attachActivity(agents) {
  return Promise.all(
    agents.map(async (agent) => ({
      ...agent,
      activity: agent.transcriptPath ? extractActivity(await readTailEvents(agent.transcriptPath)) : null,
    })),
  );
}

// A run.json can say "running" after its owner died; report the truth.
function withLiveness(run) {
  const stale = run.status === "running" && !isProcessAlive(run.ownerPid);
  return { ...run, status: stale ? "interrupted" : run.status, ownerAlive: !stale };
}

async function listRuns() {
  let entries;
  try {
    entries = await readdir(runsDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("wf_")) continue;
    try {
      const run = JSON.parse(
        await readFile(path.join(runsDirectory, entry.name, "run.json"), "utf8"),
      );
      const { runId, status, name, description, phase, stats, startedAt, completedAt, revision, attempt, ownerPid } = run;
      runs.push(
        withLiveness({ runId, status, name, description, phase, stats, startedAt, completedAt, revision, attempt, ownerPid }),
      );
    } catch {
      // Ignore torn or foreign directories.
    }
  }
  runs.sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)));
  return runs;
}

function runDirectoryFor(runId) {
  if (!/^wf_[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid run id.");
  return path.join(runsDirectory, runId);
}

async function getRun(runId) {
  const directory = runDirectoryFor(runId);
  const run = withLiveness(JSON.parse(await readFile(path.join(directory, "run.json"), "utf8")));
  const journal = await readJsonl(path.join(directory, "journal.jsonl"));
  const activity = {};
  if (run.status === "running") {
    for (const agent of await attachActivity(deriveRunningAgents(journal))) {
      activity[agent.key] = agent.activity;
    }
  }
  return { run, journal, activity };
}

// Every running agent across every live run, with what it is doing right now.
async function getActiveAgents() {
  const active = [];
  for (const run of await listRuns()) {
    if (run.status !== "running") continue;
    const journal = await readJsonl(path.join(runDirectoryFor(run.runId), "journal.jsonl"));
    for (const agent of await attachActivity(deriveRunningAgents(journal))) {
      active.push({
        runId: run.runId,
        runName: run.name ?? run.runId,
        key: agent.key,
        label: agent.label,
        phase: agent.phase,
        startedAt: agent.startedAt,
        model: agent.options.model,
        activity: agent.activity,
      });
    }
  }
  active.sort((left, right) => String(left.startedAt).localeCompare(String(right.startedAt)));
  return active;
}

async function getTranscript(runId, fileName) {
  const directory = runDirectoryFor(runId);
  if (!/^[a-zA-Z0-9._-]+\.jsonl$/.test(fileName)) throw new Error("Invalid transcript name.");
  const filePath = path.join(directory, "agents", fileName);
  const info = await stat(filePath);
  const events = await readTailEvents(filePath, 512 * 1024);
  return { fileName, size: info.size, events: events.slice(-200) };
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(await readFile(HTML_PATH, "utf8"));
      return;
    }
    if (url.pathname === "/api/runs") {
      sendJson(response, 200, { root, runs: await listRuns() });
      return;
    }
    if (url.pathname === "/api/active") {
      sendJson(response, 200, { agents: await getActiveAgents() });
      return;
    }
    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
    if (runMatch) {
      sendJson(response, 200, await getRun(runMatch[1]));
      return;
    }
    const transcriptMatch = /^\/api\/runs\/([^/]+)\/transcripts\/([^/]+)$/.exec(url.pathname);
    if (transcriptMatch) {
      sendJson(response, 200, await getTranscript(transcriptMatch[1], transcriptMatch[2]));
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, error?.code === "ENOENT" ? 404 : 500, { error: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`wiff viewer: http://127.0.0.1:${port} (runs: ${runsDirectory})\n`);
});
