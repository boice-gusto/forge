import { createFixedClock, createSequentialIds } from "@forge/ports";
import { describe, expect, test } from "vitest";

import { createMemoryApprovalStore } from "./store.js";

const request = {
  runId: "run_1",
  nodeId: "publish",
  effect: "slack.post",
  effectHash: "sha256:effect",
  policyId: "acme.publish.external",
  approvers: ["marketing-lead"],
  expiresAt: "2026-08-11T00:00:00.000Z",
};

function store() {
  return createMemoryApprovalStore(
    createFixedClock("2026-08-04T00:00:00.000Z"),
    createSequentialIds(),
  );
}

describe("memory approval store", () => {
  test("an approval binds to one exact effect and starts pending", async () => {
    const approval = await store().request(request);

    expect(approval.effectHash).toBe("sha256:effect");
    expect(approval.nodeId).toBe("publish");
    expect(approval.status).toBe("PENDING");
    expect(approval.createdAt).toBe("2026-08-04T00:00:00.000Z");
  });

  test("a decision is single-use, so a repeat delivery cannot reverse it", async () => {
    const approvals = store();
    const approval = await approvals.request(request);

    const rejected = await approvals.decide(
      approval.approvalId,
      { kind: "reject", reason: "not ready" },
      "marketing-lead",
    );
    const replayed = await approvals.decide(
      approval.approvalId,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(rejected?.status).toBe("REJECTED");
    expect(rejected?.reason).toBe("not ready");
    expect(replayed?.status).toBe("REJECTED");
  });

  test("each decision kind maps to its own terminal status", async () => {
    for (const [decision, expected] of [
      [{ kind: "approve" } as const, "APPROVED"],
      [{ kind: "reject", reason: "no" } as const, "REJECTED"],
      [{ kind: "edit", patch: {} } as const, "EDITED"],
      [{ kind: "timeout" } as const, "TIMED_OUT"],
    ] as const) {
      const approvals = store();
      const approval = await approvals.request(request);
      const decided = await approvals.decide(
        approval.approvalId,
        decision,
        "someone",
      );
      expect(decided?.status).toBe(expected);
      expect(decided?.decidedBy).toBe("someone");
    }
  });

  test("deciding an unknown approval reports absence rather than inventing one", async () => {
    expect(
      await store().decide("approval_missing", { kind: "approve" }, "someone"),
    ).toBeUndefined();
  });

  test("pending gates are scoped per run and clear once decided", async () => {
    const approvals = store();
    const approval = await approvals.request(request);

    expect(await approvals.getPending("run_1")).toHaveLength(1);
    expect(await approvals.getPending("run_other")).toEqual([]);

    await approvals.decide(
      approval.approvalId,
      { kind: "approve" },
      "marketing-lead",
    );
    expect(await approvals.getPending("run_1")).toEqual([]);
  });

  test("two approvals on one run get distinct identifiers", async () => {
    const approvals = store();
    const first = await approvals.request(request);
    const second = await approvals.request(request);

    expect(first.approvalId).not.toBe(second.approvalId);
    expect(await approvals.getPending("run_1")).toHaveLength(2);
  });
});
