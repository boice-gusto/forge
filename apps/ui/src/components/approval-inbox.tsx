import type { ApprovalView, Decision } from "@forge/sdk";
import { type KeyboardEvent, useRef, useState } from "react";

import {
  buildDecision,
  type DecisionDraft,
  emptyDraft,
  gateState,
} from "../lib/gate.js";
import { ApprovalCard } from "./approval-card.js";

/**
 * The queue of gates waiting on a human.
 *
 * All the decision state lives here rather than in the card, so a decision is
 * assembled in one place and every submission goes through `buildDecision`.
 * A keyboard shortcut opens the confirmation step; it never submits. 012 §4.2
 * asks for a confirmation on high-risk approvals — the SDK exposes no risk
 * class, and an approval that dispatches an effect is high-risk by
 * construction, so every approval is confirmed.
 */

export type DecisionOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface ApprovalInboxProps {
  readonly approvals: readonly ApprovalView[];
  /** The sealed artifact fingerprint every gate on this run is bound to. */
  readonly fingerprint: string;
  readonly now: number;
  readonly onDecide: (
    approvalId: string,
    decision: Decision,
  ) => Promise<DecisionOutcome>;
}

const SHORTCUTS = new Set(["j", "k", "a", "r"]);

/** Typing a rejection reason must not be read as a shortcut. */
function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement
  );
}

export function ApprovalInbox({
  approvals,
  fingerprint,
  now,
  onDecide,
}: ApprovalInboxProps) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, DecisionDraft>>>(
    {},
  );
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const items = useRef<(HTMLLIElement | null)[]>([]);

  const setDraft = (approvalId: string, draft: DecisionDraft) => {
    setDrafts((current) => ({ ...current, [approvalId]: draft }));
    setErrors((current) => ({ ...current, [approvalId]: "" }));
  };

  const focusAt = (index: number) => {
    const clamped = Math.max(0, Math.min(index, approvals.length - 1));
    items.current[clamped]?.focus();
  };

  const submit = async (approval: ApprovalView) => {
    const id = approval.approvalId;
    const outcome = buildDecision(drafts[id] ?? emptyDraft);
    if (!outcome.ok) {
      setErrors((current) => ({ ...current, [id]: outcome.message }));
      return;
    }

    setBusyId(id);
    const result = await onDecide(id, outcome.decision);
    setBusyId(undefined);

    if (result.ok) {
      setDrafts((current) => ({ ...current, [id]: emptyDraft }));
      setErrors((current) => ({ ...current, [id]: "" }));
      return;
    }
    setErrors((current) => ({ ...current, [id]: result.message }));
  };

  const handleKey = (event: KeyboardEvent<HTMLLIElement>, index: number) => {
    if (isTextEntry(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const key = event.key.toLowerCase();
    if (!SHORTCUTS.has(key)) return;
    event.preventDefault();

    if (key === "j" || key === "k") {
      focusAt(key === "j" ? index + 1 : index - 1);
      return;
    }

    const approval = approvals[index];
    // A shortcut must not reach a gate that is no longer open to an answer.
    if (approval === undefined || gateState(approval, now) !== "pending")
      return;
    setDraft(approval.approvalId, {
      ...emptyDraft,
      mode: key === "a" ? "approve" : "reject",
    });
  };

  if (approvals.length === 0)
    return (
      <section aria-label="Approval inbox" className="rounded-lg border p-4">
        <h2 className="text-lg font-semibold">Approval inbox</h2>
        <p className="mt-3">No gate is waiting on a decision.</p>
      </section>
    );

  return (
    <section aria-label="Approval inbox" className="rounded-lg border p-4">
      <h2 className="text-lg font-semibold">Approval inbox</h2>
      <p className="mt-1 text-sm opacity-70">
        {approvals.length} gate{approvals.length === 1 ? "" : "s"} bound to
        artifact <code className="break-all">{fingerprint}</code>. Keys:{" "}
        <kbd>j</kbd> and <kbd>k</kbd> move, <kbd>a</kbd> starts an approval,{" "}
        <kbd>r</kbd> starts a rejection. Both still need confirming.
      </p>
      <ul className="mt-3 space-y-4">
        {approvals.map((approval, index) => (
          <li
            key={approval.approvalId}
            // Roving focus: the item is the keyboard target, the card inside
            // keeps its own buttons and fields reachable by Tab.
            tabIndex={-1}
            ref={(node) => {
              items.current[index] = node;
            }}
            onKeyDown={(event) => handleKey(event, index)}
          >
            <ApprovalCard
              approval={approval}
              fingerprint={fingerprint}
              now={now}
              draft={drafts[approval.approvalId] ?? emptyDraft}
              busy={busyId === approval.approvalId}
              {...(errors[approval.approvalId]
                ? { error: errors[approval.approvalId] }
                : {})}
              onDraftChange={(draft) => setDraft(approval.approvalId, draft)}
              onSubmit={() => void submit(approval)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
