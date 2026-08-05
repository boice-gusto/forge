// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import type { ApprovalView, RunEventView, RunView } from "@forge/sdk";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { RunInspector } from "./run-inspector.js";

afterEach(cleanup);

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const FINGERPRINT = "sha256:9f2c4b1ad0e7315c8a6b2fd41e0c93875ab6d2e10f4c7b93a";

function run(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: "run_1",
    workflowId: "campaign-brief",
    fingerprint: FINGERPRINT,
    status: "RUNNING",
    attempt: 1,
    performedEffects: [],
    ...overrides,
  };
}

function gate(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    approvalId: "apr_1",
    runId: "run_1",
    nodeId: "publish",
    effect: "slack.post",
    effectHash: "9f2c4b1ad0e7315c8a6b2fd41e0c93875ab6d2e10f4c7b93a",
    policyId: "pol_external_publish",
    approvers: ["marketing-lead"],
    expiresAt: "2026-01-01T12:30:00.000Z",
    status: "PENDING",
    createdAt: "2026-01-01T11:30:00.000Z",
    ...overrides,
  };
}

const DISPATCHED: RunEventView = {
  seq: 0,
  at: "2026-01-01T11:59:00.000Z",
  kind: "effect",
  name: "forge.effect.dispatched",
  attributes: { runId: "run_1", nodeId: "publish", effect: "slack.post" },
};

function draw(
  overrides: Partial<RunView> = {},
  approvals: readonly ApprovalView[] = [],
  events: readonly RunEventView[] = [],
) {
  render(
    <RunInspector
      run={run(overrides)}
      approvals={approvals}
      events={events}
      now={NOW}
    />,
  );
}

function fact(term: string): HTMLElement {
  const value = screen.getByText(term).nextElementSibling;
  if (!(value instanceof HTMLElement))
    throw new Error(`No value rendered for "${term}".`);
  return value;
}

describe("the inspector states the run's identity and its artifact", () => {
  test("workflow, attempt and fingerprint are all shown", () => {
    draw({ attempt: 3 });

    expect(fact("Workflow")).toHaveTextContent("campaign-brief");
    expect(fact("Attempt")).toHaveTextContent("3");
    expect(fact("Artifact fingerprint")).toHaveTextContent(FINGERPRINT);
  });

  test("a run with no gate says none rather than leaving a gap", () => {
    draw();

    expect(fact("Pending gate")).toHaveTextContent("None");
  });

  test("a pending gate id is named", () => {
    draw({ status: "AWAITING_APPROVAL", pendingApprovalId: "apr_1" });

    expect(fact("Pending gate")).toHaveTextContent("apr_1");
  });

  test("status is carried as text, not by a colour", () => {
    draw({ status: "FAILED", error: "Sandbox unavailable." });

    expect(fact("Status")).toHaveTextContent("FAILED");
  });

  test("an unrecognised status is still shown rather than dropped", () => {
    draw({ status: "TELEPORTED" as RunView["status"] });

    expect(fact("Status")).toHaveTextContent("TELEPORTED");
  });
});

describe("what was actually dispatched is reported separately from status", () => {
  test("an empty ledger states that nothing reached anyone", () => {
    draw();

    expect(
      screen.getByText(
        "Nothing has been dispatched. No side effect has reached anyone.",
      ),
    ).toBeInTheDocument();
  });

  test("the ledger lists each dispatching node in order", () => {
    draw({ performedEffects: ["draft", "publish"] });

    const dispatched = screen.getByRole("list", { name: "Effects dispatched" });

    expect(
      within(dispatched)
        .getAllByRole("listitem")
        .map((node) => node.textContent),
    ).toEqual(["draft", "publish"]);
  });

  test("a succeeded run with an empty ledger still shows the empty ledger", () => {
    draw({ status: "SUCCEEDED" });

    expect(screen.getByText(/Nothing has been dispatched/)).toBeInTheDocument();
  });
});

describe("gates stay on the run whatever their outcome", () => {
  test("a run that opened no gate says so rather than leaving a gap", () => {
    draw();

    expect(
      screen.getByText("This run has opened no gate."),
    ).toBeInTheDocument();
  });

  test("a pending gate shows its binding and the policy that opened it", () => {
    draw({ status: "AWAITING_APPROVAL" }, [gate()]);

    const gates = screen.getByRole("list", { name: "Gates" });
    expect(within(gates).getByText(/slack.post at publish/)).toHaveTextContent(
      "Awaiting your decision",
    );
    expect(within(gates).getByText(/pol_external_publish/)).toHaveTextContent(
      "9f2c4b1ad0e7315c8a6b2fd41e0c93875ab6d2e10f4c7b93a",
    );
  });

  test("a rejected gate names who refused it, when, and why", () => {
    draw({ status: "FAILED" }, [
      gate({
        status: "REJECTED",
        decidedBy: "marketing-lead",
        decidedAt: "2026-01-01T11:45:00.000Z",
        reason: "off brand",
      }),
    ]);

    expect(
      screen.getByText(/Decided by marketing-lead at 2026-01-01T11:45/),
    ).toHaveTextContent("off brand");
  });

  test("an approval with no recorded reason is not made to invent one", () => {
    draw({}, [
      gate({
        status: "APPROVED",
        decidedBy: "marketing-lead",
        decidedAt: "2026-01-01T11:45:00.000Z",
      }),
    ]);

    expect(
      screen.getByText(
        /Decided by marketing-lead at 2026-01-01T11:45:00.000Z\./,
      ),
    ).toBeInTheDocument();
  });

  test("an undecided gate says no decision is recorded rather than showing blanks", () => {
    draw({}, [gate()]);

    expect(
      screen.getByText("No decision has been recorded."),
    ).toBeInTheDocument();
  });

  test("each gate is tagged with its state for anything styling on it", () => {
    draw({}, [
      gate({ approvalId: "apr_1" }),
      gate({ approvalId: "apr_2", status: "APPROVED" }),
    ]);

    expect(
      document.querySelectorAll('[data-gate-state="pending"]'),
    ).toHaveLength(1);
    expect(
      document.querySelectorAll('[data-gate-state="decided"]'),
    ).toHaveLength(1);
  });
});

describe("the timeline comes from the control plane, not from inference", () => {
  test("a reported event is rendered and tagged by kind", () => {
    draw({ performedEffects: ["publish"] }, [], [DISPATCHED]);

    expect(
      screen.getByText("Effect slack.post dispatched at publish"),
    ).toBeInTheDocument();
    expect(
      document.querySelectorAll('[data-timeline-kind="effect"]'),
    ).toHaveLength(1);
  });

  test("no reported event says so rather than inventing a sequence", () => {
    draw({ performedEffects: ["publish"] });

    expect(
      screen.getByText("The control plane has reported no event for this run."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Run timeline" })).toBeNull();
  });
});

describe("a diagnostic is surfaced, not buried", () => {
  test("an error is announced as an alert", () => {
    draw({
      status: "FAILED",
      error: 'Capability "prod.write" is outside the granted closure.',
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "outside the granted closure",
    );
  });

  test("a healthy run has no alert region at all", () => {
    draw({ status: "SUCCEEDED" });

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
