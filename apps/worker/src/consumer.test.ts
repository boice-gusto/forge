import { createLocalStack } from "@forge/composition";
import { createMemoryObservability } from "@forge/observability-memory";
import type { ForgeJob } from "@forge/ports";
import { createMemoryQueue } from "@forge/queue-memory";
import { describe, expect, test } from "vitest";

import { createWorkerConsumer } from "./consumer.js";

function harness() {
  const queue = createMemoryQueue();
  const stack = createLocalStack();
  const observability = createMemoryObservability();
  const consumer = createWorkerConsumer({ queue, stack, observability });
  return { queue, stack, observability, consumer };
}

const execute: ForgeJob = {
  type: "workflow.execute",
  runId: "run_1",
  workflowVersionId: "wf@1.0.0",
  attempt: 1,
};

describe("worker consumer", () => {
  test("handles an execute job and records it", async () => {
    const { queue, consumer, observability } = harness();
    await consumer.start();
    await queue.enqueue(execute);

    expect(consumer.handled).toHaveLength(1);
    expect(observability.events.map((event) => event.name)).toContain(
      "forge.worker.job",
    );
  });

  test("a redelivered job is handled once", async () => {
    const { queue, consumer } = harness();
    await consumer.start();
    await queue.enqueue(execute);
    await queue.enqueue(execute);

    expect(consumer.handled).toHaveLength(1);
  });

  test("the queue drains, so no slot is held after handling", async () => {
    const { queue, consumer } = harness();
    await consumer.start();
    await queue.enqueue(execute);

    expect(await queue.depth()).toBe(0);
  });

  test("a job for an unknown run is recorded as failed, not fatal", async () => {
    const { queue, consumer, observability } = harness();
    await consumer.start();
    await queue.enqueue({ type: "workflow.cancel", runId: "run_missing" });

    expect(consumer.handled).toHaveLength(1);
    expect(observability.events.map((event) => event.name)).toContain(
      "forge.worker.job_failed",
    );
  });

  test("the consumer keeps working after a failed job", async () => {
    const { queue, consumer } = harness();
    await consumer.start();
    await queue.enqueue({ type: "workflow.cancel", runId: "run_missing" });
    await queue.enqueue(execute);

    expect(consumer.handled).toHaveLength(2);
  });

  test("resume and execute are distinct operations", async () => {
    const { queue, consumer } = harness();
    await consumer.start();
    await queue.enqueue(execute);
    await queue.enqueue({
      type: "workflow.resume",
      runId: "run_1",
      approvalId: "approval_1",
      attempt: 2,
    });

    expect(consumer.handled.map((job) => job.type)).toEqual([
      "workflow.execute",
      "workflow.resume",
    ]);
  });
});
