#!/usr/bin/env node
import readline from "node:readline";
import { callDaemon } from "./daemon-client.mjs";
import { serializeError } from "./util.mjs";
import { WIFF_VERSION } from "./version.mjs";

const SERVER_NAME = "wiff";
const CHILD_MODE = process.env.CODEX_WORKFLOW_CHILD === "1";

const tools = [
  {
    name: "workflow_start",
    title: "Start or Resume an Agent Workflow",
    description:
      "Launch a deterministic JavaScript workflow in the background, or resume a previous run without repeating successful unchanged agent calls. User and project preferences are loaded from Wiff config. Always pass the caller's absolute working directory as cwd.",
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
    title: "Read Agent Workflow Status",
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
    title: "Wait for Agent Workflow Progress",
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
    title: "Cancel an Agent Workflow",
    description: "Interrupt all live agents and mark a workflow run cancelled.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "workflow_models",
    title: "List Workflow Agent Models",
    description:
      "List the models each agent backend (codex, claude, cursor, kimi) can run, with supported reasoning efforts. Backends that are unavailable on this machine report an error instead of models.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

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
    run.durable ? "Execution: persistent daemon" : null,
    `Agents: ${run.stats?.completed ?? 0} completed, ${run.stats?.failed ?? 0} failed, ${run.stats?.cached ?? 0} cached, ${run.stats?.queued ?? 0} queued, ${run.stats?.running ?? 0} executing`,
    run.preferenceSources?.length
      ? `Preferences: ${run.preferenceSources.map((source) => source.path).join(", ")}`
      : null,
    run.status === "running" && run.ownerResponsive === false
      ? `Owner: stalled (${Math.round((run.heartbeatAgeMs ?? 0) / 1_000)}s since heartbeat)`
      : null,
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

function summarizeModels(backends) {
  const lines = [];
  for (const [provider, listing] of Object.entries(backends)) {
    if (listing.error) {
      lines.push(`${provider}: unavailable (${listing.error})`);
      continue;
    }
    lines.push(`${provider}:`);
    for (const model of listing.models) {
      const details = [
        model.efforts?.length ? `efforts: ${model.efforts.join("/")}` : null,
        model.isDefault ? "default" : null,
      ].filter(Boolean);
      lines.push(`  ${model.id}${details.length ? ` (${details.join(", ")})` : ""}`);
    }
  }
  return lines.join("\n") || "No backends configured.";
}

async function callTool(name, args) {
  if (CHILD_MODE) throw new Error("Workflow tools are disabled inside workflow child agents.");
  if (name === "workflow_start") return toolResult(await callDaemon("start", args ?? {}));
  if (name === "workflow_status") {
    return toolResult(await callDaemon("status", { runId: args?.runId }));
  }
  if (name === "workflow_wait") {
    return toolResult(
      await callDaemon("wait", {
        runId: args?.runId,
        timeoutMs: args?.timeoutMs ?? 55_000,
      }),
    );
  }
  if (name === "workflow_cancel") {
    return toolResult(await callDaemon("cancel", { runId: args?.runId }));
  }
  if (name === "workflow_models") {
    const backends = await callDaemon("models");
    return {
      content: [{ type: "text", text: summarizeModels(backends) }],
      structuredContent: { backends },
    };
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: WIFF_VERSION },
      instructions: CHILD_MODE
        ? "Workflow tools are intentionally disabled inside workflow child agents to prevent recursive orchestration."
        : "Use workflows for deterministic fan-out, pipelines, and resumable work. Wiff automatically applies user and project preferences from its config files. Runs are owned by a persistent local daemon and survive this MCP bridge disconnecting. After workflow_start, record the run id and call workflow_wait until the run is terminal when the parent remains available. Parallel writes to one checkout must be serialized.",
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

lines.on("close", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
