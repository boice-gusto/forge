import type { ApprovalView, RunEventView, RunView } from "@forge/sdk";

import { presentGate } from "../lib/gate.js";
import { buildTimeline } from "../lib/timeline.js";
import { Fact } from "./fact.js";

/**
 * What a run actually did.
 *
 * The section that matters is the effect ledger: the list of nodes whose
 * effect was really dispatched. Status says what the runtime believes; the
 * ledger says what reached the outside world, and only the second one is
 * evidence.
 *
 * Gates are listed whatever their outcome. A refusal is the outcome most worth
 * being able to audit, and a screen that showed only what is still pending
 * would make a rejected gate indistinguishable from one that never existed.
 */

export interface RunInspectorProps {
  readonly run: RunView;
  /** Every gate this run opened, decided ones included. */
  readonly approvals: readonly ApprovalView[];
  readonly events: readonly RunEventView[];
  readonly now: number;
}

const STATUS_MARK: Readonly<Record<string, string>> = {
  PENDING: "◌",
  RUNNING: "▸",
  AWAITING_APPROVAL: "◆",
  SUCCEEDED: "✓",
  FAILED: "✕",
  CANCELLED: "⊘",
};

/** Who decided, when, and why — or that nobody has yet. */
function GateAudit({ approval }: { readonly approval: ApprovalView }) {
  if (approval.decidedBy === undefined)
    return <p className="opacity-70">No decision has been recorded.</p>;

  return (
    <p className="opacity-70">
      Decided by {approval.decidedBy} at {approval.decidedAt}
      {approval.reason === undefined ? "." : `: ${approval.reason}`}
    </p>
  );
}

function Gates({
  approvals,
  now,
}: {
  readonly approvals: readonly ApprovalView[];
  readonly now: number;
}) {
  if (approvals.length === 0)
    return <p className="mt-2 text-sm">This run has opened no gate.</p>;

  return (
    <ul aria-label="Gates" className="mt-2 space-y-2 text-sm">
      {approvals.map((approval) => {
        const presentation = presentGate(approval, now);
        return (
          <li
            key={approval.approvalId}
            data-gate-state={presentation.state}
            className="rounded border p-2"
          >
            <p className="font-medium">
              <span aria-hidden="true">{presentation.mark} </span>
              {approval.effect} at {approval.nodeId} — {presentation.label}
            </p>
            <p className="break-all opacity-70">
              Binding <code>{approval.effectHash}</code>. Policy{" "}
              {approval.policyId}.
            </p>
            <GateAudit approval={approval} />
          </li>
        );
      })}
    </ul>
  );
}

export function RunInspector({
  run,
  approvals,
  events,
  now,
}: RunInspectorProps) {
  const timeline = buildTimeline(events);

  return (
    <section aria-label="Run inspector" className="rounded-lg border p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Run {run.runId}</h2>
        <p className="text-sm">
          <span aria-hidden="true">{STATUS_MARK[run.status] ?? "•"} </span>
          {run.status}
        </p>
      </header>

      <dl className="mt-3 text-sm">
        <Fact term="Workflow">{run.workflowId}</Fact>
        <Fact term="Status">{run.status}</Fact>
        <Fact term="Attempt">{run.attempt}</Fact>
        <Fact term="Artifact fingerprint">{run.fingerprint}</Fact>
        <Fact term="Pending gate">{run.pendingApprovalId ?? "None"}</Fact>
      </dl>

      <h3 className="mt-4 text-base font-semibold">Effects dispatched</h3>
      {run.performedEffects.length === 0 ? (
        <p className="mt-2 text-sm">
          Nothing has been dispatched. No side effect has reached anyone.
        </p>
      ) : (
        <ol
          aria-label="Effects dispatched"
          className="mt-2 list-decimal space-y-1 pl-6 text-sm"
        >
          {run.performedEffects.map((nodeId) => (
            <li key={nodeId} className="break-all font-mono">
              {nodeId}
            </li>
          ))}
        </ol>
      )}

      <h3 className="mt-4 text-base font-semibold">Gates</h3>
      <Gates approvals={approvals} now={now} />

      <h3 className="mt-4 text-base font-semibold">Timeline</h3>
      {timeline.length === 0 ? (
        <p className="mt-2 text-sm">
          The control plane has reported no event for this run.
        </p>
      ) : (
        <ol aria-label="Run timeline" className="mt-2 space-y-2 text-sm">
          {timeline.map((entry) => (
            <li key={entry.id} data-timeline-kind={entry.kind}>
              <p className="font-medium">
                <span aria-hidden="true">{entry.mark} </span>
                {entry.label}
              </p>
              <p className="break-all opacity-70">{entry.detail}</p>
            </li>
          ))}
        </ol>
      )}

      {run.error === undefined ? null : (
        <>
          <h3 className="mt-4 text-base font-semibold">Diagnostic</h3>
          <p role="alert" className="mt-2 break-all text-sm">
            {run.error}
          </p>
        </>
      )}
    </section>
  );
}
