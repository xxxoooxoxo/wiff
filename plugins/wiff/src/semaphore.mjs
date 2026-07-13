export class Semaphore {
  #active = 0;
  #queue = [];

  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Semaphore limit must be a positive integer.");
    }
    this.limit = limit;
  }

  async run(task, signal) {
    const release = await this.#acquire(signal);
    try {
      return await task();
    } finally {
      release();
    }
  }

  #acquire(signal) {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("Operation aborted."));
    }
    if (this.#active < this.limit) {
      this.#active += 1;
      return Promise.resolve(() => this.#release());
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: undefined };
      if (signal) {
        entry.onAbort = () => {
          const index = this.#queue.indexOf(entry);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(signal.reason ?? new Error("Operation aborted."));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.#queue.push(entry);
    });
  }

  #release() {
    const next = this.#queue.shift();
    if (!next) {
      this.#active -= 1;
      return;
    }
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener("abort", next.onAbort);
    }
    next.resolve(() => this.#release());
  }
}
