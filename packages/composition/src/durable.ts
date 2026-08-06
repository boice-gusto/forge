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
import {
  applyRunEventSchema,
  createPostgresRunEventStore,
} from "@forge/event-store-postgres";
import { type RunEventStorePort, recordRunEvents } from "@forge/observability";
import { createMemoryObservability } from "@forge/observability-memory";
import { createOtelObservability } from "@forge/observability-otel";
import type { PanelDefinition, Vote } from "@forge/panel";
import { createMemoryPolicy, type PolicyRule } from "@forge/policy-memory";
import type {
  ApprovalPort,
  CheckpointStorePort,
  ClockPort,
  IdPort,
  JsonValue,
  ObservabilityPort,
  ProviderPort,
  QueuePort,
  RunStorePort,
} from "@forge/ports";
import { createMockProvider } from "@forge/provider-mock";
import { createBullMqQueue } from "@forge/queue-bullmq";
import {
  applyRunStoreSchema,
  createPostgresRunStore,
} from "@forge/run-store-postgres";
import {
  createRuntime,
  type EffectSink,
  type RunRecord,
  type Runtime,
  type TransformFn,
} from "@forge/runtime";
import { createMemorySandbox } from "@forge/sandbox";
import pg from "pg";

import type { ControlPlaneStack } from "./control-plane.js";

/**
 * Durable composition root.
 *
 * The sibling of `createLocalStack`, with three Postgres stores and a real
 * Redis-backed queue in place of the Maps. 004 restricts adapter binding to
 * composition roots, so this file is the one place a connection string is
 * read — and it is read from the environment. **No host, password or
 * connection string is written down here or anywhere else in this repository.**
 *
 * What is durable is now the whole run. Checkpoints and approvals are rows, as
 * they were; so is the run record, together with its pinned values, the arm
 * each judge and branch took, and the effect ledger. That last group is what
 * used to be three `Map`s inside `createRuntime`, and their absence is what
 * forced the previous version of this file to rebuild a run by *re-walking* it
 * — which meant an `agent` or `judge` before the gate had to be refused,
 * because re-walking would ask a model the same question twice and get a
 * different answer.
 *
 * `resume` no longer rebuilds anything. It hands a run id to the runtime,
 * which reads the record and the three ledgers and re-enters the run where it
 * stopped. Nothing that already produced a value is invoked again.
 */

/** What `resume` hands back, re-exported so a host needs one import. */
export type { RunRecord } from "@forge/runtime";

/* -------------------------------------------------------------------------- */
/* Effects                                                                    */
/* -------------------------------------------------------------------------- */

/** One row of the durable effect ledger, with what the action produced. */
export interface DispatchedEffect {
  readonly nodeId: string;
  readonly effect: string;
  /** What the action was performed on — the value the approver saw. */
  readonly input: JsonValue | undefined;
  readonly output: JsonValue | undefined;
  readonly dispatchedAt: string;
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
  /** Injected so a test can count what a model was asked, per process. */
  readonly provider?: ProviderPort;
  readonly panel?: PanelDefinition;
  readonly votesFor?: (
    nodeId: string,
    judgeRef: string,
  ) => Readonly<Record<string, Vote>>;
  readonly branchFor?: (
    nodeId: string,
    conditionIds: readonly string[],
  ) => string | undefined;
  readonly observability?: ObservabilityPort;
  readonly clock?: ClockPort;
  /**
   * Profiles this deployment can provision. A workflow naming one that is
   * absent stops rather than running with less isolation than it declared, so
   * a host that serves a company must declare what that company's workflows
   * ask for — the same rule the local stack applies, stated in both roots
   * because a run must not become less isolated by being made durable.
   */
  readonly sandboxProfiles?: readonly string[];
}

export interface DurableStack extends ControlPlaneStack {
  readonly runtime: Runtime;
  readonly approvals: ApprovalPort;
  readonly checkpoints: CheckpointStorePort;
  readonly runs: RunStorePort;
  readonly queue: QueuePort;
  readonly observability: ObservabilityPort;
  readonly runEvents: RunEventStorePort;
  /** What the durable ledger says was dispatched for a run, in order. */
  dispatched(runId: string): Promise<readonly DispatchedEffect[]>;
  /**
   * Re-enters a run this process may never have started, and drives it as far
   * as it can go. `undefined` means no such run exists.
   */
  resume(runId: string): Promise<RunRecord | undefined>;
  /**
   * Resolves once queued run events have been written. Writes are deliberately
   * off the caller's stack so telemetry cannot hold up a run, which means a
   * reader that has just caused one has to wait for it.
   */
  settled(): Promise<void>;
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
  await applyRunStoreSchema(pool);
  await applyRunEventSchema(pool);

  const clock: ClockPort = options.clock ?? { now: () => new Date() };
  // A worker's spans have no inspector reading them out of a Map; they are
  // only useful exported. Falls back to the recorder when no collector is
  // configured, so a run without one still works rather than failing on
  // telemetry — the one port that fails open.
  const collector =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const exporter =
    options.observability === undefined && collector !== undefined
      ? createOtelObservability()
      : undefined;
  const observability =
    options.observability ?? exporter ?? createMemoryObservability();
  // The gap this closes: the sink above exports and forgets, so a run parked in
  // one process had no timeline in the next. The store is a row per event, read
  // back by run id by whichever control plane the operator happens to reach.
  const runEvents = createPostgresRunEventStore(pool);
  const runEventRecorder = recordRunEvents(observability, runEvents, clock);
  const approvals = createPostgresApprovalStore(pool, clock, distinctIds);
  const checkpoints = createPostgresCheckpointStore(pool);
  const runs = createPostgresRunStore(pool);
  const queue = createBullMqQueue({
    url: redisUrl,
    name: options.queueName ?? process.env.FORGE_QUEUE_NAME ?? "forge",
  });

  const runtime = createRuntime({
    engine: createMemoryGraphEngine(),
    policy: createMemoryPolicy({
      rules: options.rules ?? [],
      grants: options.grants ?? [],
    }),
    approvals,
    provider:
      options.provider ??
      createMockProvider({
        providerId: "mock",
        events: [{ type: "completed" }],
      }),
    sandbox: createMemorySandbox({
      profiles: options.sandboxProfiles ?? ["docker"],
      available: true,
    }),
    observability: runEventRecorder,
    panel: options.panel ?? { standing: [], summonable: [], quorum: 0.5 },
    ...(options.votesFor === undefined ? {} : { votesFor: options.votesFor }),
    ...(options.branchFor === undefined
      ? {}
      : { branchFor: options.branchFor }),
    ...(options.transforms === undefined
      ? {}
      : { transforms: (ref: string) => options.transforms?.[ref] }),
    effects: options.effects ?? {
      async perform() {
        return undefined;
      },
    },
    checkpoints,
    runs,
    clock,
    ids: distinctIds,
    actor: options.actor ?? "svc.forge.worker",
    environment: options.environment ?? "production",
    approvalTtlMs: options.approvalTtlMs ?? DEFAULT_TTL_MS,
  });

  async function dispatched(
    runId: string,
  ): Promise<readonly DispatchedEffect[]> {
    const persisted = await runs.load(runId);
    if (persisted === undefined) return [];
    // A tool node's output is pinned as its value, so the ledger and the value
    // ledger describe the same dispatch from two sides.
    const produced = new Map(
      persisted.values.map((pinned) => [pinned.nodeId, pinned.value]),
    );
    return persisted.effects.map((effect) => ({
      nodeId: effect.nodeId,
      effect: effect.effect,
      input: effect.input,
      output: produced.get(effect.nodeId),
      dispatchedAt: effect.dispatchedAt,
    }));
  }

  return {
    runtime,
    approvals,
    checkpoints,
    runs,
    queue,
    observability,
    runEvents,
    dispatched,
    resume: (runId) => runtime.resume(runId),
    settled: () => runEventRecorder.settled(),
    async close() {
      // Flush before the sockets go. A process that exits without flushing
      // loses the spans that mattered most, which are usually the last ones.
      await exporter?.shutdown();
      // The same reason, for the other sink. The records that matter most are
      // the last ones, and `pool.end()` below would abandon any still in
      // flight — a run whose final dispatch is missing from its own timeline.
      await runEventRecorder.settled();
      await queue.close();
      await pool.end();
    },
  };
}

/**
 * Re-exported because a composition root binding `effects` has to name the
 * shape it is binding, and reaching past `@forge/composition` into
 * `@forge/runtime` for a type would put a process entry point on the wrong
 * side of the layering the architecture check enforces.
 */
export type { EffectSink };
