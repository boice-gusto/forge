export type WorkerDependencyStatus = "healthy" | "degraded" | "unavailable";

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
