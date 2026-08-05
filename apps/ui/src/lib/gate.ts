import type { ApprovalView, Decision } from "@forge/sdk";

/**
 * Gate presentation rules, kept out of the components so the one thing an
 * operator must never be misled about is testable on its own.
 *
 * 006 §6.4 makes `timeout` a decision kind alongside approve and reject. That
 * is the whole reason an expired gate cannot be drawn like a pending one: it
 * is not a slow yes, it is an outcome that already happened.
 */

export type GateState = "pending" | "expired" | "decided";

export interface GatePresentation {
  readonly state: GateState;
  /** Paired with the label so status is never carried by colour alone. */
  readonly mark: string;
  readonly label: string;
}

const DECIDED: Readonly<Record<string, string>> = {
  APPROVED: "Approved",
  REJECTED: "Rejected",
  EDITED: "Edited — gate reissued",
  TIMED_OUT: "Timed out",
};

export function gateState(approval: ApprovalView, now: number): GateState {
  if (approval.status.toUpperCase() !== "PENDING") return "decided";
  const expiresAt = Date.parse(approval.expiresAt);
  // Fail closed: an expiry we cannot read is not evidence that time remains.
  return Number.isNaN(expiresAt) || expiresAt <= now ? "expired" : "pending";
}

export function presentGate(
  approval: ApprovalView,
  now: number,
): GatePresentation {
  const state = gateState(approval, now);
  if (state === "pending")
    return { state, mark: "◆", label: "Awaiting your decision" };
  if (state === "expired")
    return { state, mark: "⧗", label: "Expired — timed out, not approved" };
  return {
    state,
    mark: "✓",
    label: DECIDED[approval.status.toUpperCase()] ?? approval.status,
  };
}

export function remainingLabel(expiresAt: string, now: number): string {
  const ms = Date.parse(expiresAt) - now;
  if (Number.isNaN(ms)) return "expiry unreadable";
  if (ms <= 0) return "expired";

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m left`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h left`;
}

/**
 * `idle` is a real state, not a placeholder: nothing is submittable until the
 * operator has said which of the four decisions they mean.
 */
export type DecisionMode = "idle" | "approve" | "reject" | "edit" | "timeout";

export interface DecisionDraft {
  readonly mode: DecisionMode;
  readonly reason: string;
  readonly patch: string;
}

export const emptyDraft: DecisionDraft = {
  mode: "idle",
  reason: "",
  patch: "",
};

export type DraftOutcome =
  | { readonly ok: true; readonly decision: Decision }
  | { readonly ok: false; readonly message: string };

export function buildDecision(draft: DecisionDraft): DraftOutcome {
  if (draft.mode === "approve")
    return { ok: true, decision: { kind: "approve" } };
  if (draft.mode === "timeout")
    return { ok: true, decision: { kind: "timeout" } };

  if (draft.mode === "reject") {
    const reason = draft.reason.trim();
    return reason === ""
      ? { ok: false, message: "A rejection needs a reason. It is recorded." }
      : { ok: true, decision: { kind: "reject", reason } };
  }

  if (draft.mode === "edit") {
    if (draft.patch.trim() === "")
      return { ok: false, message: "An edit needs a patch." };
    try {
      return {
        ok: true,
        decision: { kind: "edit", patch: JSON.parse(draft.patch) },
      };
    } catch (error) {
      return {
        ok: false,
        message: `The patch must be valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  return { ok: false, message: "Choose approve, reject or edit first." };
}
