import { getContainerRuntimeClient } from "testcontainers";

/**
 * Whether to run, split from the probe below so it is testable without a
 * Docker daemon to withhold. Local development must not need Docker, but in CI
 * an unverified durable store must not read as green, so `FORGE_REQUIRE_STORES`
 * turns the skip into a throw.
 */
export function decideRuntimeRequirement(
  suiteName: string,
  reachable: boolean,
  required: boolean,
): boolean {
  if (reachable) return true;

  const detail =
    `[${suiteName}] No container runtime is reachable, so its container ` +
    "suite did not run and this adapter is UNVERIFIED. Start Docker, or set " +
    "DOCKER_HOST (Testcontainers does not read Docker contexts).";

  if (required) {
    throw new Error(
      `${detail} FORGE_REQUIRE_STORES=1 is set, so skipping is not permitted.`,
    );
  }

  // Straight to stderr: vitest's default reporter swallows `console.warn` from
  // module scope, and a skip nobody sees is the silent pass this prevents.
  process.stderr.write(`\n${detail}\n\n`);
  return false;
}

/**
 * Asks Testcontainers whether *it* can connect, not whether the `docker` CLI
 * works. Those differ: Testcontainers reads `DOCKER_HOST` and ignores Docker
 * contexts, so on a Colima or rootless host `docker info` succeeds while every
 * container test silently skips — the exact false green this guards against.
 */
export async function containerRuntimeAvailable(
  suiteName: string,
): Promise<boolean> {
  let reachable = true;
  try {
    await getContainerRuntimeClient();
  } catch {
    reachable = false;
  }
  return decideRuntimeRequirement(
    suiteName,
    reachable,
    process.env.FORGE_REQUIRE_STORES === "1",
  );
}
