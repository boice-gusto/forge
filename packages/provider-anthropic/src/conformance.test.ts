import type { ProviderCapability } from "@forge/ports";
import {
  describeProviderConformance,
  type ProviderScenario,
} from "@forge/provider-conformance";
import { afterEach, beforeEach, vi } from "vitest";

import { createAnthropicProvider } from "./provider.js";
import {
  CANCELLABLE_STREAM,
  errorBody,
  MESSAGES_PATH,
  MODELS_AVAILABLE,
  MODELS_PATH,
  TEXT_STREAM,
  TOOL_ROUND_TRIP,
} from "./scenarios.js";
import {
  createScriptedTransport,
  type ScriptedRoute,
} from "./scripted-transport.js";

const SCENARIOS: Record<ProviderScenario, readonly ScriptedRoute[]> = {
  "text-stream": [
    MODELS_AVAILABLE,
    { path: MESSAGES_PATH, events: TEXT_STREAM },
  ],
  "tool-round-trip": [
    MODELS_AVAILABLE,
    { path: MESSAGES_PATH, events: TOOL_ROUND_TRIP },
  ],
  "cancellable-stream": [
    MODELS_AVAILABLE,
    { path: MESSAGES_PATH, events: CANCELLABLE_STREAM, chunkDelayMs: 1 },
  ],
  "transient-failure": [
    MODELS_AVAILABLE,
    {
      path: MESSAGES_PATH,
      status: 429,
      json: errorBody("rate_limit_error", "Too many requests."),
    },
  ],
  "permanent-failure": [
    MODELS_AVAILABLE,
    {
      path: MESSAGES_PATH,
      status: 400,
      json: errorBody("invalid_request_error", "max_tokens must be positive."),
    },
  ],
  unavailable: [
    {
      path: MODELS_PATH,
      status: 503,
      json: errorBody("api_error", "Service unavailable."),
    },
    { path: MESSAGES_PATH, events: TEXT_STREAM },
  ],
};

/** The API is stateless, so there is no session to resume. */
const SUPPORTS: readonly ProviderCapability[] = ["streaming", "tool-calls"];

const TOOLS = [
  {
    name: "read_file",
    description: "Read a file from the workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

// No key is ever needed to reach the network here — nothing reaches the
// network — but the adapter refuses to construct without one, so the suite
// supplies a placeholder exactly as a developer's shell would supply a real
// one.
beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "conformance-placeholder");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describeProviderConformance({
  name: "provider-anthropic",
  supports: SUPPORTS,
  // The Messages API proposes tool calls; the runtime executes them.
  emitsToolResults: false,
  create(scenario) {
    return createAnthropicProvider({
      model: "claude-test",
      tools: TOOLS,
      transport: createScriptedTransport(SCENARIOS[scenario]).fetch,
    });
  },
  createRestricted(capabilities) {
    return createAnthropicProvider({
      model: "claude-test",
      capabilities,
      transport: createScriptedTransport(SCENARIOS["text-stream"]).fetch,
    });
  },
});
