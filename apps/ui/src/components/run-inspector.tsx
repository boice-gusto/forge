import type { ApprovalView, RunView } from "@forge/sdk";

import { buildTimeline } from "../lib/timeline.js";

/**
 * What a run actually did.
 *
 * The section that matters is the effect ledger: the list of nodes whose
 * effect was really dispatched. Status says what the runtime believes; the
 * ledger says what reached the outside world, and only the second one is
 * evidence.
 */

export interface RunInspectorProps {
  readonly run: RunView;
  readonly approvals: readonly ApprovalView[];
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

function Fact({
  term,
  value,
}: {
  readonly term: string;
  readonly value: string;
}) {
  return (
    <div className="flex flex-wrap gap-x-2 py-1">
      <dt className="w-44 shrink-0 opacity-70">{term}</dt>
      <dd className="min-w-0 break-all font-medium">{value}</dd>
    </div>
  );
}

export function RunInspector({ run, approvals, now }: RunInspectorProps) {
  const timeline = buildTimeline(run, approvals, now);

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
        <Fact term="Workflow" value={run.workflowId} />
        <Fact term="Status" value={run.status} />
        <Fact term="Attempt" value={String(run.attempt)} />
        <Fact term="Artifact fingerprint" value={run.fingerprint} />
        <Fact term="Pending gate" value={run.pendingApprovalId ?? "None"} />
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

      <h3 className="mt-4 text-base font-semibold">Timeline</h3>
      <ol aria-label="Run timeline" className="mt-2 space-y-2 text-sm">
        {timeline.map((entry) => (
          <li key={entry.id} data-timeline-kind={entry.kind}>
            <p className="font-medium">
              <span aria-hidden="true">{entry.mark} </span>
              {entry.label}
            </p>
            <p className="opacity-70">{entry.detail}</p>
          </li>
        ))}
      </ol>

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
