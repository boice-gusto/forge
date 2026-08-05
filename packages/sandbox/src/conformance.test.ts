import { describeSandboxConformance } from "@forge/sandbox-conformance";

import { createMemorySandbox, type MemorySandbox } from "./memory.js";

const PROFILES = ["forge.mock", "forge.mock-coding"] as const;

/**
 * The mock answers the same contract as the container-backed adapter. That is
 * the only thing stopping the two from drifting until "it works with the mock"
 * stops meaning anything.
 */
const ports: MemorySandbox[] = [];

function track(port: MemorySandbox): MemorySandbox {
  ports.push(port);
  return port;
}

describeSandboxConformance({
  name: "sandbox-memory",
  profiles: PROFILES,
  create: () => track(createMemorySandbox({ profiles: PROFILES })),
  // Not a flag threaded into the lease code: the adapter is asked for an
  // environment it cannot produce, exactly as a dead daemon would be.
  createUnavailable: () =>
    track(createMemorySandbox({ profiles: PROFILES, available: false })),
  async isReleased(sandboxId) {
    return ports.every((port) => port.isReleased(sandboxId));
  },
});
