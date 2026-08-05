import { getContainerRuntimeClient } from "testcontainers";

/**
 * Whether the durable-store suites can run here, and whether not running is
 * allowed.
 *
 * Local development must not need Docker. Everything except these two adapters
 * runs on a Map, so a contributor with no container runtime should still get a
 * green `pnpm test` — gating the whole repo on Docker would push people to skip
 * verification entirely.
 *
 * CI is the opposite case: an unverified durable store must not read as green.
 * Setting `FORGE_REQUIRE_STORES=1` turns a skip into a failure.
 *
 * The probe asks Testcontainers whether *it* can connect, not whether the
 * `docker` CLI works. Those differ — Testcontainers reads `DOCKER_HOST` and
 * ignores Docker contexts, so on a Colima or rootless host `docker info` can
 * succeed while every container test silently skips. A guard on the CLI would
 * have reported exactly the false green it was added to prevent.
 */
/**
 * The decision, separated from the probe so it can be tested without a Docker
 * daemon to withhold. Returns whether to run; throws when skipping is barred.
 */
export function decideRuntimeRequirement(
  suiteName: string,
  reachable: boolean,
  required: boolean,
): boolean {
  if (reachable) return true;

  const detail =
    `[${suiteName}] No container runtime is reachable, so the Postgres suite ` +
    "did not run and this adapter is UNVERIFIED. Start Docker, or set " +
    "DOCKER_HOST (Testcontainers does not read Docker contexts).";

  if (required) {
    throw new Error(
      `${detail} FORGE_REQUIRE_STORES=1 is set, so skipping is not permitted.`,
    );
  }

  // Written straight to stderr: vitest's default reporter swallows
  // `console.warn` from module scope, and a skip whose reason nobody sees is
  // the silent pass this exists to prevent.
  process.stderr.write(`\n${detail}\n\n`);
  return false;
}

export async function containerRuntimeAvailable(
  suiteName: string,
): Promise<boolean> {
  let reachable = false;
  try {
    await getContainerRuntimeClient();
    reachable = true;
  } catch {
    reachable = false;
  }
  return decideRuntimeRequirement(
    suiteName,
    reachable,
    process.env.FORGE_REQUIRE_STORES === "1",
  );
}
