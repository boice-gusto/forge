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

    test("health and close answer rather than hanging when Redis is gone", async () => {
      // The producer runs with `maxRetriesPerRequest: null` so an enqueue
      // survives a blip, which means a command issued while Redis is gone
      // buffers instead of rejecting. Unbounded, that turns a readiness probe
      // into a hang, and a load balancer reading a timeout is worse off than
      // one reading a 503.
      const queue = createBullMqQueue({
        // A port nothing listens on: the client keeps trying, forever.
        url: "redis://127.0.0.1:1",
        name: "forge-edges-timeout",
      });

      const probed = Date.now();
      expect(await queue.health()).toEqual({ available: false });
      expect(Date.now() - probed).toBeLessThan(4_000);

      // And the shutdown path, which hangs for the same reason and costs more
      // when it does: a worker draining on SIGTERM against a dead Redis waits
      // for a handshake nobody will complete, and is SIGKILLed mid-flush.
      const draining = Date.now();
      await queue.close();
      expect(Date.now() - draining).toBeLessThan(8_000);
    }, 20_000);
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
