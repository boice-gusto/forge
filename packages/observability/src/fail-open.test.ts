import type { ObservabilityPort } from "@forge/ports";
import { describe, expect, test } from "vitest";

import { failOpen } from "./fail-open.js";

const THROWS_ON_START: ObservabilityPort = {
  startSpan() {
    throw new Error("sink");
  },
  event() {
    throw new Error("sink");
  },
};

/**
 * Everything else in Forge fails closed. Telemetry does not, because a sink
 * that could stop a run would make observing a payroll workflow a dependency
 * of paying anyone.
 */
describe("a throwing sink never reaches the caller", () => {
  test("a span that cannot be started still hands back something endable", () => {
    const safe = failOpen(THROWS_ON_START);

    expect(() =>
      safe.startSpan("forge.run.start").end({ ok: true }),
    ).not.toThrow();
    expect(() => safe.event("forge.run.succeeded")).not.toThrow();
  });

  test("a span that throws only on end is swallowed there too", () => {
    // The end of a span is where the interesting attributes arrive, so it is
    // the more likely of the two to fail.
    const safe = failOpen({
      startSpan: () => ({
        end() {
          throw new Error("sink");
        },
      }),
      event: () => undefined,
    });

    expect(() => safe.startSpan("forge.node.agent").end()).not.toThrow();
  });

  test("a working sink is passed through unchanged", () => {
    const seen: string[] = [];
    const safe = failOpen({
      startSpan(name, attributes) {
        seen.push(`span:${name}:${JSON.stringify(attributes)}`);
        return {
          end(endAttributes) {
            seen.push(`end:${JSON.stringify(endAttributes)}`);
          },
        };
      },
      event(name, attributes) {
        seen.push(`event:${name}:${JSON.stringify(attributes)}`);
      },
    });

    safe.startSpan("forge.run.start", { runId: "run_1" }).end({ ok: true });
    safe.event("forge.run.succeeded", { runId: "run_1" });

    expect(seen).toEqual([
      'span:forge.run.start:{"runId":"run_1"}',
      'end:{"ok":true}',
      'event:forge.run.succeeded:{"runId":"run_1"}',
    ]);
  });
});
