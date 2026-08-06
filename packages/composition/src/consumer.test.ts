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

/* ========================================================================== */

describe("a notification that did not land is deferred, then given up on", () => {
  /**
   * The one dependency in this system that is expected to be down is somebody
   * else's API. Publishing inline meant a Slack outage lost the notification
   * outright, which is the difference between an operator being told and an
   * operator finding out. It is a queue job now, so it retries like every
   * other piece of work — and it stops, because a queue filling with news
   * nobody wants any more is its own outage.
   */
  const ORIGIN = {
    channel: "slack",
    externalId: "Ev0SYNTHETIC",
    externalActor: "U0SYNTHETIC",
  } as const;

  function publishing(delivered: boolean) {
    const queue = createMemoryQueue();
    const observability = createMemoryObservability();
    const announced: unknown[] = [];
    const enqueued: ForgeJob[] = [];
    const delays: (number | undefined)[] = [];

    // Records what was deferred and how long for, without waiting for it.
    const watched = {
      ...queue,
      async enqueue(job: ForgeJob, options?: { readonly delayMs?: number }) {
        enqueued.push(job);
        delays.push(options?.delayMs);
        // Retries are not actually delivered here: this is about the policy,
        // and a real delay would make the test a stopwatch.
        if (job.type === "connector.publish" && job.attempt > 1) {
          return "held";
        }
        return queue.enqueue(job, options);
      },
    };

    const consumer = createRunConsumer({
      queue: watched,
      host: {
        async execute() {
          return "AWAITING_APPROVAL";
        },
        async resume() {
          return "SUCCEEDED";
        },
        async cancel() {},
      },
      observability,
      progress: {
        announcer: {
          async announce(update) {
            announced.push(update);
            return delivered;
          },
        },
        runs: {
          async load() {
            return {
              record: {
                runId: "run_1",
                workflowId: "acme.brief",
                fingerprint: "sha256:aaa",
                status: "AWAITING_APPROVAL",
                attempt: 1,
                performedEffects: [],
                origin: ORIGIN,
              },
            } as never;
          },
        } as never,
        runUrl: (runId: string) => `https://forge.internal/v1/runs/${runId}`,
      },
    });

    return {
      queue: watched,
      /**
       * Puts a job on the real queue, past the recorder.
       *
       * The recorder swallows retries so the policy can be asserted without a
       * stopwatch — which also means a job seeded *through* it would never be
       * delivered, and every test here would pass by never running the
       * handler at all. That is precisely what happened first time.
       */
      seed: queue.enqueue,
      observability,
      consumer,
      announced,
      enqueued,
      delays,
    };
  }

  test("reaching a gate enqueues a publication rather than making one", async () => {
    // The walk's slot is not held for somebody else's latency.
    const world = publishing(true);
    await world.consumer.start();
    await world.queue.enqueue(execute);

    expect(
      world.enqueued.filter((job) => job.type === "connector.publish"),
    ).toMatchObject([{ runId: "run_1", channel: "slack", attempt: 1 }]);
  });

  test("a publication that lands is not retried", async () => {
    const world = publishing(true);
    await world.consumer.start();
    await world.seed({
      type: "connector.publish",
      runId: "run_1",
      channel: "slack",
      attempt: 1,
    });

    expect(world.announced).toHaveLength(1);
    // Nothing was put back. The seeded job went round the recorder, so
    // anything here would be a retry.
    expect(world.enqueued).toEqual([]);
    expect(names(world.observability)).not.toContain(
      "forge.connector.publish_deferred",
    );
  });

  test("a publication that did not land is deferred, and backs off", async () => {
    const world = publishing(false);
    await world.consumer.start();
    await world.seed({
      type: "connector.publish",
      runId: "run_1",
      channel: "slack",
      attempt: 3,
    });

    const retries = world.enqueued.filter(
      (job) => job.type === "connector.publish" && job.attempt === 4,
    );
    expect(retries).toHaveLength(1);
    // Exponential from a second: a blip is invisible and a real outage backs
    // off to minutes rather than hammering a service already struggling.
    expect(world.delays.at(-1)).toBe(4_000);
    expect(names(world.observability)).toContain(
      "forge.connector.publish_deferred",
    );
  });

  test("it stops, and says that it stopped", async () => {
    /**
     * A queue that retries a notification forever fills with news nobody
     * wants, and a notification quietly abandoned is the kind of thing nobody
     * discovers until they ask why they were never told. So it gives up, and
     * the giving up is an event somebody can count.
     */
    const world = publishing(false);
    await world.consumer.start();
    await world.seed({
      type: "connector.publish",
      runId: "run_1",
      channel: "slack",
      attempt: 6,
    });

    expect(
      world.enqueued.filter(
        (job) => job.type === "connector.publish" && job.attempt > 6,
      ),
    ).toEqual([]);
    expect(names(world.observability)).toContain(
      "forge.connector.publish_abandoned",
    );
  });
});
