import vm from "node:vm";
import { isPlainObject, jsonClone, serializeError } from "./util.mjs";
import { wrapWorkflowSource } from "./workflow-source.mjs";

const pendingAgents = new Map();
let requestSequence = 0;
let currentPhase = "default";

function send(message) {
  if (process.connected) process.send(message);
}

function validateMetaJson(payload) {
  const meta = JSON.parse(payload);
  if (!isPlainObject(meta)) throw new Error("meta must be an object.");
  if (typeof meta.name !== "string" || !meta.name.trim()) {
    throw new Error("meta.name must be a non-empty string.");
  }
  if (typeof meta.description !== "string" || !meta.description.trim()) {
    throw new Error("meta.description must be a non-empty string.");
  }
  if (meta.phases !== undefined && !Array.isArray(meta.phases)) {
    throw new Error("meta.phases must be an array when provided.");
  }
  send({ type: "meta", meta });
  return JSON.stringify(meta);
}

function requestAgent(payload) {
  const [prompt, options = {}] = JSON.parse(payload);
  if (typeof prompt !== "string" || !prompt.trim()) {
    return Promise.reject(new Error("agent prompt must be a non-empty string."));
  }
  if (!isPlainObject(options)) {
    return Promise.reject(new Error("agent options must be an object."));
  }
  const id = `agent-${++requestSequence}`;
  return new Promise((resolve, reject) => {
    pendingAgents.set(id, { resolve, reject });
    send({
      type: "agent.request",
      id,
      sequence: requestSequence,
      phase: currentPhase,
      prompt,
      options,
    });
  });
}

function setPhase(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("phase name must be a non-empty string.");
  }
  currentPhase = name.trim();
  send({ type: "phase", name: currentPhase });
}

function writeLog(payload) {
  send({ type: "log", value: JSON.parse(payload) });
}

const BOOTSTRAP_SOURCE = `
  (() => {
    "use strict";
    const bridge = globalThis.__hostBridge;
    const argsJson = globalThis.__argsJson;
    delete globalThis.__hostBridge;
    delete globalThis.__argsJson;

    const deepFreeze = (value) => {
      if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
      }
      return value;
    };
    const isObject = (value) =>
      value !== null && typeof value === "object" && !Array.isArray(value);
    const errorRecord = (error) => ({
      name: error?.name ?? "Error",
      message: error?.message ?? String(error),
      stack: error?.stack,
    });
    const normalizeConcurrency = (options, count) => {
      const raw = (options?.concurrency ?? count) || 1;
      if (!Number.isInteger(raw) || raw < 1) {
        throw new Error("concurrency must be a positive integer.");
      }
      return Math.min(raw, Math.max(count, 1));
    };
    const runPool = async (thunks, options, settled) => {
      if (!Array.isArray(thunks) || thunks.some((entry) => typeof entry !== "function")) {
        throw new Error("parallel expects an array of zero-argument functions.");
      }
      const results = new Array(thunks.length);
      const failures = [];
      let nextIndex = 0;
      const runNext = async () => {
        while (nextIndex < thunks.length) {
          const index = nextIndex++;
          try {
            const value = await thunks[index]();
            results[index] = settled ? { status: "fulfilled", value } : value;
          } catch (error) {
            if (settled) results[index] = { status: "rejected", reason: errorRecord(error) };
            else failures.push({ index, error });
          }
        }
      };
      await Promise.all(
        Array.from({ length: normalizeConcurrency(options, thunks.length) }, runNext),
      );
      if (failures.length > 0) {
        failures.sort((left, right) => left.index - right.index);
        throw new AggregateError(
          failures.map(({ error }) => error),
          failures.length + " parallel task(s) failed.",
        );
      }
      return results;
    };

    const agent = async (prompt, options = {}) =>
      JSON.parse(await bridge.agent(JSON.stringify([prompt, options])));
    const parallel = (thunks, options = {}) => runPool(thunks, options, false);
    const parallelSettled = (thunks, options = {}) => runPool(thunks, options, true);
    const pipeline = (items, ...rest) => {
      if (!Array.isArray(items)) throw new Error("pipeline items must be an array.");
      let options = {};
      if (rest.length > 0 && isObject(rest.at(-1))) options = rest.pop();
      const stages = rest;
      if (stages.length === 0 || stages.some((stage) => typeof stage !== "function")) {
        throw new Error("pipeline requires at least one stage function.");
      }
      return parallel(
        items.map((original, index) => async () => {
          let value = original;
          for (const stage of stages) value = await stage(value, original, index);
          return value;
        }),
        options,
      );
    };
    const phase = (name) => bridge.phase(name);
    const log = (value) => bridge.log(JSON.stringify(value));
    const setMeta = (value) => JSON.parse(bridge.setMeta(JSON.stringify(value)));

    const NativeDate = Date;
    class DeterministicDate {
      constructor() {
        throw new Error("Date is unavailable in deterministic workflow scripts.");
      }
      static now() {
        throw new Error("Date.now is unavailable in deterministic workflow scripts.");
      }
      static parse(value) {
        return NativeDate.parse(value);
      }
      static UTC(...values) {
        return NativeDate.UTC(...values);
      }
    }
    Object.defineProperty(Math, "random", {
      value: () => {
        throw new Error("Math.random is unavailable in deterministic workflow scripts.");
      },
      writable: false,
      configurable: false,
    });
    Object.freeze(Math);

    Object.defineProperties(globalThis, {
      args: { value: deepFreeze(JSON.parse(argsJson)), writable: false, configurable: false },
      agent: { value: agent, writable: false, configurable: false },
      parallel: { value: parallel, writable: false, configurable: false },
      parallelSettled: { value: parallelSettled, writable: false, configurable: false },
      pipeline: { value: pipeline, writable: false, configurable: false },
      phase: { value: phase, writable: false, configurable: false },
      log: { value: log, writable: false, configurable: false },
      __setMeta: { value: setMeta, writable: false, configurable: false },
      Date: { value: DeterministicDate, writable: false, configurable: false },
      Intl: { value: undefined, writable: false, configurable: false },
      Temporal: { value: undefined, writable: false, configurable: false },
      console: { value: undefined, writable: false, configurable: false },
    });
  })();
`;

async function execute({ source, args }) {
  const bridge = Object.freeze({
    agent: requestAgent,
    phase: setPhase,
    log: writeLog,
    setMeta: validateMetaJson,
  });
  const context = vm.createContext(
    {
      __hostBridge: bridge,
      __argsJson: JSON.stringify(jsonClone(args ?? null, "args")),
    },
    {
      name: "codex-workflow",
      codeGeneration: { strings: false, wasm: false },
    },
  );
  new vm.Script(BOOTSTRAP_SOURCE, { filename: "workflow-bootstrap.js" }).runInContext(
    context,
    { timeout: 1_000 },
  );
  const script = new vm.Script(wrapWorkflowSource(source), { filename: "workflow.js" });
  const result = await script.runInContext(context, { timeout: 1_000 });
  send({ type: "done", result: jsonClone(result, "workflow result") });
}

process.on("message", (message) => {
  if (message?.type === "start") {
    execute(message).catch((error) => {
      send({ type: "failed", error: serializeError(error) });
    });
    return;
  }
  if (message?.type === "agent.response") {
    const pending = pendingAgents.get(message.id);
    if (!pending) return;
    pendingAgents.delete(message.id);
    if (message.ok) pending.resolve(JSON.stringify(message.value));
    else {
      const error = new Error(message.error?.message ?? "Agent failed.");
      error.name = message.error?.name ?? "AgentError";
      if (message.error?.stack) error.stack = message.error.stack;
      pending.reject(error);
    }
  }
});

process.on("disconnect", () => process.exit(1));
