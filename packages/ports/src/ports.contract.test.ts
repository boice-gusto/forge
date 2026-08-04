import { describe, expect, test } from "vitest";

import { createFixedClock, createSequentialIds } from "./clock.js";
import { sandboxUnavailable } from "./sandbox.js";

/**
 * Ports is the contracts layer, so it may not import an implementation. What
 * lives here are the pure helpers ports itself owns; behavioural conformance
 * for each adapter is tested alongside that adapter.
 */
describe("internal port contracts", () => {
  test("reports unavailable required sandbox without host fallback", () => {
    expect(sandboxUnavailable("docker").code).toBe("SANDBOX_UNAVAILABLE");
  });

  test("the injected clock does not drift and cannot be mutated by a caller", () => {
    const clock = createFixedClock("2026-08-04T00:00:00.000Z");
    const first = clock.now();
    first.setFullYear(1999);

    expect(clock.now().toISOString()).toBe("2026-08-04T00:00:00.000Z");
  });

  test("identifiers are sequential per prefix, so runs and approvals cannot collide", () => {
    const ids = createSequentialIds();

    expect([ids.next("run"), ids.next("run"), ids.next("approval")]).toEqual([
      "run_1",
      "run_2",
      "approval_1",
    ]);
  });
});
