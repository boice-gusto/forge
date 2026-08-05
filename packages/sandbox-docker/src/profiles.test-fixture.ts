import type { DockerSandboxProfile } from "./sandbox.js";

/**
 * The profile catalogue the suites run against.
 *
 * Image names and limits are configuration, supplied at the composition root —
 * a real deployment maps `forge.node-ts` and `forge.agent-coding` onto its own
 * images. These aliases exist so the contract is exercised against something
 * small enough to pull in CI; nothing secret appears here or anywhere else in
 * the adapter.
 */
export const TEST_IMAGE = "busybox:1.36";

export const TEST_PROFILES: Readonly<Record<string, DockerSandboxProfile>> = {
  "forge.sandbox-test": { image: TEST_IMAGE, memoryMb: 256 },
  "forge.sandbox-test-small": { image: TEST_IMAGE, memoryMb: 128 },
};

/** A socket no daemon is listening on: provisioning genuinely cannot happen. */
export const DEAD_SOCKET_PATH = "/var/run/forge-no-such-docker.sock";
