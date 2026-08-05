import {
  CONFORMANCE_EXECUTE,
  CONFORMANCE_RESUME,
} from "@forge/queue-conformance";
import { describe, expect, test } from "vitest";

import { parseForgeJob } from "./job-schema.js";

/**
 * The transport is where a job arrives as bytes somebody else wrote. Needs no
 * Redis: what is under test is the refusal, not the delivery.
 */
describe("a job crossing the transport is validated before it is acted on", () => {
  test("each job kind survives the round trip verbatim", () => {
    for (const job of [
      CONFORMANCE_EXECUTE,
      CONFORMANCE_RESUME,
      { type: "workflow.cancel", runId: "run_1" } as const,
    ]) {
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
