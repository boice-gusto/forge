// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import type { ApprovalView } from "@forge/sdk";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import { type DecisionDraft, emptyDraft } from "../lib/gate.js";
import { ApprovalCard } from "./approval-card.js";

// Auto-cleanup only runs when Vitest globals are on, and they are not.
afterEach(cleanup);

/** The value cell of a `<dt>`/`<dd>` pair, so a fact can be asserted alone. */
function fact(term: string): HTMLElement {
  const value = screen.getByText(term).nextElementSibling;
  if (!(value instanceof HTMLElement))
    throw new Error(`No value rendered for "${term}".`);
  return value;
}

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const BINDING =
  "9f2c4b1ad0e7315c8a6b2fd41e0c93875ab6d2e10f4c7b93a5d81c2e6f0b4a37";

function gate(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    approvalId: "apr_1",
    runId: "run_1",
    nodeId: "publish",
    effect: "slack.post",
    effectHash: BINDING,
    policyId: "pol_external_publish",
    approvers: ["marketing-lead", "compliance"],
    expiresAt: "2026-01-01T12:30:00.000Z",
    status: "PENDING",
    createdAt: "2026-01-01T11:30:00.000Z",
    ...overrides,
  };
}

function draw(
  overrides: {
    readonly approval?: ApprovalView;
    readonly draft?: DecisionDraft;
    readonly error?: string;
  } = {},
) {
  const onDraftChange = vi.fn();
  const onSubmit = vi.fn();
  render(
    <ApprovalCard
      approval={overrides.approval ?? gate()}
      now={NOW}
      draft={overrides.draft ?? emptyDraft}
      {...(overrides.error === undefined ? {} : { error: overrides.error })}
      onDraftChange={onDraftChange}
      onSubmit={onSubmit}
    />,
  );
  return { onDraftChange, onSubmit };
}

describe("an approval shows the exact action it authorises", () => {
  test("the node, effect, policy, approvers and expiry are all on screen", () => {
    draw();

    expect(fact("Node")).toHaveTextContent("publish");
    expect(fact("Effect")).toHaveTextContent("slack.post");
    expect(fact("Deciding policy")).toHaveTextContent("pol_external_publish");
    expect(fact("Approvers")).toHaveTextContent("marketing-lead, compliance");
    expect(fact("Expires")).toHaveTextContent("30m left");
  });

  test("the binding is shown in full, not the weaker artifact fingerprint", () => {
    draw();

    // runId + nodeId + effect + fingerprint, hashed. The fingerprint alone
    // would identify the workflow, not the action being authorised.
    expect(fact("Binding (effect hash)")).toHaveTextContent(BINDING);
  });

  test("the binding is stated as covering this action and no other", () => {
    draw();

    const binding = screen.getByText(/This authorises/);
    expect(binding).toHaveTextContent("slack.post");
    expect(binding).toHaveTextContent("publish");
    expect(binding).toHaveTextContent("run_1");
    expect(binding).toHaveTextContent(BINDING);
    expect(binding).toHaveTextContent("authorises nothing else");
  });

  test("a policy that named no approver says so rather than showing a blank", () => {
    draw({ approval: gate({ approvers: [] }) });

    expect(fact("Approvers")).toHaveTextContent("None named by the policy");
  });
});

describe("approving takes two deliberate steps", () => {
  test("the first click opens a confirmation naming the effect", async () => {
    const { onDraftChange, onSubmit } = draw();

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onDraftChange).toHaveBeenCalledWith({
      ...emptyDraft,
      mode: "approve",
    });
  });

  test("the confirmation repeats the action before it can be sent", async () => {
    const { onSubmit } = draw({ draft: { ...emptyDraft, mode: "approve" } });

    expect(
      screen.getByText(/Authorise slack.post at node publish/),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Yes, authorise slack.post" }),
    );

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test("cancelling a confirmation abandons the draft entirely", async () => {
    const { onDraftChange, onSubmit } = draw({
      draft: { ...emptyDraft, mode: "approve" },
    });

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onDraftChange).toHaveBeenCalledWith(emptyDraft);
  });
});

describe("refusing is as reachable as agreeing", () => {
  test("reject collects a reason before it can be confirmed", async () => {
    const { onDraftChange } = draw({
      draft: { ...emptyDraft, mode: "reject" },
    });

    await userEvent.type(
      screen.getByLabelText("Why are you refusing this?"),
      "n",
    );

    expect(onDraftChange).toHaveBeenCalledWith({
      ...emptyDraft,
      mode: "reject",
      reason: "n",
    });
  });

  test("the rejection reason field is labelled for a screen reader", () => {
    draw({ draft: { ...emptyDraft, mode: "reject" } });

    expect(screen.getByLabelText("Why are you refusing this?")).toHaveAttribute(
      "id",
      "apr_1-reason",
    );
  });
});

describe("an edit is shown to authorise nothing", () => {
  test("the edit form says the gate is reissued", () => {
    draw({ draft: { ...emptyDraft, mode: "edit" } });

    const notice = screen.getByText(/An edit/);
    expect(notice).toHaveTextContent("authorises nothing");
    expect(notice).toHaveTextContent("gate is reissued");
  });

  test("the submit button promises a reissue, not an authorisation", () => {
    draw({ draft: { ...emptyDraft, mode: "edit" } });

    expect(
      screen.getByRole("button", {
        name: "Reissue gate on the amended action",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /authorise/i })).toBeNull();
  });
});

describe("an expired gate cannot be answered", () => {
  const expired = gate({ expiresAt: "2026-01-01T11:00:00.000Z" });

  test("no approve or reject control is offered", () => {
    draw({ approval: expired });

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  test("it is described as a timeout rather than a slow yes", () => {
    draw({ approval: expired });

    expect(screen.getByText(/timeout, not a slow yes/)).toBeInTheDocument();
  });

  test("the only remaining action records the timeout", async () => {
    const { onDraftChange } = draw({ approval: expired });

    await userEvent.click(
      screen.getByRole("button", { name: "Record timeout" }),
    );

    expect(onDraftChange).toHaveBeenCalledWith({
      ...emptyDraft,
      mode: "timeout",
    });
  });

  test("recording a timeout is itself confirmed", async () => {
    const { onSubmit } = draw({
      approval: expired,
      draft: { ...emptyDraft, mode: "timeout" },
    });

    expect(screen.getByText(/Record the timeout against/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Record timeout" }),
    );

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test("cancelling the timeout confirmation records nothing", async () => {
    const { onDraftChange, onSubmit } = draw({
      approval: expired,
      draft: { ...emptyDraft, mode: "timeout" },
    });

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onDraftChange).toHaveBeenCalledWith(emptyDraft);
  });

  test("the card is marked expired for anything styling on state", () => {
    draw({ approval: expired });

    expect(screen.getByRole("article")).toHaveAttribute(
      "data-gate-state",
      "expired",
    );
  });
});

describe("a decided gate offers nothing further", () => {
  test("it explains that decisions are single-use", () => {
    draw({ approval: gate({ status: "APPROVED" }) });

    expect(screen.getByText(/single-use/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("a refused submission is announced, not swallowed", () => {
  test("the failure is exposed as an alert", () => {
    draw({ error: "DECISION_REFUSED: already decided" });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "DECISION_REFUSED: already decided",
    );
  });

  test("no alert region exists when nothing has failed", () => {
    draw();

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
