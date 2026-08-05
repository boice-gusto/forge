import type { RunEventView } from "@forge/sdk";
import { describe, expect, test } from "vitest";

import { buildTimeline } from "./timeline.js";

let seq = 0;

/** Mirrors the classification the API applies before the stream leaves it. */
const KINDS = new Set(["run", "node", "policy", "approval", "effect"]);

function event(
  name: string,
  attributes: RunEventView["attributes"] = {},
): RunEventView {
  seq += 1;
  const family = name.split(".")[1] ?? "";
  return {
    seq,
    at: "2026-01-01T12:00:00.000Z",
    kind: (KINDS.has(family) ? family : "other") as RunEventView["kind"],
    name,
    attributes: { runId: "run_1", ...attributes },
  };
}

function only(name: string, attributes: RunEventView["attributes"] = {}) {
  const [entry] = buildTimeline([event(name, attributes)]);
  if (entry === undefined) throw new Error("The timeline dropped an event.");
  return entry;
}

describe("the timeline is the control plane's own event stream", () => {
  test("events are rendered in the order they were reported", () => {
    const timeline = buildTimeline([
      event("forge.run.transition", { from: "PENDING", to: "RUNNING" }),
      event("forge.effect.dispatched", {
        nodeId: "publish",
        effect: "slack.post",
        sequence: 1,
      }),
    ]);

    expect(timeline.map((entry) => entry.kind)).toEqual(["run", "effect"]);
  });

  test("a run with no reported event yields an empty timeline, not a guess", () => {
    expect(buildTimeline([])).toEqual([]);
  });

  test("every entry carries a mark so status is never colour alone", () => {
    const timeline = buildTimeline([
      event("forge.run.transition", { to: "SUCCEEDED" }),
      event("forge.node.agent", { nodeId: "draft" }),
      event("forge.policy.decide", { decision: "allow", action: "x" }),
      event("forge.approval.requested", { nodeId: "publish" }),
      event("forge.effect.dispatched", { nodeId: "publish" }),
      event("forge.worker.job"),
    ]);

    expect(timeline.every((entry) => entry.mark !== "")).toBe(true);
    expect(new Set(timeline.map((entry) => entry.id)).size).toBe(6);
  });
});

describe("each event says what it means, not just what it is called", () => {
  test("a lifecycle transition names both states and explains the destination", () => {
    const entry = only("forge.run.transition", {
      from: "RUNNING",
      to: "AWAITING_APPROVAL",
      attempt: 1,
    });

    expect(entry.label).toBe("Run RUNNING → AWAITING_APPROVAL");
    expect(entry.detail).toContain("No worker is held");
  });

  test("an unrecognised status falls back to the attempt rather than a blank", () => {
    const entry = only("forge.run.transition", {
      from: "RUNNING",
      to: "TELEPORTED",
      attempt: 2,
    });

    expect(entry.detail).toContain("Attempt 2");
  });

  test("a policy decision names the rule that decided it", () => {
    const entry = only("forge.policy.decide", {
      decision: "require-approval",
      action: "slack.post",
      policyId: "pol_external_publish",
    });

    expect(entry.label).toBe("Policy require-approval on slack.post");
    expect(entry.detail).toContain("pol_external_publish");
  });

  test("an allow with no rule id says so instead of inventing one", () => {
    const entry = only("forge.policy.decide", {
      decision: "allow",
      action: "slack.post",
    });

    expect(entry.detail).toBe("No rule was named for this decision.");
  });

  test("an opened gate shows the binding, not the artifact", () => {
    const entry = only("forge.approval.requested", {
      nodeId: "publish",
      effect: "slack.post",
      effectHash: "abc123",
      expiresAt: "2026-01-08T00:00:00.000Z",
    });

    expect(entry.label).toBe("Gate opened on publish for slack.post");
    expect(entry.detail).toContain("abc123");
  });

  test("a decision says which gate and which action", () => {
    const entry = only("forge.approval.decided", {
      approvalId: "apr_1",
      decision: "approve",
      effect: "slack.post",
      nodeId: "publish",
    });

    expect(entry.label).toBe("Gate apr_1 approve");
    expect(entry.detail).toContain("single-use");
  });

  test("an expiry is described as a timeout, never as a late yes", () => {
    const entry = only("forge.approval.expired", {
      approvalId: "apr_1",
      attempted: "approve",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });

    expect(entry.label).toBe("Gate apr_1 expired");
    expect(entry.detail).toContain("timeout, not a slow yes");
  });

  test("an edit names its successor and says it authorised nothing", () => {
    const entry = only("forge.approval.edited", {
      approvalId: "apr_1",
      reissuedAs: "apr_2",
    });

    expect(entry.label).toBe("Gate apr_1 edited, reissued as apr_2");
    expect(entry.detail).toContain("authorises nothing");
  });

  test("a dispatched effect is marked as what reached the outside world", () => {
    const entry = only("forge.effect.dispatched", {
      nodeId: "publish",
      effect: "slack.post",
      sequence: 1,
    });

    expect(entry.label).toBe("Effect slack.post dispatched at publish");
    expect(entry.detail).toContain("reached the outside world");
  });

  test("an event this build has never seen is shown, not dropped", () => {
    const entry = only("forge.worker.job", { jobId: "job_1" });

    expect(entry.kind).toBe("other");
    expect(entry.label).toBe("forge.worker.job");
    expect(entry.detail).toBe("runId=run_1, jobId=job_1");
  });
});
