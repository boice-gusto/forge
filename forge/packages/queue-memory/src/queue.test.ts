import { describe, expect, test } from "vitest";

import { createMemoryQueue } from "./queue.js";

describe("memory queue", () => {
  test("deduplicates an operation key and acknowledges exactly one delivery", async () => {
    const queue = createMemoryQueue();
    await queue.enqueue({
      type: "workflow.execute",
      runId: "run_123",
      operationKey: "run_123:execute:1",
    });
    await queue.enqueue({
      type: "workflow.execute",
      runId: "run_123",
      operationKey: "run_123:execute:1",
    });

    const delivered: string[] = [];
    await queue.drain(async (job) => {
      delivered.push(job.operationKey);
    });

    expect(delivered).toEqual(["run_123:execute:1"]);
    expect(await queue.size()).toBe(0);
  });
});
