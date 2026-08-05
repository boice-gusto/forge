import type { ApprovalView } from "@forge/sdk";

import {
  type DecisionDraft,
  emptyDraft,
  type GatePresentation,
  presentGate,
  remainingLabel,
} from "../lib/gate.js";
import { Fact } from "./fact.js";

/**
 * One gate, rendered so that refusing it is as easy as granting it.
 *
 * The card is deliberately stateless. Whether a decision is submittable is
 * decided by `buildDecision`, and what is sent is decided by the inbox, so the
 * component cannot drift into holding a decision the operator never confirmed.
 */

export interface ApprovalCardProps {
  readonly approval: ApprovalView;
  readonly now: number;
  readonly draft: DecisionDraft;
  readonly busy?: boolean;
  readonly error?: string;
  readonly onDraftChange: (draft: DecisionDraft) => void;
  readonly onSubmit: () => void;
}

const FIELD = "mt-1 w-full rounded border p-2 font-mono text-sm" as const;
const BUTTON = "rounded border px-3 py-1.5 text-sm font-medium" as const;

/**
 * The binding, stated in full. An operator who cannot see the exact action is
 * not deciding anything — they are rubber-stamping, which is the failure this
 * whole system exists to prevent.
 */
function Binding({
  approval,
  now,
}: {
  readonly approval: ApprovalView;
  readonly now: number;
}) {
  return (
    <>
      <p className="mt-3 rounded border-l-4 p-3 text-sm">
        This authorises <strong>one</strong> action: effect{" "}
        <strong>{approval.effect}</strong> at node{" "}
        <strong>{approval.nodeId}</strong> of run{" "}
        <strong>{approval.runId}</strong>, under binding{" "}
        <code className="break-all">{approval.effectHash}</code>. It authorises
        nothing else, on no other node, in no other run.
      </p>
      <dl className="mt-3 text-sm">
        <Fact term="Node">{approval.nodeId}</Fact>
        <Fact term="Effect">{approval.effect}</Fact>
        <Fact term="Deciding policy">{approval.policyId}</Fact>
        <Fact term="Approvers">
          {approval.approvers.length === 0
            ? "None named by the policy"
            : approval.approvers.join(", ")}
        </Fact>
        <Fact term="Expires">
          {approval.expiresAt} ({remainingLabel(approval.expiresAt, now)})
        </Fact>
        <Fact term="Run">{approval.runId}</Fact>
        {/*
          The binding, not the artifact fingerprint. The fingerprint says which
          compiled workflow; the binding says which action inside it — run,
          node, effect and fingerprint together. Showing the weaker one would
          let two different actions look identical to the operator.
        */}
        <Fact term="Binding (effect hash)">
          <code>{approval.effectHash}</code>
        </Fact>
      </dl>
    </>
  );
}

function Confirm({
  prompt,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  readonly prompt: string;
  readonly submitLabel: string;
  readonly busy: boolean;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <div className="mt-3">
      <p className="text-sm">{prompt}</p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
        <button type="button" className={BUTTON} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function PendingActions({
  approval,
  draft,
  busy,
  onDraftChange,
  onSubmit,
}: {
  readonly approval: ApprovalView;
  readonly draft: DecisionDraft;
  readonly busy: boolean;
  readonly onDraftChange: (draft: DecisionDraft) => void;
  readonly onSubmit: () => void;
}) {
  const cancel = () => onDraftChange(emptyDraft);
  const reasonId = `${approval.approvalId}-reason`;
  const patchId = `${approval.approvalId}-patch`;

  if (draft.mode === "approve")
    return (
      <Confirm
        prompt={`Authorise ${approval.effect} at node ${approval.nodeId}? This dispatches the effect.`}
        submitLabel={`Yes, authorise ${approval.effect}`}
        busy={busy}
        onSubmit={onSubmit}
        onCancel={cancel}
      />
    );

  if (draft.mode === "reject")
    return (
      <div className="mt-3">
        <label className="text-sm font-medium" htmlFor={reasonId}>
          Why are you refusing this?
        </label>
        <textarea
          id={reasonId}
          className={FIELD}
          rows={3}
          value={draft.reason}
          onChange={(event) =>
            onDraftChange({ ...draft, reason: event.target.value })
          }
        />
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={onSubmit}
          >
            Confirm rejection
          </button>
          <button type="button" className={BUTTON} onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    );

  if (draft.mode === "edit")
    return (
      <div className="mt-3">
        <p className="rounded border-l-4 p-3 text-sm">
          An edit <strong>authorises nothing</strong>. The amended action gets a
          new binding, so this gate is reissued and has to be decided again.
        </p>
        <label className="mt-2 block text-sm font-medium" htmlFor={patchId}>
          Patch (JSON)
        </label>
        <textarea
          id={patchId}
          className={FIELD}
          rows={5}
          value={draft.patch}
          onChange={(event) =>
            onDraftChange({ ...draft, patch: event.target.value })
          }
        />
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={onSubmit}
          >
            Reissue gate on the amended action
          </button>
          <button type="button" className={BUTTON} onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    );

  return (
    <div className="mt-3 flex gap-2">
      <button
        type="button"
        className={BUTTON}
        onClick={() => onDraftChange({ ...emptyDraft, mode: "approve" })}
      >
        Approve
      </button>
      <button
        type="button"
        className={BUTTON}
        onClick={() => onDraftChange({ ...emptyDraft, mode: "reject" })}
      >
        Reject
      </button>
      <button
        type="button"
        className={BUTTON}
        onClick={() => onDraftChange({ ...emptyDraft, mode: "edit" })}
      >
        Edit
      </button>
    </div>
  );
}

/**
 * An expired gate offers no approve button at all. Approve and reject are
 * answers to a question that is no longer open; the only thing left to record
 * is that it ran out of time.
 */
function ExpiredActions({
  draft,
  busy,
  onDraftChange,
  onSubmit,
}: {
  readonly draft: DecisionDraft;
  readonly busy: boolean;
  readonly onDraftChange: (draft: DecisionDraft) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <div className="mt-3">
      <p className="rounded border-l-4 p-3 text-sm">
        This gate ran out of time. An expired gate is a{" "}
        <strong>timeout, not a slow yes</strong> — it can no longer be approved
        or rejected. Re-run the workflow if the action is still wanted.
      </p>
      {draft.mode === "timeout" ? (
        <Confirm
          prompt="Record the timeout against this gate?"
          submitLabel="Record timeout"
          busy={busy}
          onSubmit={onSubmit}
          onCancel={() => onDraftChange(emptyDraft)}
        />
      ) : (
        <button
          type="button"
          className={`${BUTTON} mt-2`}
          onClick={() => onDraftChange({ ...emptyDraft, mode: "timeout" })}
        >
          Record timeout
        </button>
      )}
    </div>
  );
}

function Actions(
  props: ApprovalCardProps & { readonly presentation: GatePresentation },
) {
  const busy = props.busy ?? false;

  if (props.presentation.state === "decided")
    return (
      <p className="mt-3 text-sm">
        Already decided. Decisions are single-use; deciding again is a no-op.
      </p>
    );

  if (props.presentation.state === "expired")
    return (
      <ExpiredActions
        draft={props.draft}
        busy={busy}
        onDraftChange={props.onDraftChange}
        onSubmit={props.onSubmit}
      />
    );

  return (
    <PendingActions
      approval={props.approval}
      draft={props.draft}
      busy={busy}
      onDraftChange={props.onDraftChange}
      onSubmit={props.onSubmit}
    />
  );
}

export function ApprovalCard(props: ApprovalCardProps) {
  const { approval, now, error } = props;
  const presentation = presentGate(approval, now);
  const headingId = `${approval.approvalId}-heading`;

  return (
    <article
      aria-labelledby={headingId}
      className="rounded-lg border p-4"
      data-gate-state={presentation.state}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={headingId} className="text-base font-semibold">
          {approval.effect} at {approval.nodeId}
        </h3>
        <p className="text-sm">
          <span aria-hidden="true">{presentation.mark} </span>
          {presentation.label}
        </p>
      </header>

      <Binding approval={approval} now={now} />

      {error === undefined ? null : (
        <p role="alert" className="mt-3 text-sm font-medium">
          {error}
        </p>
      )}

      <Actions {...props} presentation={presentation} />
    </article>
  );
}
