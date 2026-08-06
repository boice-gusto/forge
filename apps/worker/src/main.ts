import Fastify, { type FastifyInstance } from "fastify";

import { createWorkerHealth, type WorkerBuildInfo } from "./health.js";

export function createWorkerApp(
  build: WorkerBuildInfo,
  /**
   * Evaluated per request, not captured at boot. A hard-coded `healthy` is a
   * probe that answers 200 while the process consumes nothing — which this
   * file's own comment already called worse than a red one, and which a Redis
   * outage made real: the consumer's connection died and the probe never
   * noticed.
   */
  dependencies: () => Promise<
    Readonly<Record<string, "healthy" | "degraded" | "unavailable">>
  >,
): FastifyInstance {
  const app = Fastify({ logger: false });
  const health = async () => createWorkerHealth(build, await dependencies());

  app.get("/health/live", async () => ({
    status: "alive",
    service: "forge-worker",
  }));
  app.get("/health/ready", async (_request, reply) => {
    const snapshot = await health();
    return reply.code(snapshot.status === "healthy" ? 200 : 503).send(snapshot);
  });
  return app;
}

export async function startWorker(
  build: WorkerBuildInfo,
  dependencies: () => Promise<
    Readonly<Record<string, "healthy" | "degraded" | "unavailable">>
  >,
  port = 3102,
): Promise<void> {
  await createWorkerApp(build, dependencies).listen({
    host: "127.0.0.1",
    port,
  });
}
