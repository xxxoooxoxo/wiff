import { appendFileSync } from "node:fs";

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export function createBackend() {
  if (process.env.WIFF_DAEMON_BACKEND_COUNTER_FILE) {
    appendFileSync(process.env.WIFF_DAEMON_BACKEND_COUNTER_FILE, `${process.pid}\n`);
  }
  return {
    async runAgent({ prompt, options, signal, onEvent }) {
      onEvent?.({ method: "fake/started", params: { prompt } });
      if (prompt.startsWith("DELAY:")) {
        await wait(Number(prompt.slice("DELAY:".length)), signal);
      }
      if (prompt.startsWith("IGNORE-ABORT:")) {
        await new Promise((resolve) =>
          setTimeout(resolve, Number(prompt.slice("IGNORE-ABORT:".length))),
        );
      }
      onEvent?.({ method: "fake/completed", params: { prompt } });
      return {
        result: options.schema ? { ok: true } : `result:${prompt}`,
        threadId: `daemon-thread-${process.pid}`,
        turnId: `daemon-turn-${process.pid}`,
        usage: { total: { totalTokens: 1 } },
      };
    },
    async listModels() {
      return [{ id: "fake-daemon", isDefault: true }];
    },
    async close() {},
  };
}
