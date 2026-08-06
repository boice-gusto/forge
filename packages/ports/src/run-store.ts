import type { JsonValue } from "./data.js";

/**
 * The durable run store (006 §5, §9 "Durable checkpointer / run store").
 *
 * `AWAITING_APPROVAL` is first-class durable state: a gate may stay open for
 * days, and the process that opened it will often not be the process that
 * carries the decision out. Everything a second process needs to re-enter a run
 * it never started lives here — the record, the sealed artifact, and the three
 * ledgers the runtime keeps.
 *
 * The ledgers are separate on purpose. Each one pins a different kind of thing
 * that must not happen twice:
 *
 * - **values** — what each node produced. An agent is a model call, not a pure
 *   function; a rehydrated run must act on what it produced before parking.
 * - **routes** — which arm a judge or branch took. A verdict re-asked after a
 *   human decided could route the run away from the effect that was approved.
 * - **effects** — what was dispatched. Claimed *before* the action, so
 *   exactly-once survives a process ending mid-dispatch.
 */

/**
 * Run lifecycle (006 §5).
 *
 * PENDING -> RUNNING -> AWAITING_APPROVAL -> RUNNING -> SUCCEEDED
 *                    \-> FAILED
 *                    \-> CANCELLED
 *
 * Retrying is not a state: the run stays RUNNING and the attempt increments.
 */
export type RunStatus =
  | "PENDING"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

/**
 * The failures a run store raises, as codes rather than prose.
 *
 * These are **control flow across a package boundary**, which is what makes
 * them worth naming. A store throws one; the runtime decides whether to cede
 * or propagate by matching on it; the API turns it into a status code. That is
 * three packages agreeing on a string, and until now they agreed by all
 * spelling it correctly. A store that renamed one would not fail to compile —
 * the runtime would simply stop recognising a conflict and start propagating
 * it, and a redundant queue delivery would begin dead-lettering healthy runs.
 *
 * Carried as a message prefix rather than an error subclass because these
 * cross a process boundary in a job's failure text as often as they cross a
 * function call.
 */
export const RUN_STORE_ERRORS = {
  /** The record moved on since the writer read it. See `update`. */
  conflict: "FORGE_RUN_CONFLICT",
  /** No such run. Distinct from a run that exists and is in a bad state. */
  notFound: "FORGE_RUN_NOT_FOUND",
  /** A run id that already exists; two runs sharing one is one run. */
  exists: "FORGE_RUN_EXISTS",
  /** Nothing has claimed this node's effect, so there is nothing to settle. */
  effectNotClaimed: "FORGE_EFFECT_NOT_CLAIMED",
  /** The action completed. Redriving it is the failure the claim prevents. */
  effectSettled: "FORGE_EFFECT_SETTLED",
} as const;

export type RunStoreErrorCode =
  (typeof RUN_STORE_ERRORS)[keyof typeof RUN_STORE_ERRORS];

/**
 * A run that will not move again on its own.
 *
 * `AWAITING_APPROVAL` is **not** here, and that omission is the whole reason
 * this constant exists. A parked run has stopped, but it has not finished —
 * it moves the moment a human decides. Seven places in this repository had
 * each written their own version of this set by hand, one of them was missing
 * `CANCELLED`, and a helper that counted a gate as settled returned instantly
 * on a run already at one, which made a working feature look broken for a day.
 *
 * If what you mean is "stopped for now", say {@link hasStopped}.
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);

/**
 * A run that is not going to move without something outside it happening —
 * terminal, or waiting on a human.
 *
 * The right thing to poll for when what you want is "has it stopped moving".
 * The wrong thing to poll for after a decision, because a run at a gate
 * already satisfies it: wait for the effect, the status change, or the
 * approval to clear instead.
 */
export const STOPPED_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  ...TERMINAL_RUN_STATUSES,
  "AWAITING_APPROVAL" as const,
]);

/** Finished, one way or another. Never true of a run parked at a gate. */
export const isTerminalRun = (status: RunStatus): boolean =>
  TERMINAL_RUN_STATUSES.has(status);

/** Stopped for now, which includes parked at a gate. */
export const hasStopped = (status: RunStatus): boolean =>
  STOPPED_RUN_STATUSES.has(status);

export interface RunRecord {
  readonly runId: string;
  readonly workflowId: string;
  readonly fingerprint: string;
  readonly status: RunStatus;
  readonly attempt: number;
  readonly performedEffects: readonly string[];
  readonly pendingApprovalId?: string | undefined;
  readonly error?: string | undefined;
  /** What the output node resolved to, once one has run. */
  readonly result?: JsonValue | undefined;
  /**
   * The trace this run belongs to, in W3C form.
   *
   * A run is created by one process, walked by whichever worker takes the job,
   * and resumed by a third after a human decides — so the span opened at
   * creation is gone by the time most of the run happens. Without this, every
   * one of those is a root, and a run reads in a tracing backend as a pile of
   * unrelated traces that happen to share a `runId` attribute. With it, the
   * question an incident actually asks — *what did this run do, in order* —
   * has one answer.
   *
   * Absent when the observability adapter cannot express one; a missing edge
   * costs a trace, never a run.
   */
  readonly traceparent?: string | undefined;
  /**
   * The node whose pending approval is a *redrive* rather than a first
   * authorisation.
   *
   * On the record because the decision may be processed by a process that
   * never saw the request. Without it, a resuming worker would carry the gate
   * as an ordinary one, find the node already in the effect ledger, and skip
   * the very action the human just authorised — a decision that reads as
   * honoured and changes nothing.
   */
  readonly redriving?: string | undefined;
  /**
   * Where this run was asked for, when it was not asked for through the API.
   *
   * Persisted because nothing downstream can reconstruct it: the process that
   * tells a Slack thread its run has reached a gate is a worker that never saw
   * the webhook. It is also what an operator reads at three in the morning to
   * learn whether a human typed this or a webhook fired it.
   *
   * Structurally the same as `@forge/intake`'s `RequestOrigin` and
   * deliberately not imported from it: intake depends on ports, so the arrow
   * cannot run the other way. Three fields duplicated is cheaper than a cycle,
   * and the compiler catches a drift at every call site that carries one
   * across.
   */
  readonly origin?:
    | {
        readonly channel: string;
        readonly externalId: string;
        readonly externalActor: string;
      }
    | undefined;
}

/**
 * The sealed artifact, as the store holds it.
 *
 * `ir` is typed as JSON rather than as `ForgeIr` because `@forge/ports` sits
 * beside `@forge/ir` rather than above it; the runtime narrows it on the way
 * back out. Storing it at all is what lets a second process resume from a run
 * id alone — until there is an artifact registry, the run row is one.
 *
 * It is not trusted blindly. `fingerprint` travels with it, and the approval's
 * `effectHash` — written to a *different* store by the process that parked —
 * only recomputes if run, node, effect and fingerprint all still agree.
 */
export interface StoredArtifact {
  readonly workflowId: string;
  readonly fingerprint: string;
  readonly ir: JsonValue;
}

/** A node's output, pinned. */
export interface PinnedValue {
  readonly nodeId: string;
  /**
   * Absent means the node ran and produced nothing, which is not the same as
   * a node that has not run: a read past the first must fail, and a read past
   * the second must not be attempted at all.
   */
  readonly value?: JsonValue | undefined;
}

/** The arm a judge or branch took, pinned. */
export interface PinnedRoute {
  readonly nodeId: string;
  readonly arm: string;
}

export interface EffectClaim {
  readonly runId: string;
  readonly nodeId: string;
  readonly effect: string;
  /** What the action was performed *on*, so an audit can show it was the one approved. */
  readonly input?: JsonValue | undefined;
  readonly at: string;
}

export interface DispatchedEffect {
  readonly nodeId: string;
  readonly effect: string;
  readonly input?: JsonValue | undefined;
  readonly dispatchedAt: string;
  /**
   * When the action came back. Absent means it was claimed and never seen to
   * finish — see {@link RunStorePort.listUnsettled}.
   */
  readonly settledAt?: string | undefined;
}

/**
 * An action a run claimed and was never seen to complete.
 *
 * The claim is written before the action, deliberately: a crash between the
 * two loses an effect, and a crash the other way round performs one twice, and
 * for a system whose premise is that a human authorised exactly one action,
 * losing one is recoverable and repeating one is not.
 *
 * "Recoverable" is only true if somebody is told. Until now nothing was: the
 * run went on, the ledger said the node had dispatched, and the action the
 * human approved silently never happened. This is the record of that gap.
 *
 * It is not, by itself, proof the action did not happen — the process may have
 * died after the call landed and before it could say so. That ambiguity is why
 * this is a report to an operator rather than an input to an automatic retry.
 */
export interface UnsettledEffect {
  readonly runId: string;
  readonly nodeId: string;
  readonly effect: string;
  /** When the claim was taken. */
  readonly claimedAt: string;
}

/** What a run is made of, read back whole. */
export interface PersistedRun {
  readonly record: RunRecord;
  /**
   * Which version of the record this is, for {@link RunStorePort.update}.
   *
   * A counter, not a clock and not a hash: it has to be totally ordered and
   * it has to change on every write, including a write that happens to store
   * the same bytes. Whoever loaded a run presents this back when it writes,
   * and a mismatch means somebody else wrote in between.
   */
  readonly revision: number;
  readonly artifact: StoredArtifact;
  readonly capabilities: readonly string[];
  readonly changedPaths: readonly string[];
  readonly values: readonly PinnedValue[];
  readonly routes: readonly PinnedRoute[];
  /** In dispatch order. */
  readonly effects: readonly DispatchedEffect[];
}

/** The half of a run that never changes after it starts. */
export interface RunCreateInput {
  readonly record: RunRecord;
  readonly artifact: StoredArtifact;
  readonly capabilities: readonly string[];
  readonly changedPaths: readonly string[];
}

/**
 * What to narrow a listing to.
 *
 * Deliberately one field. An operator arriving at an inbox wants "what is
 * waiting on somebody" and "what just happened"; anything past that is a query
 * language nobody has asked for yet, and a half-built one is worse than none.
 */
export interface RunListQuery {
  readonly status?: RunStatus;
}

export interface RunStorePort {
  /**
   * Writes a run for the first time. A run id that already exists is refused:
   * two runs sharing an id are one run as far as every index is concerned, and
   * the second would silently displace the first.
   */
  create(input: RunCreateInput): Promise<void>;
  load(runId: string): Promise<PersistedRun | undefined>;
  /**
   * Every run this store holds, **most recent first** — the order an operator
   * needs, because the run they are looking for is nearly always the one that
   * just happened.
   *
   * "Most recent" is the order runs were created in, not a timestamp: two runs
   * starting in the same millisecond would tie, and a tie in a list is a run
   * that moves about between two reads.
   *
   * This exists because the control plane used to enumerate its own in-process
   * map, so a restart emptied the run list while every one of those runs was
   * still sitting in Postgres. The store is the record; a Map is a cache of it.
   */
  list(query?: RunListQuery): Promise<readonly RunRecord[]>;
  /**
   * Replaces the mutable record, if nobody else has. Returns the new revision.
   *
   * Written from the runtime's single transition point, so a status change
   * cannot be persisted at eight call sites and missed at the ninth. A run
   * that was never created is refused.
   *
   * `expectedRevision` is the one that came back with the load this record was
   * derived from. If the stored revision has moved on, the write is refused
   * with `FORGE_RUN_CONFLICT` rather than applied — because a blind write here
   * is a lost update, and the fields it would lose are the ones that matter:
   * `status`, and `pendingApprovalId`. Two processes both advancing a run,
   * one parking it at a gate and the other overwriting that with `RUNNING`,
   * produces a run waiting on an approval nothing will ever look for.
   *
   * That is already meant to be impossible — a run advances only from a queue
   * job, and the queue delivers once. This is the store declining to depend on
   * that, because "the layer above is careful" is not an invariant, it is an
   * assumption about code somebody may reasonably change.
   */
  update(record: RunRecord, expectedRevision: number): Promise<number>;
  /**
   * Pins a node's output. **First write wins** — a second pin for the same node
   * leaves the first in place, because a value a human approved must not be
   * overwritten by one computed later.
   */
  pinValue(
    runId: string,
    nodeId: string,
    value: JsonValue | undefined,
  ): Promise<void>;
  /** Pins the arm a routing node took. First write wins, for the same reason. */
  pinRoute(runId: string, nodeId: string, arm: string): Promise<void>;
  /**
   * Claims the single dispatch for one node of one run.
   *
   * `true` means the caller now owns the action and must perform it. `false`
   * means it is already claimed — in this process, in one that has ended, or
   * by another worker a moment ago. The claim is written *before* the action:
   * a crash between the two loses an effect, and a crash the other way round
   * performs one twice. For a system whose premise is that a human authorised
   * exactly one action, losing one is recoverable and repeating one is not.
   */
  claimEffect(claim: EffectClaim): Promise<boolean>;
  /**
   * Records that a claimed action came back.
   *
   * Separate from the claim because the whole point is the window between
   * them. Settling in the same write would make the claim a record of
   * completion, which is the guarantee this system cannot offer.
   */
  settleEffect(runId: string, nodeId: string, at: string): Promise<void>;
  /**
   * Every action claimed and never settled, oldest claim first.
   *
   * The estate-wide question, asked without knowing a run id, because nobody
   * knows to go looking at the run this happened to. An operator reads this;
   * nothing acts on it (see {@link UnsettledEffect}).
   *
   * `limit` is required rather than optional, and there is no "all". The day
   * this matters is the day an outage has left thousands outstanding — the one
   * day an operator most needs the page to load, and the one day an unbounded
   * query is slowest. A caller that has to name a number cannot forget to.
   *
   * Oldest first, so the bound keeps the least explained rather than an
   * arbitrary slice: an action outstanding for a week is a worse fact than one
   * outstanding for a minute, and a page that dropped the old ones to show the
   * new would hide exactly the entries worth acting on.
   */
  listUnsettled(limit: number): Promise<readonly UnsettledEffect[]>;
}
