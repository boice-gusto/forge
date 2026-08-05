import { createDurableStack } from "@forge/composition/durable";

import { createWorkerConsumer, type RunHost } from "./consumer.js";
import { startWorker } from "./main.js";

/**
 * The worker process.
 *
 * Until now this started a health endpoint and nothing else: the consumer and
 * the durable stack existed but only ever met inside a test, so the binary
 * answered `/health/ready` while consuming no jobs at all. A green probe on a
 * process doing no work is worse than a red one.
 */

const build = {
  version: process.env.FORGE_VERSION ?? "0.1.0",
  gitSha: process.env.FORGE_GIT_SHA ?? "local",
  buildTime: process.env.FORGE_BUILD_TIME ?? new Date().toISOString(),
};

const port = Number.parseInt(process.env.PORT ?? "3102", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`PORT must be a valid port number; got ${process.env.PORT}.`);
}

if (
  process.env.FORGE_DATABASE_URL === undefined ||
  process.env.FORGE_REDIS_URL === undefined
) {
  // Loudly, and then exit. A worker that cannot reach its queue has nothing to
  // do, and staying up to serve a health check would report a fleet as ready
  // while no run ever advances.
  process.stderr.write(
    "[forge-worker] FORGE_DATABASE_URL and FORGE_REDIS_URL are both required; " +
      "a worker with no queue consumes nothing.\n",
  );
  process.exit(1);
}

const stack = await createDurableStack();

/**
 * The consumer knows nothing about runtimes or stores. All three verbs land on
 * the same rehydration path: a run's state lives in the store, so a job for a
 * run this process never started is ordinary work rather than a special case.
 */
const host: RunHost = {
  async execute(runId) {
    return (await stack.resume(runId))?.status ?? "UNKNOWN";
  },
  async resume(runId) {
    return (await stack.resume(runId))?.status ?? "UNKNOWN";
  },
  async cancel(runId) {
    await stack.runtime.cancel(runId);
  },
};

const consumer = createWorkerConsumer({
  queue: stack.queue,
  host,
  observability: stack.observability,
});

let closing = false;
/**
 * Draining matters more here than anywhere else: `close()` is what flushes
 * buffered spans and returns the Redis and Postgres connections. A worker
 * killed without it loses exactly the telemetry describing why it was killed.
 */
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  process.stderr.write(`[forge-worker] ${signal}, draining.\n`);
  try {
    await stack.close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await consumer.start();
await startWorker(build, port);
