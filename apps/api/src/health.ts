export type DependencyStatus = "healthy" | "degraded" | "unavailable";

export interface BuildInfo {
  readonly version: string;
  readonly gitSha: string;
  readonly buildTime: string;
}

export interface HealthSnapshot {
  readonly status: "healthy" | "unready";
  readonly service: string;
  readonly version: string;
  readonly gitSha: string;
  readonly buildTime: string;
  readonly dependencies: Readonly<Record<string, DependencyStatus>>;
}

export function readinessStatus(
  dependencies: Readonly<Record<string, DependencyStatus>>,
): "healthy" | "unready" {
  return Object.values(dependencies).every((status) => status === "healthy")
    ? "healthy"
    : "unready";
}

export function createHealthSnapshot(
  service: string,
  build: BuildInfo,
  dependencies: Readonly<Record<string, DependencyStatus>>,
): HealthSnapshot {
  return {
    status: readinessStatus(dependencies),
    service,
    version: build.version,
    gitSha: build.gitSha,
    buildTime: build.buildTime,
    dependencies,
  };
}
