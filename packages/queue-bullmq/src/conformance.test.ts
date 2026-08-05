import { describeQueueConformance } from "@forge/queue-conformance";
import { containerRuntimeAvailable } from "@forge/store-conformance";
import type { StartedRedisContainer } from "@testcontainers/redis";
import { RedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createBullMqQueue } from "./queue.js";

const REDIS_IMAGE = "redis:7-alpine";
/** A cold image pull is slow; a hung container should still fail, not wait. */
const CONTAINER_START_TIMEOUT_MS = 240_000;

// The same probe the durable-store suites use, for the same reason: asking
// Testcontainers whether *it* can connect, rather than whether the CLI can.
const dockerAvailable = await containerRuntimeAvailable("queue-bullmq");

describe.skipIf(!dockerAvailable)("queue-bullmq", () => {
  let container: StartedRedisContainer;
  let queues = 0;

  beforeAll(async () => {
    container = await new RedisContainer(REDIS_IMAGE).start();
  }, CONTAINER_START_TIMEOUT_MS);

  afterAll(async () => {
    await container?.stop();
  });

  describe("the adapter's own edges", () => {
    test("subscribing twice is refused rather than silently replacing", async () => {
      // Two handlers on one adapter would mean whichever registered last
      // silently owned every job, and the first would never fire again.
      const queue = createBullMqQueue({
        url: container.getConnectionUrl(),
        name: "forge-edges-subscribe",
      });
      await queue.subscribe(async () => {});

      await expect(queue.subscribe(async () => {})).rejects.toThrow(
        "FORGE_QUEUE_ALREADY_SUBSCRIBED",
      );
      await queue.close();
    });

    test("a closed transport reports itself unavailable", async () => {
      // Health is a report, and reporting "available" from a client that can
      // no longer reach Redis would keep a dead worker in the pool.
      const queue = createBullMqQueue({
        url: container.getConnectionUrl(),
        name: "forge-edges-health",
      });
      await queue.close();

      expect(await queue.health()).toEqual({ available: false });
    });
  });

  describeQueueConformance({
    name: "queue-bullmq",
    async create() {
      // Each queue gets its own name, so "an empty queue" means the same
      // thing here as a new array does for the memory adapter.
      queues += 1;
      const name = `forge-conformance-${queues}`;
      const url = container.getConnectionUrl();

      return {
        queue: createBullMqQueue({ url, name }),
        // A second client onto the same Redis queue shares nothing but Redis,
        // which is exactly what a second worker process has.
        async peer() {
          return createBullMqQueue({ url, name });
        },
      };
    },
  });
});
