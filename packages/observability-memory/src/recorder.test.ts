import { createFixedClock } from "@forge/ports";
import { describe, expect, test } from "vitest";

import { createMemoryObservability } from "./recorder.js";

describe("the recorder keeps the order things actually happened in", () => {
  test("spans and events interleave in one sequence", () => {
    const observability = createMemoryObservability(
      createFixedClock("2026-08-04T00:00:00.000Z"),
    );

    const span = observability.startSpan("forge.run.start", { runId: "run_1" });
    observability.event("forge.policy.decide", { runId: "run_1" });
    span.end({ status: "AWAITING_APPROVAL" });

    expect(
      observability.timeline.map((entry) => [
        entry.seq,
        entry.kind,
        entry.name,
      ]),
    ).toEqual([
      [0, "span", "forge.run.start"],
      [1, "event", "forge.policy.decide"],
    ]);
    expect(observability.timeline[0]?.at).toBe("2026-08-04T00:00:00.000Z");
  });

  test("ending a span merges its closing attributes onto the same entry", () => {
    const observability = createMemoryObservability();

    observability.startSpan("forge.node.judge", { nodeId: "review" }).end({
      verdict: "pass",
    });

    expect(observability.timeline[0]).toMatchObject({
      ended: true,
      attributes: { nodeId: "review", verdict: "pass" },
    });
    expect(observability.spans[0]?.ended).toBe(true);
  });

  test("a span with no attributes and no closing attributes still records", () => {
    const observability = createMemoryObservability();

    observability.startSpan("forge.node.agent").end();

    expect(observability.names()).toEqual(["forge.node.agent"]);
    expect(observability.timeline[0]?.attributes).toEqual({});
    expect(observability.events).toEqual([]);
  });

  test("an event with no attributes records as ended", () => {
    const observability = createMemoryObservability();

    observability.event("forge.run.transition");

    expect(observability.events[0]).toMatchObject({
      name: "forge.run.transition",
      ended: true,
    });
  });
});

/**
 * The adapter is the last place a payload can be stopped. A call site that
 * forgets to scrub is a silent disclosure; an adapter that scrubs everything it
 * is handed cannot forget.
 */
describe("nothing sensitive survives being recorded", () => {
  test("a sensitive attribute is scrubbed on the way in", () => {
    const observability = createMemoryObservability();

    observability.event("forge.approval.decided", {
      runId: "run_1",
      approverEmail: "ada@example.test",
    });

    expect(observability.events[0]?.attributes).toEqual({
      runId: "run_1",
      approverEmail: "[REDACTED]",
    });
  });

  test("a payload smuggled in through a closing attribute is scrubbed too", () => {
    const observability = createMemoryObservability();

    observability
      .startSpan("forge.node.agent", { nodeId: "draft" })
      .end({ prompt: "Summarise the payroll for 123-45-6789" });

    expect(observability.timeline[0]?.attributes).toEqual({
      nodeId: "draft",
      prompt: "[REDACTED]",
    });
  });
});
