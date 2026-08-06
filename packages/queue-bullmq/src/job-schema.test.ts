import type { ForgeJob, ForgeJobType } from "@forge/ports";
import { FORGE_JOB_TYPES } from "@forge/ports";
import {
  CONFORMANCE_EXECUTE,
  CONFORMANCE_RESUME,
} from "@forge/queue-conformance";
import { describe, expect, test } from "vitest";

import { parseForgeJob } from "./job-schema.js";

/**
 * One valid payload per job kind, keyed by discriminant.
 *
 * The annotation is what does the work: a kind added to `ForgeJob` and not
 * added here does not compile, so the round-trip test below cannot silently
 * stop covering it. Listed by hand, this test passed for every kind it
 * happened to name — `connector.publish` was in the union and missing from the
 * wire schema, and every publish job was refused on arrival.
 */
const REPRESENTATIVE: {
  readonly [Type in ForgeJobType]: Extract<ForgeJob, { readonly type: Type }>;
} = {
  "workflow.execute": CONFORMANCE_EXECUTE,
  "workflow.resume": CONFORMANCE_RESUME,
  "workflow.cancel": { type: "workflow.cancel", runId: "run_1" },
  "connector.publish": {
    type: "connector.publish",
    runId: "run_1",
    channel: "slack",
    attempt: 1,
  },
};

/**
 * The transport is where a job arrives as bytes somebody else wrote. Needs no
 * Redis: what is under test is the refusal, not the delivery.
 */
describe("a job crossing the transport is validated before it is acted on", () => {
  test("each job kind survives the round trip verbatim", () => {
    for (const type of Object.values(FORGE_JOB_TYPES)) {
      const job = REPRESENTATIVE[type];
      expect(parseForgeJob(JSON.parse(JSON.stringify(job)))).toEqual(job);
    }
  });

  test("an unknown job type is refused, not guessed at", () => {
    // Acting on a half-understood instruction is how a cancel becomes an
    // execute.
    expect(() => parseForgeJob({ type: "workflow.detonate", runId: "run_1" })) //
      .toThrow("FORGE_QUEUE_INVALID_JOB");
  });

  test("a job missing the field the handler will read is refused", () => {
    expect(() =>
      parseForgeJob({ type: "workflow.resume", runId: "run_1", attempt: 2 }),
    ).toThrow("FORGE_QUEUE_INVALID_JOB");
  });

  test("the failure names what was wrong with it", () => {
    let message = "";
    try {
      parseForgeJob({ type: "workflow.cancel", runId: "" });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("runId");
  });

  test("a payload that is not an object at all is refused", () => {
    expect(() => parseForgeJob("workflow.cancel")).toThrow(
      "FORGE_QUEUE_INVALID_JOB",
    );
  });
});
