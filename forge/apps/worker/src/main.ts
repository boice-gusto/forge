import Fastify, { type FastifyInstance } from "fastify";

import { createWorkerHealth, type WorkerBuildInfo } from "./health.js";

export function createWorkerApp(
  build: WorkerBuildInfo,
  dependencies: Readonly<
    Record<string, "healthy" | "degraded" | "unavailable">
  >,
): FastifyInstance {
  const app = Fastify({ logger: false });
  const health = () => createWorkerHealth(build, dependencies);

  app.get("/health/live", async () => ({
    status: "alive",
    service: "forge-worker",
  }));
  app.get("/health/ready", async (_request, reply) => {
    const snapshot = health();
    return reply.code(snapshot.status === "healthy" ? 200 : 503).send(snapshot);
  });
  return app;
}

export async function startWorker(
  build: WorkerBuildInfo,
  port = 3102,
): Promise<void> {
  const health = createWorkerHealth(build, {
    queue: "healthy",
    persistence: "healthy",
  });
  if (health.status !== "healthy") {
    throw new Error(
      "Worker cannot start without healthy required dependencies.",
    );
  }
  await createWorkerApp(build, health.dependencies).listen({
    host: "127.0.0.1",
    port,
  });
}
