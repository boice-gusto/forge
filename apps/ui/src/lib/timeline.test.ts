import type { ApprovalView, RunView } from "@forge/sdk";
import { describe, expect, test } from "vitest";

import { buildTimeline } from "./timeline.js";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

function run(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: "run_1",
    workflowId: "campaign-brief",
    fingerprint: "sha256:abc",
    status: "RUNNING",
    attempt: 1,
    performedEffects: [],
    ...overrides,
  };
}

const gate: ApprovalView = {
  approvalId: "apr_1",
  runId: "run_1",
  nodeId: "publish",
  effect: "slack.post",
  policyId: "pol_external_publish",
  approvers: ["marketing-lead"],
  expiresAt: "2026-01-01T12:30:00.000Z",
  status: "PENDING",
};

describe("the timeline reports the ledger rather than an assumed sequence", () => {
  test("a run with no dispatch shows no effect entries", () => {
    const entries = buildTimeline(run(), [], NOW);

    expect(entries.filter((entry) => entry.kind === "effect")).toEqual([]);
  });

  test("dispatched effects appear in ledger order", () => {
    const entries = buildTimeline(
      run({ performedEffects: ["draft", "publish"] }),
      [],
      NOW,
    );

    expect(
      entries.filter((e) => e.kind === "effect").map((e) => e.label),
    ).toEqual([
      "Effect dispatched at node draft",
      "Effect dispatched at node publish",
    ]);
  });

  test("an effect entry says why the ledger exists", () => {
    const [, dispatched] = buildTimeline(
      run({ performedEffects: ["publish"] }),
      [],
      NOW,
    );

    expect(dispatched?.detail).toContain("dispatching this twice");
  });
});

describe("the timeline distinguishes a live gate from a lapsed one", () => {
  test("a pending gate names its node, effect and policy", () => {
    const entry = buildTimeline(run(), [gate], NOW).find(
      (candidate) => candidate.kind === "gate",
    );

    expect(entry?.label).toBe("Gate on publish for slack.post");
    expect(entry?.detail).toContain("Awaiting your decision");
    expect(entry?.detail).toContain("pol_external_publish");
  });

  test("an expired gate is not reported as awaiting anyone", () => {
    const entry = buildTimeline(
      run(),
      [{ ...gate, expiresAt: "2026-01-01T11:00:00.000Z" }],
      NOW,
    ).find((candidate) => candidate.kind === "gate");

    expect(entry?.detail).toContain("Expired");
    expect(entry?.detail).not.toContain("Awaiting");
  });
});

describe("the timeline surfaces the run outcome and its diagnostic", () => {
  test("a retry is described as an attempt, not a state", () => {
    const [start] = buildTimeline(run({ attempt: 3 }), [], NOW);

    expect(start?.label).toContain("campaign-brief");
    expect(start?.detail).toContain("Attempt 3");
    expect(start?.detail).toContain("not a separate state");
  });

  test("awaiting approval is explained as a durable interrupt", () => {
    const entry = buildTimeline(
      run({ status: "AWAITING_APPROVAL" }),
      [],
      NOW,
    ).find((candidate) => candidate.id === "run-status");

    expect(entry?.label).toBe("Status AWAITING_APPROVAL");
    expect(entry?.detail).toContain("No worker is held");
  });

  test("an unrecognised status is not narrated", () => {
    const entry = buildTimeline(
      run({ status: "TELEPORTED" as RunView["status"] }),
      [],
      NOW,
    ).find((candidate) => candidate.id === "run-status");

    expect(entry?.detail).toBe("Unrecognised status.");
  });

  test("a failure carries its diagnostic as the final entry", () => {
    const entries = buildTimeline(
      run({ status: "FAILED", error: "Sandbox unavailable." }),
      [],
      NOW,
    );

    expect(entries.at(-1)).toMatchObject({
      kind: "diagnostic",
      detail: "Sandbox unavailable.",
    });
  });

  test("a run without an error adds no diagnostic entry", () => {
    expect(
      buildTimeline(run(), [], NOW).some((e) => e.kind === "diagnostic"),
    ).toBe(false);
  });
});
