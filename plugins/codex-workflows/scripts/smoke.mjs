import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const pluginDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(pluginDirectory, "src", "server.mjs");
const server = spawn(process.execPath, [serverPath], {
  cwd: pluginDirectory,
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, CODEX_WORKFLOW_CHILD: "0" },
});
const lines = readline.createInterface({ input: server.stdout });
const pending = new Map();
let nextId = 1;
const resumeRunId = process.argv[2];

lines.on("line", (line) => {
  const message = JSON.parse(line);
  const callback = pending.get(message.id);
  if (!callback) return;
  pending.delete(message.id);
  callback(message);
});

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (message) => {
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

const script = `
  export const meta = {
    name: "real-codex-smoke",
    description: "Verify the workflow plugin can run a real structured Codex child",
    phases: [{ title: "Smoke", detail: "Run one read-only child" }],
  };
  phase("Smoke");
  const result = await agent(
    "Return a JSON object confirming the workflow child is operational. Set ok to true and runtime to codex-app-server. Do not use tools.",
    {
      key: "real-smoke",
      label: "real-smoke",
      model: "gpt-5.6-sol",
      effort: "low",
      sandbox: "read-only",
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          runtime: { type: "string" },
        },
        required: ["ok", "runtime"],
        additionalProperties: false,
      },
    },
  );
  return result;
`;

try {
  await request("initialize", { protocolVersion: "2025-11-25" });
  const launched = await request("tools/call", {
    name: "workflow_start",
    arguments: resumeRunId
      ? { resumeFromRunId: resumeRunId }
      : { script, cwd: pluginDirectory },
  });
  if (launched.isError) throw new Error(launched.content?.[0]?.text ?? "Launch failed.");
  let run = launched.structuredContent.run;
  process.stderr.write(`Launched ${run.runId}\n`);
  while (run.status === "running") {
    const waited = await request("tools/call", {
      name: "workflow_wait",
      arguments: { runId: run.runId, timeoutMs: 55_000 },
    });
    if (waited.isError) throw new Error(waited.content?.[0]?.text ?? "Wait failed.");
    run = waited.structuredContent.run;
    process.stderr.write(
      `${run.status}${run.phase ? ` phase=${run.phase}` : ""} completed=${run.stats?.completed ?? 0} failed=${run.stats?.failed ?? 0}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  if (
    run.status !== "completed" ||
    run.result?.ok !== true ||
    (resumeRunId && run.stats?.cached !== 1)
  ) {
    process.exitCode = 1;
  }
} finally {
  server.stdin.end();
  await new Promise((resolve) => server.once("exit", resolve));
}
