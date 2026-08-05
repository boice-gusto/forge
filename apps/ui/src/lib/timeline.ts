import type { ApprovalView, RunView } from "@forge/sdk";

import { presentGate } from "./gate.js";

/**
 * The run timeline the SDK can honestly support today.
 *
 * 012 §4.3 describes a `ForgeEvent` stream from `GET /runs/:id/events`. That
 * route does not exist yet, so the timeline is derived from the two facts the
 * control plane does expose: the effect ledger — which is ordered, and is the
 * record of what actually reached the outside world — and the gates still
 * pending. Nothing here is inferred beyond that; an empty ledger is shown as
 * an empty ledger rather than as an assumed sequence of nodes.
 */

export type TimelineKind = "run" | "effect" | "gate" | "diagnostic";

export interface TimelineEntry {
  readonly id: string;
  readonly kind: TimelineKind;
  readonly mark: string;
  readonly label: string;
  readonly detail: string;
}

const STATUS_DETAIL: Readonly<Record<string, string>> = {
  PENDING: "Accepted; the walk has not started.",
  RUNNING: "Executing, or waiting on a retry of a failed node.",
  AWAITING_APPROVAL: "Durably interrupted at a gate. No worker is held.",
  SUCCEEDED: "Terminal. The walk finished.",
  FAILED: "Terminal. See the diagnostic below.",
  CANCELLED: "Terminal. Cancelled or timed out by policy.",
};

export function buildTimeline(
  run: RunView,
  approvals: readonly ApprovalView[],
  now: number,
): readonly TimelineEntry[] {
  const entries: TimelineEntry[] = [
    {
      id: "run-start",
      kind: "run",
      mark: "▸",
      label: `Run accepted for ${run.workflowId}`,
      detail: `Attempt ${run.attempt}. A retry increments the attempt; it is not a separate state.`,
    },
  ];

  for (const [index, nodeId] of run.performedEffects.entries()) {
    entries.push({
      id: `effect-${nodeId}`,
      kind: "effect",
      mark: "→",
      label: `Effect dispatched at node ${nodeId}`,
      detail: `Ledger entry ${index + 1}. The ledger is what stops a resumed attempt dispatching this twice.`,
    });
  }

  for (const approval of approvals) {
    const presentation = presentGate(approval, now);
    entries.push({
      id: `gate-${approval.approvalId}`,
      kind: "gate",
      mark: presentation.mark,
      label: `Gate on ${approval.nodeId} for ${approval.effect}`,
      detail: `${presentation.label}. Policy ${approval.policyId}.`,
    });
  }

  entries.push({
    id: "run-status",
    kind: "run",
    mark: "■",
    label: `Status ${run.status}`,
    detail: STATUS_DETAIL[run.status] ?? "Unrecognised status.",
  });

  if (run.error !== undefined) {
    entries.push({
      id: "run-error",
      kind: "diagnostic",
      mark: "✕",
      label: "Diagnostic",
      detail: run.error,
    });
  }

  return entries;
}
