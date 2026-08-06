import {
  describeObservabilityConformance,
  type ObservabilitySubject,
  type SinkFault,
} from "@forge/observability-conformance";
import type { ClockPort } from "@forge/ports";

import { createMemoryObservability } from "./recorder.js";

/**
 * This recorder is its own sink: there is nothing downstream of it, so
 * `recorded()` reads the timeline. That makes it the weaker of the two
 * conformance proofs by construction — the redaction assertions here confirm
 * the adapter agrees with itself. `@forge/observability-otel` runs the same
 * suite against a real exporter, and that is where the claim is earned.
 *
 * Running both is the point: the contract cannot drift between them.
 */
function subject(clock?: ClockPort): ObservabilitySubject {
  const observability = createMemoryObservability(clock);
  return {
    observability,
    async flush() {},
    async shutdown() {},
    recorded: () =>
      observability.timeline.map((entry) => ({
        name: entry.name,
        kind: entry.kind,
        attributes: entry.attributes,
        spanId: entry.spanId,
        traceId: entry.traceId,
        ...(entry.parentSpanId === undefined
          ? {}
          : { parentSpanId: entry.parentSpanId }),
      })),
  };
}

const THROWING_CLOCK: ClockPort = {
  now() {
    throw new Error("the recorder's clock failed");
  },
};

describeObservabilityConformance({
  name: "@forge/observability-memory",
  // A Map has no collector to be unreachable, so the only fault this adapter
  // can stage is its own — which is the one every adapter must survive.
  faults: ["throws"],
  async create() {
    return subject();
  },
  async createFaulty(fault: SinkFault) {
    if (fault !== "throws") throw new Error(`unstageable fault: ${fault}`);
    return subject(THROWING_CLOCK);
  },
});
