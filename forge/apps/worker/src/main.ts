import { createWorkerHealth, type WorkerBuildInfo } from "./health.js";

export function startWorker(build: WorkerBuildInfo): void {
  const health = createWorkerHealth(build, {
    queue: "healthy",
    persistence: "healthy",
  });
  if (health.status !== "healthy") {
    throw new Error(
      "Worker cannot start without healthy required dependencies.",
    );
  }
}
