import { createMemoryObservability } from "@forge/observability-memory";
import type { ForgeJob } from "@forge/ports";
import { createMemoryQueue } from "@forge/queue-memory";
import { describe, expect, test } from "vitest";

import { createRunConsumer, type RunHost } from "./consumer.js";

interface Call {
  readonly method: string;
  readonly runId: string;
}

function harness(overrides: Partial<RunHost> = {}) {
  const queue = createMemoryQueue();
  const observability = createMemoryObservability();
  const calls: Call[] = [];
  const host: RunHost = {
    async execute(runId) {
      calls.push({ method: "execute", runId });
      return "AWAITING_APPROVAL";
    },
    async resume(runId) {
      calls.push({ method: "resume", runId });
      return "SUCCEEDED";
    },
    async cancel(runId) {
      calls.push({ method: "cancel", runId });
    },
    ...overrides,
  };
  const consumer = createRunConsumer({ queue, host, observability });
  return { queue, observability, consumer, calls };
}

const execute: ForgeJob = {
  type: "workflow.execute",
  runId: "run_1",
  workflowVersionId: "wf@1.0.0",
  attempt: 1,
};

const resume: ForgeJob = {
  type: "workflow.resume",
  runId: "run_1",
  approvalId: "approval_1",
  attempt: 2,
};

const names = (observability: ReturnType<typeof createMemoryObservability>) =>
  observability.events.map((event) => event.name);

describe("run consumer", () => {
  test("an execute job reaches the host and is recorded", async () => {
    const { queue, consumer, observability, calls } = harness();
    await consumer.start();
    await queue.enqueue(execute);

    expect(consumer.handled).toHaveLength(1);
    expect(calls).toEqual([{ method: "execute", runId: "run_1" }]);
    expect(names(observability)).toContain("forge.worker.executed");
  });

  test("a redelivered job is handled once", async () => {
    const { queue, consumer, calls } = harness();
    await consumer.start();
    await queue.enqueue(execute);
    await queue.enqueue(execute);

    expect(consumer.handled).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  test("the queue drains, so no slot is held after handling", async () => {
    const { queue, consumer } = harness();
    await consumer.start();
    await queue.enqueue(execute);

    expect(await queue.depth()).toBe(0);
  });

  test("a resume job asks the host to resume, naming the decided gate", async () => {
    const { queue, consumer, observability, calls } = harness();
    await consumer.start();
    await queue.enqueue(resume);

    expect(calls).toEqual([{ method: "resume", runId: "run_1" }]);
    expect(names(observability)).toContain("forge.worker.resumed");
  });

  test("a cancel job cancels the run", async () => {
    const { queue, consumer, observability, calls } = harness();
    await consumer.start();
    await queue.enqueue({ type: "workflow.cancel", runId: "run_1" });

    expect(calls).toEqual([{ method: "cancel", runId: "run_1" }]);
    expect(names(observability)).toContain("forge.worker.cancelled");
  });

  test("a job the host cannot service is recorded as failed, not fatal", async () => {
    const { queue, consumer, observability } = harness({
      async cancel() {
        throw new Error("Unknown run.");
      },
    });
    await consumer.start();
    await queue.enqueue({ type: "workflow.cancel", runId: "run_missing" });

    expect(consumer.handled).toHaveLength(1);
    expect(names(observability)).toContain("forge.worker.job_failed");
  });

  test("the consumer keeps working after a failed job", async () => {
    const { queue, consumer, calls } = harness({
      async cancel() {
        throw new Error("Unknown run.");
      },
    });
    await consumer.start();
    await queue.enqueue({ type: "workflow.cancel", runId: "run_missing" });
    await queue.enqueue(execute);

    expect(consumer.handled).toHaveLength(2);
    expect(calls).toEqual([{ method: "execute", runId: "run_1" }]);
  });

  test("resume and execute are distinct operations", async () => {
    const { queue, consumer } = harness();
    await consumer.start();
    await queue.enqueue(execute);
    await queue.enqueue(resume);

    expect(consumer.handled.map((job) => job.type)).toEqual([
      "workflow.execute",
      "workflow.resume",
    ]);
  });
});
