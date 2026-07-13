#!/usr/bin/env node
import readline from "node:readline";
import { WorkflowManager } from "./runtime.mjs";
import { serializeError } from "./util.mjs";

const SERVER_NAME = "wiff";
const SERVER_VERSION = "0.3.0";
const CHILD_MODE = process.env.CODEX_WORKFLOW_CHILD === "1";

const tools = [
  {
    name: "workflow_start",
    title: "Start or Resume a Codex Workflow",
    description:
      "Launch a deterministic JavaScript workflow in the background, or resume a previous run without repeating successful unchanged agent calls. Always pass the caller's absolute working directory as cwd.",
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description: "Inline workflow JavaScript. Mutually exclusive with scriptPath.",
        },
        scriptPath: {
          type: "string",
          description: "Absolute path or cwd-relative path to workflow JavaScript.",
        },
        args: {
          description: "JSON input exposed to the workflow as the global args value.",
        },
        cwd: {
          type: "string",
          description: "Absolute working directory inherited by workflow agents.",
        },
        resumeFromRunId: {
          type: "string",
          description: "Existing run id to resume. Script and args default to the stored values.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "workflow_status",
    title: "Read Codex Workflow Status",
    description: "Read the latest persisted status, phase, counters, result, and artifact paths for a workflow run.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "workflow_wait",
    title: "Wait for Codex Workflow Progress",
    description:
      "Wait until a workflow changes state or the timeout elapses. Call repeatedly until the run is completed, failed, cancelled, or interrupted.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        timeoutMs: {
          type: "integer",
          minimum: 0,
          maximum: 55000,
          default: 55000,
        },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "workflow_cancel",
    title: "Cancel a Codex Workflow",
    description: "Interrupt all live agents and mark a workflow run cancelled.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
];

const manager = CHILD_MODE ? null : new WorkflowManager();
if (manager) await manager.initialize();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function summarizeRun(run) {
  const lines = [
    `Workflow ${run.runId}: ${run.status}`,
    run.name ? `Name: ${run.name}` : null,
    run.phase ? `Phase: ${run.phase}` : null,
    `Agents: ${run.stats?.completed ?? 0} completed, ${run.stats?.failed ?? 0} failed, ${run.stats?.cached ?? 0} cached, ${run.stats?.running ?? 0} running`,
    `Run record: ${run.runPath}`,
    `Journal: ${run.journalPath}`,
  ].filter(Boolean);
  if (run.error?.message) lines.push(`Error: ${run.error.message}`);
  return lines.join("\n");
}

function toolResult(run) {
  return {
    content: [{ type: "text", text: summarizeRun(run) }],
    structuredContent: { run },
  };
}

async function callTool(name, args) {
  if (!manager) throw new Error("Workflow tools are disabled inside workflow child agents.");
  if (name === "workflow_start") return toolResult(await manager.start(args ?? {}));
  if (name === "workflow_status") return toolResult(await manager.status(args?.runId));
  if (name === "workflow_wait") {
    return toolResult(await manager.wait(args?.runId, args?.timeoutMs ?? 55_000));
  }
  if (name === "workflow_cancel") return toolResult(await manager.cancel(args?.runId));
  throw new Error(`Unknown tool: ${name}`);
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: CHILD_MODE
        ? "Workflow tools are intentionally disabled inside workflow child agents to prevent recursive orchestration."
        : "Use workflows for deterministic fan-out, pipelines, and resumable work. After workflow_start, call workflow_wait until the run is terminal. Parallel writes to one checkout must be serialized.",
    });
    return;
  }
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (method === "tools/list") {
    sendResult(id, { tools: CHILD_MODE ? [] : tools });
    return;
  }
  if (method === "tools/call") {
    try {
      sendResult(id, await callTool(params?.name, params?.arguments));
    } catch (error) {
      sendResult(id, {
        isError: true,
        content: [{ type: "text", text: serializeError(error).message }],
      });
    }
    return;
  }
  if (id !== undefined) sendError(id, -32601, `Method not found: ${method}`);
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    sendError(null, -32700, "Parse error");
    return;
  }
  handleRequest(message).catch((error) => {
    if (message.id !== undefined) sendError(message.id, -32603, serializeError(error).message);
  });
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await manager?.close();
}

lines.on("close", () => close().finally(() => process.exit(0)));
process.on("SIGINT", () => close().finally(() => process.exit(0)));
process.on("SIGTERM", () => close().finally(() => process.exit(0)));
