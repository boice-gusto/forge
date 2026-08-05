import { randomUUID } from "node:crypto";

import {
  applyApprovalSchema,
  createPostgresApprovalStore,
} from "@forge/approval-postgres";
import {
  applyCheckpointSchema,
  createPostgresCheckpointStore,
} from "@forge/checkpoint-postgres";
import { createMemoryGraphEngine } from "@forge/engine-memory";
import { createMemoryObservability } from "@forge/observability-memory";
import { createMemoryPolicy, type PolicyRule } from "@forge/policy-memory";
import type {
  ApprovalPort,
  ApprovalRecord,
  CheckpointRecord,
  CheckpointStorePort,
  ClockPort,
  IdPort,
  JsonValue,
  ObservabilityPort,
  QueuePort,
} from "@forge/ports";
import { createMockProvider } from "@forge/provider-mock";
import { createBullMqQueue } from "@forge/queue-bullmq";
import {
  createRuntime,
  type EffectSink,
  type RunRecord,
  type Runtime,
  type SealedArtifact,
  type TransformFn,
} from "@forge/runtime";
import { createMemorySandbox } from "@forge/sandbox";
import pg from "pg";

/**
 * Durable composition root.
 *
 * The sibling of `createLocalStack`, with the two Postgres stores and a real
 * Redis-backed queue in place of the Maps. 004 restricts adapter binding to
 * composition roots, so this file is the one place a connection string is
 * read — and it is read from the environment. **No host, password or
 * connection string is written down here or anywhere else in this repository.**
 *
 * What is durable, and what is not, stated plainly:
 *
 * - Checkpoints, approvals and the effect ledger are rows in Postgres. All
 *   three survive a process ending.
 * - The *runtime's* run state is a Map inside `createRuntime`, and it does
 *   not. A second process therefore cannot call `runtime.decide()` on a run it
 *   never started — it would throw "Unknown run".
 *
 * `resume()` below closes that gap from the outside, without the runtime
 * needing to change. It rebuilds the run under its own id, re-walks it, proves
 * the walk landed on exactly the state the human decided on, and only then
 * carries the decision forward. Every one of those steps is a refusal point.
 */

/* -------------------------------------------------------------------------- */
/* Effect ledger                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The third durable store, and the reason exactly-once survives a restart.
 * The runtime keeps an in-process ledger so a resumed walk does not re-dispatch
 * within one process; across processes that Map is gone, and this table is what
 * is left. An effect ledger that does not outlive the process is not a ledger.
 */
export const EFFECT_LEDGER_SCHEMA_SQL = `
create sequence if not exists forge_effect_seq;

create table if not exists forge_effect (
  seq           bigint primary key default nextval('forge_effect_seq'),
  run_id        text not null,
  node_id       text not null,
  effect        text not null,
  -- What the action was performed *on*. Kept so an audit can show that the
  -- action dispatched is the action the approver saw, rather than only that
  -- something with the right name happened.
  input         jsonb,
  output        jsonb,
  dispatched_at text not null,

  -- One dispatch per node per run. Stated where the row lives, because two
  -- workers racing a resume cannot be stopped by a check in JavaScript.
  constraint forge_effect_once unique (run_id, node_id)
);
`;

/** Applies {@link EFFECT_LEDGER_SCHEMA_SQL}. Safe to run on every boot. */
export async function applyEffectLedgerSchema(pool: pg.Pool): Promise<void> {
  await pool.query(EFFECT_LEDGER_SCHEMA_SQL);
}

export interface DispatchedEffect {
  readonly nodeId: string;
  readonly effect: string;
  readonly input: JsonValue | undefined;
  readonly output: JsonValue | undefined;
  readonly dispatchedAt: string;
}

interface EffectRow {
  readonly node_id: string;
  readonly effect: string;
  readonly input: JsonValue | null;
  readonly output: JsonValue | null;
  readonly dispatched_at: string;
}

/**
 * Wraps the sink that actually acts. The claim is written *before* the action
 * is performed, not after: a crash between the two loses an effect, and a
 * crash the other way round performs one twice. For a system whose whole
 * premise is that a human authorised exactly one action, losing one is a
 * recoverable operational problem and repeating one is not.
 */
function createDurableEffectSink(
  pool: pg.Pool,
  clock: ClockPort,
  inner: EffectSink,
): EffectSink {
  return {
    async perform(runId, nodeId, effect, input) {
      const claim = await pool.query<{ readonly seq: string }>(
        `insert into forge_effect (run_id, node_id, effect, input, dispatched_at)
         values ($1, $2, $3, $4, $5)
         on conflict on constraint forge_effect_once do nothing
         returning seq`,
        [
          runId,
          nodeId,
          effect,
          input === undefined ? null : JSON.stringify(input),
          clock.now().toISOString(),
        ],
      );

      if (claim.rows.length === 0) {
        // Already dispatched — in this process, in a previous one, or by
        // another worker a moment ago. Hand back what it produced so the run
        // continues on the same data instead of on nothing.
        const prior = await pool.query<EffectRow>(
          `select output from forge_effect where run_id = $1 and node_id = $2`,
          [runId, nodeId],
        );
        return prior.rows[0]?.output ?? undefined;
      }

      const produced = await inner.perform(runId, nodeId, effect, input);
      if (produced !== undefined) {
        await pool.query(
          `update forge_effect set output = $3 where run_id = $1 and node_id = $2`,
          [runId, nodeId, JSON.stringify(produced)],
        );
      }
      return produced;
    },
  };
}

async function listDispatched(
  pool: pg.Pool,
  runId: string,
): Promise<readonly DispatchedEffect[]> {
  const { rows } = await pool.query<EffectRow>(
    `select node_id, effect, input, output, dispatched_at
       from forge_effect where run_id = $1 order by seq`,
    [runId],
  );
  return rows.map((row) => ({
    nodeId: row.node_id,
    effect: row.effect,
    input: row.input ?? undefined,
    output: row.output ?? undefined,
    dispatchedAt: row.dispatched_at,
  }));
}

/* -------------------------------------------------------------------------- */
/* Resume                                                                     */
/* -------------------------------------------------------------------------- */

export interface ResumeInput {
  readonly runId: string;
  /**
   * The artifact the run was started from. Sealed and fingerprinted, so a
   * different one produces a different binding hash and is refused below
   * rather than quietly resumed against.
   */
  readonly artifact: SealedArtifact;
  readonly capabilities?: readonly string[];
  readonly changedPaths?: readonly string[];
}

export type ResumeOutcome =
  /** The run was driven to a terminal state. */
  | { readonly kind: "resumed"; readonly run: RunRecord }
  /** Nothing to do yet; the gate has not been decided. */
  | { readonly kind: "waiting"; readonly reason: string }
  /** Something did not line up, and no effect was dispatched. */
  | { readonly kind: "refused"; readonly reason: string };

type Authorisation =
  | {
      readonly kind: "authorised";
      readonly principal: string;
      readonly approvalId: string;
    }
  | { readonly kind: "blocked"; readonly outcome: ResumeOutcome };

/**
 * What the durable approval records say about the action this run parked on.
 *
 * The binding is the whole argument: `resumeToken` on the checkpoint is the
 * `effectHash` the runtime computed from run + node + effect + fingerprint, so
 * matching on it is matching on the exact action, not on a name that resembles
 * it.
 */
function authorisationFor(
  records: readonly ApprovalRecord[],
  binding: string,
): Authorisation {
  const blocked = (outcome: ResumeOutcome): Authorisation => ({
    kind: "blocked",
    outcome,
  });
  const forBinding = records.filter((record) => record.effectHash === binding);

  if (forBinding.some((record) => record.status === "PENDING")) {
    return blocked({
      kind: "waiting",
      reason: "the gate for this action has not been decided",
    });
  }

  const approved = forBinding.find((record) => record.status === "APPROVED");
  if (approved === undefined) {
    const last = forBinding.at(-1);
    return blocked({
      kind: "refused",
      reason:
        last === undefined
          ? "no approval was ever opened for the action this run parked on"
          : `the gate was ${last.status}, which authorises nothing`,
    });
  }
  if (approved.decidedBy === undefined) {
    // The schema forbids this; refusing rather than trusting it costs nothing.
    return blocked({
      kind: "refused",
      reason: `approval ${approved.approvalId} is approved but names no decider`,
    });
  }
  if (
    approved.decidedAt !== undefined &&
    approved.decidedAt > approved.expiresAt
  ) {
    // An expired gate is not a slow yes. The runtime enforces this on the path
    // it owns; a decision written straight to the store by a control plane in
    // another process has to meet it here, or the deadline means nothing.
    return blocked({
      kind: "refused",
      reason: `approval ${approved.approvalId} was decided after it expired`,
    });
  }

  return {
    kind: "authorised",
    principal: approved.decidedBy,
    approvalId: approved.approvalId,
  };
}

/**
 * The payload the run was started with, read back off the checkpoint. Every
 * input node held the same payload, so the first one that pinned a value is
 * the payload. Absent is left absent: a workflow with no input value must not
 * be handed an invented one.
 */
function pinnedPayload(
  artifact: SealedArtifact,
  parked: CheckpointRecord,
): JsonValue | undefined {
  const values = parked.values;
  if (values === undefined) return undefined;
  for (const node of artifact.ir.nodes) {
    if (node.kind === "input" && node.id in values) return values[node.id];
  }
  return undefined;
}

/**
 * Whether the re-walk arrived at the same place, holding the same data.
 *
 * `stateVersion` is deliberately excluded — it carries the attempt, which is
 * meant to differ. Both records come out of the same `jsonb` column, so their
 * key order is canonicalised identically and a string compare is a value
 * compare.
 */
function samePosition(
  before: CheckpointRecord,
  after: CheckpointRecord,
): boolean {
  return (
    before.stepId === after.stepId &&
    before.resumeToken === after.resumeToken &&
    JSON.stringify(before.values ?? null) ===
      JSON.stringify(after.values ?? null)
  );
}

/* -------------------------------------------------------------------------- */
/* Stack                                                                      */
/* -------------------------------------------------------------------------- */

export interface DurableStackOptions {
  /** Defaults to `FORGE_DATABASE_URL`. */
  readonly databaseUrl?: string;
  /** Defaults to `FORGE_REDIS_URL`. */
  readonly redisUrl?: string;
  /** Defaults to `FORGE_QUEUE_NAME`, then to `forge`. */
  readonly queueName?: string;
  readonly rules?: readonly PolicyRule[];
  readonly grants?: readonly string[];
  readonly actor?: string;
  readonly environment?: string;
  readonly approvalTtlMs?: number;
  /** Where dispatched effects land, once the ledger has let them through. */
  readonly effects?: EffectSink;
  readonly transforms?: Readonly<Record<string, TransformFn>>;
  readonly observability?: ObservabilityPort;
  readonly clock?: ClockPort;
}

export interface DurableStack {
  /** Starts new runs in this process. */
  readonly runtime: Runtime;
  readonly approvals: ApprovalPort;
  readonly checkpoints: CheckpointStorePort;
  readonly queue: QueuePort;
  readonly observability: ObservabilityPort;
  /** What the durable ledger says was dispatched for a run, in order. */
  dispatched(runId: string): Promise<readonly DispatchedEffect[]>;
  /** Drives a run whose gate was decided while this process was not running. */
  resume(input: ResumeInput): Promise<ResumeOutcome>;
  close(): Promise<void>;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function fromEnvironment(name: string, supplied: string | undefined): string {
  const value = supplied ?? process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is not set. The durable stack reads its connection details from ` +
        "the environment; there is no built-in default, because a default would " +
        "mean a credential lived in the repository.",
    );
  }
  return value;
}

/**
 * Ids must be unique across processes, not merely within one: two workers each
 * counting from `approval_1` collide on the store's unique constraint, and two
 * runs sharing an id are one run as far as every index is concerned.
 */
const distinctIds: IdPort = { next: (prefix) => `${prefix}_${randomUUID()}` };

/** Makes the next run this runtime starts adopt an id that already exists. */
function reusing(runId: string): IdPort {
  let taken = false;
  return {
    next(prefix) {
      if (prefix !== "run" || taken) return distinctIds.next(prefix);
      taken = true;
      return runId;
    },
  };
}

export async function createDurableStack(
  options: DurableStackOptions = {},
): Promise<DurableStack> {
  const connectionString = fromEnvironment(
    "FORGE_DATABASE_URL",
    options.databaseUrl,
  );
  const redisUrl = fromEnvironment("FORGE_REDIS_URL", options.redisUrl);

  const pool = new pg.Pool({ connectionString });
  // A pool with no error listener crashes the process when the server hangs up
  // on an idle client. Postgres restarting is an operational event, not a
  // reason to lose a worker.
  pool.on("error", () => {});

  await applyCheckpointSchema(pool);
  await applyApprovalSchema(pool);
  await applyEffectLedgerSchema(pool);

  const clock: ClockPort = options.clock ?? { now: () => new Date() };
  const observability = options.observability ?? createMemoryObservability();
  const approvals = createPostgresApprovalStore(pool, clock, distinctIds);
  const checkpoints = createPostgresCheckpointStore(pool);
  const queue = createBullMqQueue({
    url: redisUrl,
    name: options.queueName ?? process.env.FORGE_QUEUE_NAME ?? "forge",
  });

  const effects = createDurableEffectSink(
    pool,
    clock,
    options.effects ?? {
      async perform() {
        return undefined;
      },
    },
  );

  const build = (ids: IdPort): Runtime =>
    createRuntime({
      engine: createMemoryGraphEngine(),
      policy: createMemoryPolicy({
        rules: options.rules ?? [],
        grants: options.grants ?? [],
      }),
      approvals,
      provider: createMockProvider({
        providerId: "mock",
        events: [{ type: "completed" }],
      }),
      sandbox: createMemorySandbox({ profiles: ["docker"], available: true }),
      observability,
      panel: { standing: [], summonable: [], quorum: 0.5 },
      ...(options.transforms === undefined
        ? {}
        : { transforms: (ref: string) => options.transforms?.[ref] }),
      effects,
      checkpoints,
      clock,
      ids,
      actor: options.actor ?? "svc.forge.worker",
      environment: options.environment ?? "production",
      approvalTtlMs: options.approvalTtlMs ?? DEFAULT_TTL_MS,
    });

  async function resume(input: ResumeInput): Promise<ResumeOutcome> {
    const parked = (await checkpoints.listByRun(input.runId)).at(-1);
    if (parked === undefined) {
      return {
        kind: "waiting",
        reason: "the run has written no checkpoint, so it never reached a gate",
      };
    }

    const gate = authorisationFor(
      await approvals.listByRun(input.runId),
      parked.resumeToken,
    );
    if (gate.kind === "blocked") return gate.outcome;

    // Re-walk under the run's own id, from the payload the gate was decided
    // on. Already-dispatched effects are held back by the durable ledger, so
    // the walk reaches the gate node without acting on the way.
    const payload = pinnedPayload(input.artifact, parked);
    const runtime = build(reusing(input.runId));
    const rewalked = await runtime.start({
      artifact: input.artifact,
      ...(input.capabilities === undefined
        ? {}
        : { capabilities: input.capabilities }),
      ...(input.changedPaths === undefined
        ? {}
        : { changedPaths: input.changedPaths }),
      ...(payload === undefined ? {} : { payload }),
    });

    return finish(input, parked, gate, runtime, rewalked);
  }

  /** The refusal points. Every one of them stops short of dispatching. */
  async function finish(
    input: ResumeInput,
    parked: CheckpointRecord,
    gate: Extract<Authorisation, { kind: "authorised" }>,
    runtime: Runtime,
    rewalked: RunRecord,
  ): Promise<ResumeOutcome> {
    if (
      rewalked.status !== "AWAITING_APPROVAL" ||
      rewalked.pendingApprovalId === undefined
    ) {
      return {
        kind: "refused",
        reason: `the resumed walk did not stop at a gate; it reported ${rewalked.status}`,
      };
    }

    const reparked = (await checkpoints.listByRun(input.runId)).at(-1);
    if (reparked === undefined || !samePosition(parked, reparked)) {
      // The values moved. Resuming here would perform an action computed from
      // data the approver never saw, which is the failure this whole file
      // exists to prevent.
      await runtime.cancel(input.runId);
      return {
        kind: "refused",
        reason:
          "the resumed walk did not reproduce the state the gate was decided on",
      };
    }

    const reissued = await approvals.get(rewalked.pendingApprovalId);
    if (reissued?.effectHash !== parked.resumeToken) {
      await runtime.cancel(input.runId);
      return {
        kind: "refused",
        reason: "the reissued gate is not bound to the action that was decided",
      };
    }

    // The decision carries forward because the binding is identical: same run,
    // same node, same effect, same artifact fingerprint. It authorises the one
    // action it always authorised. The principal is the one on the durable
    // record, never one this process chose.
    observability.event("forge.run.resumed", {
      runId: input.runId,
      nodeId: parked.stepId,
      decidedApprovalId: gate.approvalId,
      reissuedApprovalId: reissued.approvalId,
      effectHash: parked.resumeToken,
    });

    return {
      kind: "resumed",
      run: await runtime.decide(
        rewalked.pendingApprovalId,
        { kind: "approve" },
        gate.principal,
      ),
    };
  }

  return {
    runtime: build(distinctIds),
    approvals,
    checkpoints,
    queue,
    observability,
    dispatched: (runId) => listDispatched(pool, runId),
    resume,
    async close() {
      await queue.close();
      await pool.end();
    },
  };
}
