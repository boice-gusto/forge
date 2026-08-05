import type { ProviderCapability, ProviderEvent } from "@forge/ports";
import {
  describeProviderConformance,
  type ProviderScenario,
} from "@forge/provider-conformance";

import { createMockProvider } from "./provider.js";

const SCRIPTS: Record<ProviderScenario, readonly ProviderEvent[]> = {
  "text-stream": [
    { type: "text-delta", text: "drafting" },
    { type: "text-delta", text: " the brief" },
    { type: "completed" },
  ],
  "tool-round-trip": [
    { type: "tool-call", toolId: "read_file", args: { path: "brief.md" } },
    { type: "tool-result", toolId: "read_file", result: { bytes: 12 } },
    { type: "completed" },
  ],
  // Long enough that a cancel has somewhere to land mid-stream.
  "cancellable-stream": [
    { type: "text-delta", text: "one" },
    { type: "text-delta", text: "two" },
    { type: "text-delta", text: "three" },
    { type: "text-delta", text: "four" },
    { type: "completed" },
  ],
  "transient-failure": [
    {
      type: "error",
      code: "RATE_LIMITED",
      message: "Too many requests; try again shortly.",
      retryable: true,
    },
  ],
  "permanent-failure": [
    {
      type: "error",
      code: "INVALID_REQUEST",
      message: "The prompt referenced a tool that does not exist.",
      retryable: false,
    },
  ],
  unavailable: [{ type: "completed" }],
};

const SUPPORTS: readonly ProviderCapability[] = [
  "streaming",
  "tool-calls",
  "session-resume",
];

describeProviderConformance({
  name: "provider-mock",
  supports: SUPPORTS,
  create(scenario) {
    return createMockProvider({
      providerId: "mock",
      events: SCRIPTS[scenario],
      ...(scenario === "unavailable" ? { available: false } : {}),
    });
  },
  createRestricted(capabilities) {
    return createMockProvider({
      providerId: "mock",
      events: SCRIPTS["text-stream"],
      capabilities,
    });
  },
});
