import type { SandboxLease } from "@forge/ports";
import { createDockerSandbox } from "@forge/sandbox-docker";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { docker } from "../src/docker.js";

/**
 * What happens when the isolation goes away underneath the work.
 *
 * The rest of the harness kills Postgres and Redis. Neither of those is the
 * boundary a workflow's declaration rests on: a step that names a profile is
 * saying it runs somewhere it cannot reach the host, and this suite asks what
 * that promise is worth when the somewhere is destroyed mid-sentence.
 *
 * Three properties, in order of how much they would cost to get wrong:
 *
 * 1. A dead container must not answer. An `exec` that returns exit code 0
 *    against a container that no longer exists would be a step reporting
 *    success having run nothing — and a run continuing on that result.
 * 2. The lease must still be released. A container per lease that leaks on
 *    the failure path leaks precisely when a host is already unhealthy.
 * 3. Releasing must not itself throw. The removal is in a `finally`; a throw
 *    there replaces whatever the work was failing with, so the run reports the
 *    cleanup rather than the cause.
 */

const IMAGE = "busybox:1.36";
const PROFILE = "harness.sandbox-chaos";
const PROFILES = { [PROFILE]: { image: IMAGE, memoryMb: 128 } };
const PULL_TIMEOUT_MS = 240_000;

/** Containers this suite's leases created, however they ended. */
async function forgeSandboxes(): Promise<readonly string[]> {
  const listed = await docker(
    "ps",
    "--all",
    "--quiet",
    "--filter",
    "label=com.forge.sandbox=true",
  );
  return listed
    .split("\n")
    .map((id) => id.trim())
    .filter((id) => id !== "");
}

describe("the isolation is destroyed while the work is inside it", () => {
  const sandbox = createDockerSandbox({ profiles: PROFILES });
  let before: readonly string[] = [];

  beforeAll(async () => {
    // Pulled up front, so a cold image does not make the first test's timing
    // look like a provisioning failure.
    await docker("pull", IMAGE);
    before = await forgeSandboxes();
  }, PULL_TIMEOUT_MS);

  afterAll(async () => {
    // Anything this suite created and did not clean up, so a leak here does
    // not become somebody else's confusing failure tomorrow.
    const leaked = (await forgeSandboxes()).filter(
      (id) => !before.includes(id),
    );
    await Promise.all(
      leaked.map((id) => docker("rm", "--force", id).catch(() => "")),
    );
  });

  test("a container destroyed mid-lease makes the next exec fail, not succeed", async () => {
    let observed: { exitCode: number } | Error | undefined;

    await expect(
      sandbox.withSandbox(
        { profile: PROFILE, correlationId: "harness-chaos-exec" },
        async (lease: SandboxLease) => {
          // It works before, so the failure afterwards is the destruction and
          // not a sandbox that never worked.
          expect((await lease.exec(["true"])).exitCode).toBe(0);

          await docker("rm", "--force", lease.sandboxId);

          try {
            observed = await lease.exec(["true"]);
          } catch (error) {
            observed = error as Error;
          }
          throw new Error("FORGE_TEST_SANDBOX_GONE");
        },
      ),
    ).rejects.toThrow("FORGE_TEST_SANDBOX_GONE");

    // Either an error or a non-zero exit is honest. Exit code 0 is the one
    // answer that would be a lie, and the one a run would act on.
    expect(
      observed instanceof Error ? -1 : (observed?.exitCode ?? -1),
    ).not.toBe(0);
  }, 120_000);

  test("cleaning up a container that is already gone does not replace the real error", async () => {
    /**
     * Named for what it checks, which is narrower than it first looked.
     *
     * The removal lives in the adapter's `finally`. This container is already
     * destroyed by the time that runs, so nothing here proves the removal
     * happens — "no container outlives this suite", below, is what proves
     * that, and is what goes red when the `finally` is deleted. What this
     * proves is that the cleanup survives its target being gone: if it threw,
     * the run would report the cleanup instead of the cause, and the cause is
     * the interesting half of an isolation failure.
     */
    const started = await forgeSandboxes();
    let sandboxId = "";

    await expect(
      sandbox.withSandbox(
        { profile: PROFILE, correlationId: "harness-chaos-release" },
        async (lease: SandboxLease) => {
          sandboxId = lease.sandboxId;
          await docker("rm", "--force", lease.sandboxId);
          throw new Error("FORGE_TEST_WORK_FAILED");
        },
      ),
    ).rejects.toThrow("FORGE_TEST_WORK_FAILED");

    expect(sandboxId).not.toBe("");
    expect(await forgeSandboxes()).toEqual(started);
  }, 120_000);

  test("an escaped lease is refused after release, destroyed container or not", async () => {
    // The handle outliving its scope is the isolation boundary left standing
    // open. It is refused on its own terms rather than by the container
    // happening to be gone — which is why this releases normally and then
    // reaches for it.
    let escaped: SandboxLease | undefined;
    await sandbox.withSandbox(
      { profile: PROFILE, correlationId: "harness-chaos-escape" },
      async (lease: SandboxLease) => {
        escaped = lease;
      },
    );

    await expect(escaped?.exec(["true"])).rejects.toThrow("has been released");
  }, 120_000);

  test("no container outlives this suite", async () => {
    // Guards the three above. A lease that never provisioned anything would
    // pass all of them and prove nothing about cleanup.
    expect(await forgeSandboxes()).toEqual(before);
  }, 60_000);
});
