import type { RunEventView } from "@forge/sdk";

/**
 * The run timeline, read from the control plane's own event stream
 * (012 §4.3, `GET /runs/:id/events`).
 *
 * Nothing here infers what a run did. Every entry is one `forge.*` event the
 * runtime reported, rendered — so the screen and the trace cannot tell
 * different stories about the same run. An event this build has never heard of
 * is shown with its attributes rather than dropped: a timeline that quietly
 * omits what it does not recognise is worse than one that admits it.
 */

export type TimelineKind = RunEventView["kind"];

export interface TimelineEntry {
  readonly id: string;
  readonly kind: TimelineKind;
  /** Paired with the label so nothing is carried by colour alone. */
  readonly mark: string;
  readonly label: string;
  readonly detail: string;
}

const MARK: Readonly<Record<TimelineKind, string>> = {
  run: "■",
  node: "▸",
  policy: "§",
  approval: "◆",
  effect: "→",
  other: "•",
};

const STATUS_DETAIL: Readonly<Record<string, string>> = {
  PENDING: "Accepted; the walk has not started.",
  RUNNING: "Executing, or waiting on a retry of a failed node.",
  AWAITING_APPROVAL: "Durably interrupted at a gate. No worker is held.",
  SUCCEEDED: "Terminal. The walk finished.",
  FAILED: "Terminal. See the diagnostic below.",
  CANCELLED: "Terminal. Cancelled or timed out by policy.",
};

type Described = { readonly label: string; readonly detail: string };

function attributeList(event: RunEventView): string {
  return Object.entries(event.attributes)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function describe(event: RunEventView): Described {
  const at = event.attributes;
  switch (event.name) {
    case "forge.run.transition":
      return {
        label: `Run ${at.from} → ${at.to}`,
        detail:
          STATUS_DETAIL[String(at.to)] ??
          `Attempt ${at.attempt}. Retrying is not a state.`,
      };
    case "forge.policy.decide":
      return {
        label: `Policy ${at.decision} on ${at.action}`,
        detail:
          at.policyId === undefined
            ? "No rule was named for this decision."
            : `Decided by rule ${at.policyId}, before any human was asked.`,
      };
    case "forge.approval.requested":
      return {
        label: `Gate opened on ${at.nodeId} for ${at.effect}`,
        detail: `Bound to ${at.effectHash}. Expires ${at.expiresAt}.`,
      };
    case "forge.approval.decided":
      return {
        label: `Gate ${at.approvalId} ${at.decision}`,
        detail: `On ${at.effect} at ${at.nodeId}. Decisions are single-use.`,
      };
    case "forge.approval.expired":
      return {
        label: `Gate ${at.approvalId} expired`,
        detail: `A "${at.attempted}" arrived after ${at.expiresAt}. An expired gate is a timeout, not a slow yes.`,
      };
    case "forge.approval.edited":
      return {
        label: `Gate ${at.approvalId} edited, reissued as ${at.reissuedAs}`,
        detail:
          "An edit authorises nothing; the amended action needs its own decision.",
      };
    case "forge.effect.dispatched":
      return {
        label: `Effect ${at.effect} dispatched at ${at.nodeId}`,
        detail: `Ledger entry ${at.sequence}. This is what reached the outside world.`,
      };
    default:
      return { label: event.name, detail: attributeList(event) };
  }
}

export function buildTimeline(
  events: readonly RunEventView[],
): readonly TimelineEntry[] {
  return events.map((event) => ({
    id: `event-${event.seq}`,
    kind: event.kind,
    mark: MARK[event.kind],
    ...describe(event),
  }));
}
