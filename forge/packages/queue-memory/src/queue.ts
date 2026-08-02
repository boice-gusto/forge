export interface MemoryQueueJob {
  readonly type: "workflow.execute" | "workflow.resume";
  readonly runId: string;
  readonly operationKey: string;
}

export interface MemoryQueue {
  enqueue(job: MemoryQueueJob): Promise<void>;
  drain(handler: (job: MemoryQueueJob) => Promise<void>): Promise<void>;
  size(): Promise<number>;
}

export function createMemoryQueue(): MemoryQueue {
  const pending: MemoryQueueJob[] = [];
  const delivered = new Set<string>();

  return {
    async enqueue(job) {
      if (
        delivered.has(job.operationKey) ||
        pending.some((queued) => queued.operationKey === job.operationKey)
      ) {
        return;
      }
      pending.push(job);
    },
    async drain(handler) {
      while (pending.length > 0) {
        const job = pending.shift();
        if (job === undefined || delivered.has(job.operationKey)) continue;
        await handler(job);
        delivered.add(job.operationKey);
      }
    },
    async size() {
      return pending.length;
    },
  };
}
