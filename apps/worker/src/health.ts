// One declaration, in `@forge/ports`. The local alias stays because the
// worker's callers use it; the values are no longer a second opinion.
import type { DependencyStatus } from "@forge/ports";

export type WorkerDependencyStatus = DependencyStatus;

export interface WorkerBuildInfo {
  readonly version: string;
  readonly gitSha: string;
  readonly buildTime: string;
}

export interface WorkerHealth {
  readonly status: "healthy" | "unready";
  readonly service: "forge-worker";
  readonly version: string;
  readonly gitSha: string;
  readonly buildTime: string;
  readonly dependencies: Readonly<Record<string, WorkerDependencyStatus>>;
}

export function createWorkerHealth(
  build: WorkerBuildInfo,
  dependencies: Readonly<Record<string, WorkerDependencyStatus>>,
): WorkerHealth {
  return {
    status: Object.values(dependencies).every((state) => state === "healthy")
      ? "healthy"
      : "unready",
    service: "forge-worker",
    version: build.version,
    gitSha: build.gitSha,
    buildTime: build.buildTime,
    dependencies,
  };
}
