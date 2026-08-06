import { type ForgeJob, operationKey, type QueuePort } from "@forge/ports";

/**
 * In-memory queue. Stands in for the BullMQ adapter (ADR-004) and exists to
 * pin the one behaviour that matters at this layer: an operation delivered
 * more than once must only be handled once.
 */
export function createMemoryQueue(): QueuePort {
  const pending: ForgeJob[] = [];
  const handled = new Set<string>();
  let handler: ((job: ForgeJob) => Promise<void>) | undefined;

  async function pump(): Promise<void> {
    if (handler === undefined) return;
    for (let job = pending.shift(); job !== undefined; job = pending.shift()) {
      const key = operationKey(job);
      if (handled.has(key)) continue;
      handled.add(key);
      await handler(job);
    }
  }

  return {
    async enqueue(job, options) {
      const key = operationKey(job);
      if (handled.has(key)) return key;
      if (pending.some((queued) => operationKey(queued) === key)) return key;

      const delayMs = options?.delayMs ?? 0;
      if (delayMs > 0) {
        /**
         * Held, not slept through. The caller gets its promise back
         * immediately, as it would from a transport that can defer — a queue
         * whose `enqueue` blocked for the delay would turn backpressure into
         * a stalled request.
         *
         * `unref` so a pending retry cannot keep a process alive after its
         * work is done, which is the same reason `close()` exists.
         */
        setTimeout(() => {
          pending.push(job);
          void pump();
        }, delayMs).unref();
        return key;
      }

      pending.push(job);
      await pump();
      return key;
    },
    async subscribe(next) {
      handler = next;
      await pump();
    },
    async depth() {
      return pending.length;
    },
    async health() {
      return { available: true };
    },
    async close() {
      // Nothing to release: the queue is the object, and it goes when it goes.
      handler = undefined;
    },
  };
}
