// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import type { ApprovalView, Decision } from "@forge/sdk";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ApprovalInbox, type DecisionOutcome } from "./approval-inbox.js";

afterEach(cleanup);

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

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

function draw(
  approvals: readonly ApprovalView[],
  outcome: DecisionOutcome = { ok: true },
) {
  const onDecide =
    vi.fn<
      (
        runId: string,
        approvalId: string,
        decision: Decision,
      ) => Promise<DecisionOutcome>
    >();
  onDecide.mockResolvedValue(outcome);
  render(<ApprovalInbox approvals={approvals} now={NOW} onDecide={onDecide} />);
  return { onDecide };
}

function cardFor(effect: string): HTMLElement {
  return screen.getByRole("article", { name: new RegExp(effect) });
}

describe("an empty queue says so rather than showing nothing", () => {
  test("no gates renders an explicit statement", () => {
    draw([]);

    expect(
      screen.getByText("No gate is waiting on a decision."),
    ).toBeInTheDocument();
  });
});

describe("a decision is sent for exactly the gate it was made on", () => {
  test("approving sends approve for that approval id alone", async () => {
    const { onDecide } = draw([
      gate({ approvalId: "apr_1", effect: "slack.post" }),
      gate({ approvalId: "apr_2", nodeId: "wire", effect: "payments.send" }),
    ]);

    const card = cardFor("payments.send");
    await userEvent.click(
      within(card).getByRole("button", { name: "Approve" }),
    );
    await userEvent.click(
      within(card).getByRole("button", {
        name: "Yes, authorise payments.send",
      }),
    );

    expect(onDecide).toHaveBeenCalledExactlyOnceWith("run_1", "apr_2", {
      kind: "approve",
    });
  });

  test("rejecting carries the typed reason", async () => {
    const { onDecide } = draw([gate()]);

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await userEvent.type(
      screen.getByLabelText("Why are you refusing this?"),
      "Off brand.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm rejection" }),
    );

    expect(onDecide).toHaveBeenCalledExactlyOnceWith("run_1", "apr_1", {
      kind: "reject",
      reason: "Off brand.",
    });
  });

  test("an edit sends the parsed patch, not the raw text", async () => {
    const { onDecide } = draw([gate()]);

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.type(
      screen.getByLabelText("Patch (JSON)"),
      '{{"channel":"#internal"}',
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Reissue gate on the amended action",
      }),
    );

    expect(onDecide).toHaveBeenCalledExactlyOnceWith("run_1", "apr_1", {
      kind: "edit",
      patch: { channel: "#internal" },
    });
  });

  test("a timeout is recorded against an expired gate", async () => {
    const { onDecide } = draw([
      gate({ expiresAt: "2026-01-01T11:00:00.000Z" }),
    ]);

    await userEvent.click(
      screen.getByRole("button", { name: "Record timeout" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Record timeout" }),
    );

    expect(onDecide).toHaveBeenCalledExactlyOnceWith("run_1", "apr_1", {
      kind: "timeout",
    });
  });
});

describe("an incomplete decision never reaches the control plane", () => {
  test("confirming a rejection with no reason is refused locally", async () => {
    const { onDecide } = draw([gate()]);

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm rejection" }),
    );

    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("needs a reason");
  });

  test("an unparsable patch is refused locally", async () => {
    const { onDecide } = draw([gate()]);

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.type(screen.getByLabelText("Patch (JSON)"), "not json");
    await userEvent.click(
      screen.getByRole("button", {
        name: "Reissue gate on the amended action",
      }),
    );

    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("must be valid JSON");
  });
});

describe("a rejected decision is reported back to the operator", () => {
  test("the control plane's refusal is shown on the gate", async () => {
    draw([gate()], {
      ok: false,
      message: "DECISION_REFUSED: approval already decided",
    });

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Yes, authorise slack.post" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "approval already decided",
    );
  });

  test("a successful decision clears the draft back to the choice buttons", async () => {
    draw([gate()]);

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await userEvent.type(
      screen.getByLabelText("Why are you refusing this?"),
      "No.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm rejection" }),
    );

    expect(
      await screen.findByRole("button", { name: "Approve" }),
    ).toBeInTheDocument();
  });
});

describe("keyboard shortcuts move the operator, they do not decide for them", () => {
  test("j and k move focus down and back up the queue", async () => {
    draw([
      gate({ approvalId: "apr_1" }),
      gate({ approvalId: "apr_2", effect: "payments.send" }),
    ]);

    const items = screen.getAllByRole("listitem");
    items[0]?.focus();
    await userEvent.keyboard("j");
    expect(items[1]).toHaveFocus();

    await userEvent.keyboard("k");
    expect(items[0]).toHaveFocus();
  });

  test("focus does not run off either end of the queue", async () => {
    draw([gate()]);

    const [only] = screen.getAllByRole("listitem");
    only?.focus();
    await userEvent.keyboard("kkjj");

    expect(only).toHaveFocus();
  });

  test("a opens the confirmation instead of approving outright", async () => {
    const { onDecide } = draw([gate()]);

    screen.getAllByRole("listitem")[0]?.focus();
    await userEvent.keyboard("a");

    expect(onDecide).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Yes, authorise slack.post" }),
    ).toBeInTheDocument();
  });

  test("r opens the reason field instead of rejecting outright", async () => {
    const { onDecide } = draw([gate()]);

    screen.getAllByRole("listitem")[0]?.focus();
    await userEvent.keyboard("r");

    expect(onDecide).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText("Why are you refusing this?"),
    ).toBeInTheDocument();
  });

  test("a shortcut cannot reopen a gate that has expired", async () => {
    draw([gate({ expiresAt: "2026-01-01T11:00:00.000Z" })]);

    screen.getAllByRole("listitem")[0]?.focus();
    await userEvent.keyboard("a");

    expect(screen.queryByRole("button", { name: /Yes, authorise/ })).toBeNull();
  });

  test("a modified key is left to the browser rather than claimed", async () => {
    draw([gate()]);

    screen.getAllByRole("listitem")[0]?.focus();
    await userEvent.keyboard("{Control>}a{/Control}");

    expect(screen.queryByRole("button", { name: /Yes, authorise/ })).toBeNull();
  });

  test("a key that is not a shortcut does nothing", async () => {
    draw([gate()]);

    screen.getAllByRole("listitem")[0]?.focus();
    await userEvent.keyboard("z");

    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  test("typing a rejection reason is not read as a shortcut", async () => {
    draw([gate()]);

    screen.getAllByRole("listitem")[0]?.focus();
    await userEvent.keyboard("r");
    const reason = screen.getByLabelText("Why are you refusing this?");
    await userEvent.type(reason, "jak");

    expect(reason).toHaveValue("jak");
    expect(reason).toHaveFocus();
  });
});

describe("the queue spans runs, so it says how many and whose", () => {
  test("gates from different runs sit in one queue and the header counts both", () => {
    draw([
      gate({ approvalId: "apr_1", runId: "run_1" }),
      gate({ approvalId: "apr_2", runId: "run_2", effect: "payments.send" }),
    ]);

    expect(
      screen.getByText(/2 gates waiting on you, across 2 runs/),
    ).toBeInTheDocument();
  });

  test("a single gate on a single run is not pluralised either way", () => {
    draw([gate()]);

    expect(
      screen.getByText(/1 gate waiting on you, across 1 run\./),
    ).toBeInTheDocument();
  });

  test("a decision is routed to the run the gate belongs to, not to a global one", async () => {
    const { onDecide } = draw([
      gate({ approvalId: "apr_9", runId: "run_77", effect: "payments.send" }),
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Yes, authorise payments.send" }),
    );

    expect(onDecide).toHaveBeenCalledExactlyOnceWith("run_77", "apr_9", {
      kind: "approve",
    });
  });
});
