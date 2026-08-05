// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import type { ApprovalView, RunView } from "@forge/sdk";
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

function draw(
  overrides: Partial<RunView> = {},
  approvals: readonly ApprovalView[] = [],
) {
  render(<RunInspector run={run(overrides)} approvals={approvals} now={NOW} />);
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

describe("the timeline is visible alongside the gates", () => {
  test("a pending gate appears in the timeline with its policy", () => {
    draw({ status: "AWAITING_APPROVAL" }, [gate]);

    expect(
      screen.getByText("Gate on publish for slack.post"),
    ).toBeInTheDocument();
    expect(screen.getByText(/pol_external_publish/)).toBeInTheDocument();
  });

  test("timeline entries are tagged by kind for anything styling on them", () => {
    draw({ performedEffects: ["publish"] });

    expect(
      document.querySelectorAll('[data-timeline-kind="effect"]'),
    ).toHaveLength(1);
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
