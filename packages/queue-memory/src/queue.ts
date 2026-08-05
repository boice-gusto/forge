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
    async enqueue(job) {
      const key = operationKey(job);
      if (handled.has(key)) return key;
      if (pending.some((queued) => operationKey(queued) === key)) return key;
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
