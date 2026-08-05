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
}

/** What a run is made of, read back whole. */
export interface PersistedRun {
  readonly record: RunRecord;
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
   * Replaces the mutable record. Written from the runtime's single transition
   * point, so a status change cannot be persisted at eight call sites and
   * missed at the ninth. A run that was never created is refused.
   */
  update(record: RunRecord): Promise<void>;
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
}
