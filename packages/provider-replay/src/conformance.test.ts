import { fileURLToPath } from "node:url";

import type { ProviderCapability } from "@forge/ports";
import {
  describeProviderConformance,
  type ProviderScenario,
} from "@forge/provider-conformance";

import { createReplayProvider } from "./provider.js";

function fixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url));
}

const TRANSCRIPTS: Record<ProviderScenario, string> = {
  "text-stream": "text-stream",
  "tool-round-trip": "tool-round-trip",
  "cancellable-stream": "cancellable-stream",
  "transient-failure": "transient-failure",
  "permanent-failure": "permanent-failure",
  unavailable: "text-stream",
};

const SUPPORTS: readonly ProviderCapability[] = [
  "streaming",
  "tool-calls",
  "session-resume",
];

describeProviderConformance({
  name: "provider-replay",
  supports: SUPPORTS,
  create(scenario) {
    return createReplayProvider({
      providerId: "replay",
      transcriptPath: fixture(TRANSCRIPTS[scenario]),
      ...(scenario === "unavailable" ? { available: false } : {}),
    });
  },
  createRestricted(capabilities) {
    return createReplayProvider({
      providerId: "replay",
      transcriptPath: fixture("text-stream"),
      capabilities,
    });
  },
});
