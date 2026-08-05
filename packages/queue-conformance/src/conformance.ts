import type { ForgeJob, QueuePort } from "@forge/ports";
import { operationKey } from "@forge/ports";
import { afterEach, describe, expect, test } from "vitest";

import {
  CONFORMANCE_EXECUTE,
  CONFORMANCE_RESUME,
  type QueueConformanceHarness,
} from "./harness.js";

/**
 * A memory queue delivers inside `enqueue`; a Redis-backed one delivers on
 * another socket a moment later. Asserting immediately would either pass for
 * the wrong reason or fail for one, so every observation is a poll with a
 * deadline. The deadline is generous, but under Vitest's own, so a hang is
 * reported as the thing that did not happen rather than as "test timed out".
 */
const SETTLE_TIMEOUT_MS = 4_000;
const POLL_INTERVAL_MS = 10;

async function waitFor(
  what: string,
  holds: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    if (await holds()) return;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Proving a negative needs a window rather than an instant: "handled once"
 * would also be true of a second delivery that had not arrived yet.
 */
const QUIET_MS = 250;
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, QUIET_MS));

const execute = (attempt: number): ForgeJob => ({
  ...CONFORMANCE_EXECUTE,
  attempt,
});

export function describeQueueConformance(
  harness: QueueConformanceHarness,
): void {
  describe(`${harness.name} · QueuePort conformance`, () => {
    // Every port the suite opens is closed, or a Redis client keeps the
    // process alive after the assertions have all passed.
    const open: QueuePort[] = [];

    afterEach(async () => {
      await Promise.all(open.splice(0).map((queue) => queue.close()));
    });

    async function create(): Promise<{
      queue: QueuePort;
      peer: () => Promise<QueuePort>;
    }> {
      const handle = await harness.create();
      open.push(handle.queue);
      return {
        queue: handle.queue,
        async peer() {
          const peer = await handle.peer();
          if (peer !== handle.queue) open.push(peer);
          return peer;
        },
      };
    }

    describe("a job reaches a subscriber", () => {
      test("delivers an enqueued job", async () => {
        const { queue } = await create();
        const seen: ForgeJob[] = [];
        await queue.subscribe(async (job) => {
          seen.push(job);
        });
        await queue.enqueue(execute(1));

        await waitFor("the job to be delivered", () => seen.length === 1);
        expect(seen[0]).toEqual(execute(1));
      });

      test("the payload arrives verbatim, not as a vendor job object", async () => {
        // A worker reads `job.runId`. If the transport hands over its own
        // wrapper instead, every consumer starts reaching through it.
        const { queue } = await create();
        const seen: ForgeJob[] = [];
        await queue.subscribe(async (job) => {
          seen.push(job);
        });
        await queue.enqueue(CONFORMANCE_RESUME);

        await waitFor("the resume job", () => seen.length === 1);
        expect(seen[0]).toEqual(CONFORMANCE_RESUME);
      });

      test("work enqueued before a subscriber arrives is not lost", async () => {
        const { queue } = await create();
        await queue.enqueue(execute(1));
        await waitFor("the job to be waiting", async () => {
          return (await queue.depth()) === 1;
        });

        const seen: ForgeJob[] = [];
        await queue.subscribe(async (job) => {
          seen.push(job);
        });

        await waitFor("the backlog to drain", () => seen.length === 1);
      });
    });

    describe("an operation is handled once, however often it is delivered", () => {
      test("the same operation enqueued twice is handled once", async () => {
        const { queue } = await create();
        let handled = 0;
        await queue.subscribe(async () => {
          handled += 1;
        });
        await queue.enqueue(execute(1));
        await queue.enqueue(execute(1));

        await waitFor("the first delivery", () => handled === 1);
        await settle();
        expect(handled).toBe(1);
      });

      test("a duplicate from a second client is still one operation", async () => {
        // The idempotency ledger has to live with the queue, not with the
        // instance that happened to see the job first. Two workers is the
        // normal case, and each one holding its own Set would act twice.
        const { queue, peer } = await create();
        let handled = 0;
        await queue.subscribe(async () => {
          handled += 1;
        });
        await queue.enqueue(execute(1));
        await waitFor("the first delivery", () => handled === 1);

        await (await peer()).enqueue(execute(1));
        await settle();

        expect(handled).toBe(1);
      });

      test("a different attempt is a different operation", async () => {
        const { queue } = await create();
        let handled = 0;
        await queue.subscribe(async () => {
          handled += 1;
        });
        await queue.enqueue(execute(1));
        await queue.enqueue(execute(2));

        await waitFor("both attempts", () => handled === 2);
      });

      test("resume is keyed by approval, so one decision resumes once", async () => {
        const { queue } = await create();
        const seen: ForgeJob[] = [];
        await queue.subscribe(async (job) => {
          seen.push(job);
        });
        await queue.enqueue(CONFORMANCE_RESUME);
        await queue.enqueue({ ...CONFORMANCE_RESUME, attempt: 9 });

        await waitFor("the resume", () => seen.length === 1);
        await settle();
        expect(seen).toHaveLength(1);
      });

      test("a repeat cancel for the same run is one operation", async () => {
        const { queue } = await create();
        let handled = 0;
        await queue.subscribe(async () => {
          handled += 1;
        });
        await queue.enqueue({ type: "workflow.cancel", runId: "run_1" });
        await queue.enqueue({ type: "workflow.cancel", runId: "run_1" });

        await waitFor("the cancel", () => handled === 1);
        await settle();
        expect(handled).toBe(1);
      });
    });

    describe("a caller can correlate and inspect", () => {
      test("enqueue returns the operation key", async () => {
        const { queue } = await create();
        const job: ForgeJob = { type: "workflow.cancel", runId: "run_7" };

        expect(await queue.enqueue(job)).toBe(operationKey(job));
      });

      test("depth reflects work waiting for a subscriber", async () => {
        const { queue } = await create();
        await queue.enqueue(execute(1));
        await queue.enqueue(execute(2));

        await waitFor("both jobs to be waiting", async () => {
          return (await queue.depth()) === 2;
        });
      });

      test("a reachable transport reports itself available", async () => {
        const { queue } = await create();

        expect(await queue.health()).toEqual({ available: true });
      });
    });

    describe("two queues are two queues", () => {
      test("a job enqueued on one queue is not delivered by another", async () => {
        // Guards the suite itself: every test above assumes it starts empty.
        const first = await create();
        const second = await create();
        const seen: ForgeJob[] = [];
        await second.queue.subscribe(async (job) => {
          seen.push(job);
        });
        await first.queue.enqueue(execute(1));
        await settle();

        expect(seen).toEqual([]);
      });

      test("a peer consumer picks up work another client enqueued", async () => {
        // The cross-process case: whoever enqueued is not who runs it.
        const { queue, peer } = await create();
        await queue.enqueue(execute(1));

        const seen: ForgeJob[] = [];
        await (await peer()).subscribe(async (job) => {
          seen.push(job);
        });

        await waitFor("the peer to receive the job", () => seen.length === 1);
        expect(seen[0]).toEqual(execute(1));
      });
    });
  });
}
