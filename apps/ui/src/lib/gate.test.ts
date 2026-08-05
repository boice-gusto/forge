import type { ApprovalView } from "@forge/sdk";
import { describe, expect, test } from "vitest";

import {
  buildDecision,
  emptyDraft,
  gateState,
  presentGate,
  remainingLabel,
} from "./gate.js";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

function gate(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    approvalId: "apr_1",
    runId: "run_1",
    nodeId: "publish",
    effect: "slack.post",
    policyId: "pol_external_publish",
    approvers: ["marketing-lead"],
    expiresAt: "2026-01-01T12:30:00.000Z",
    status: "PENDING",
    ...overrides,
  };
}

describe("an expired gate is not a slow yes", () => {
  test("a gate past its expiry reads as expired, not pending", () => {
    expect(
      gateState(gate({ expiresAt: "2026-01-01T11:59:59.000Z" }), NOW),
    ).toBe("expired");
  });

  test("a gate exactly at its expiry has already run out", () => {
    expect(
      gateState(gate({ expiresAt: "2026-01-01T12:00:00.000Z" }), NOW),
    ).toBe("expired");
  });

  test("an unreadable expiry fails closed rather than looking pending", () => {
    expect(gateState(gate({ expiresAt: "whenever" }), NOW)).toBe("expired");
    expect(remainingLabel("whenever", NOW)).toBe("expiry unreadable");
  });

  test("an expired gate is labelled as timed out, not merely late", () => {
    const presentation = presentGate(
      gate({ expiresAt: "2026-01-01T11:00:00.000Z" }),
      NOW,
    );

    expect(presentation.state).toBe("expired");
    expect(presentation.label).toContain("timed out, not approved");
  });
});

describe("gate status is never carried by colour alone", () => {
  test.each([
    ["PENDING", "Awaiting your decision"],
    ["APPROVED", "Approved"],
    ["REJECTED", "Rejected"],
    ["EDITED", "Edited — gate reissued"],
    ["TIMED_OUT", "Timed out"],
  ])("%s renders a mark and a text label", (status, label) => {
    const presentation = presentGate(gate({ status }), NOW);

    expect(presentation.mark).not.toBe("");
    expect(presentation.label).toBe(label);
  });

  test("an unrecognised status is shown verbatim rather than guessed at", () => {
    expect(presentGate(gate({ status: "SUPERSEDED" }), NOW).label).toBe(
      "SUPERSEDED",
    );
  });
});

describe("the countdown tells an operator how long they really have", () => {
  test.each([
    ["2026-01-01T12:00:45.000Z", "45s left"],
    ["2026-01-01T12:07:00.000Z", "7m left"],
    ["2026-01-01T14:05:00.000Z", "2h 5m left"],
    ["2026-01-04T16:00:00.000Z", "3d 4h left"],
  ])("%s reads as %s", (expiresAt, label) => {
    expect(remainingLabel(expiresAt, NOW)).toBe(label);
  });

  test("a passed expiry says so instead of counting backwards", () => {
    expect(remainingLabel("2026-01-01T11:00:00.000Z", NOW)).toBe("expired");
  });
});

describe("no decision is submitted that the operator did not complete", () => {
  test("nothing is submittable before a kind is chosen", () => {
    const outcome = buildDecision(emptyDraft);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message).toContain("Choose approve");
  });

  test("a rejection without a reason is refused", () => {
    const outcome = buildDecision({ ...emptyDraft, mode: "reject" });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message).toContain("needs a reason");
  });

  test("a rejection reason of only whitespace is not a reason", () => {
    expect(
      buildDecision({ ...emptyDraft, mode: "reject", reason: "   \n " }).ok,
    ).toBe(false);
  });

  test("a rejection carries its trimmed reason", () => {
    const outcome = buildDecision({
      ...emptyDraft,
      mode: "reject",
      reason: "  Wrong audience.  ",
    });

    expect(outcome).toEqual({
      ok: true,
      decision: { kind: "reject", reason: "Wrong audience." },
    });
  });

  test("an edit with no patch is refused", () => {
    const outcome = buildDecision({ ...emptyDraft, mode: "edit", patch: " " });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message).toContain("needs a patch");
  });

  test("an unparsable patch is refused with the parser's complaint", () => {
    const outcome = buildDecision({
      ...emptyDraft,
      mode: "edit",
      patch: "{ not json",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message).toContain(
      "must be valid JSON",
    );
  });

  test("a valid patch becomes an edit decision", () => {
    const outcome = buildDecision({
      ...emptyDraft,
      mode: "edit",
      patch: '{"channel":"#internal"}',
    });

    expect(outcome).toEqual({
      ok: true,
      decision: { kind: "edit", patch: { channel: "#internal" } },
    });
  });

  test.each([
    ["approve", { kind: "approve" }],
    ["timeout", { kind: "timeout" }],
  ] as const)("%s needs no further input", (mode, decision) => {
    expect(buildDecision({ ...emptyDraft, mode })).toEqual({
      ok: true,
      decision,
    });
  });
});
