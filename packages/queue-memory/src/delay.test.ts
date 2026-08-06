import type { ForgeJob } from "@forge/ports";
import { describe, expect, test } from "vitest";

import { createMemoryQueue } from "./queue.js";

/**
 * Holding work back, which is what makes a retry policy a policy rather than
 * a spin.
 *
 * A publication that failed is re-enqueued with a delay; without one, the
 * third party that just refused is refusing still and the retry is a tight
 * loop against a service already struggling. The transport holds the job,
 * because holding work is a transport's job and not a caller's to sleep
 * through.
 */

const job = (attempt: number): ForgeJob => ({
  type: "connector.publish",
  runId: "run_1",
  channel: "slack",
  attempt,
});

describe("a delayed job is held, not slept through", () => {
  test("it is not delivered immediately, and is delivered later", async () => {
    const queue = createMemoryQueue();
    const seen: number[] = [];
    await queue.subscribe(async (delivered) => {
      if (delivered.type === "connector.publish") seen.push(delivered.attempt);
    });

    await queue.enqueue(job(2), { delayMs: 40 });
    // The point of the delay: nothing yet.
    expect(seen).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(seen).toEqual([2]);
  });

  test("enqueue returns before the delay elapses", async () => {
    /**
     * A queue whose `enqueue` blocked for the delay would turn backpressure
     * into a stalled request — the caller would wait out the retry it was
     * trying to defer.
     */
    const queue = createMemoryQueue();
    await queue.subscribe(async () => {});

    const started = Date.now();
    await queue.enqueue(job(3), { delayMs: 5_000 });

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("no delay is still immediate", async () => {
    // Guards the tests above: a queue that deferred everything would pass
    // "not delivered immediately" and would break every other job in Forge.
    const queue = createMemoryQueue();
    const seen: string[] = [];
    await queue.subscribe(async (delivered) => {
      seen.push(delivered.type);
    });

    await queue.enqueue(job(1));

    expect(seen).toEqual(["connector.publish"]);
  });
});
