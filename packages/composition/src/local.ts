import { createMemoryApprovalStore } from "@forge/approval-memory";
import { createMemoryCheckpointStore } from "@forge/checkpoint-memory";
import { compileWorkflow } from "@forge/compiler";
import { createMemoryGraphEngine } from "@forge/engine-memory";
import { createMemoryRunEventStore } from "@forge/event-store-memory";
import { type RunEventStorePort, recordRunEvents } from "@forge/observability";
import {
  createMemoryObservability,
  type MemoryObservability,
} from "@forge/observability-memory";
import type { PanelDefinition, Vote } from "@forge/panel";
import { createMemoryPolicy, type PolicyRule } from "@forge/policy-memory";
import type {
  ApprovalPort,
  ClockPort,
  IdPort,
  ProviderPort,
  QueuePort,
  RunStorePort,
} from "@forge/ports";
import { createMockProvider } from "@forge/provider-mock";
import { createMemoryQueue } from "@forge/queue-memory";
import { createMemoryRunStore } from "@forge/run-store-memory";
import {
  createRuntime,
  type EffectSink,
  type Runtime,
  type SealedArtifact,
  type TransformFn,
} from "@forge/runtime";
import { createMemorySandbox } from "@forge/sandbox";
import type { Diagnostic } from "@forge/types";

import type { ControlPlaneStack } from "./control-plane.js";

/**
 * Local composition root.
 *
 * 004 restricts adapter binding to composition roots. This is the in-memory
 * one, shared by the CLI, the API in local mode, and integration tests, so a
 * single wiring is exercised everywhere rather than three that drift. Nothing
 * here reaches a network or a container — swapping in real adapters is a
 * change to this file and nothing else.
 */

export interface LocalStackOptions {
  readonly rules?: readonly PolicyRule[];
  readonly grants?: readonly string[];
  readonly actor?: string;
  readonly environment?: string;
  readonly approvalTtlMs?: number;
  readonly startedAt?: string;
  /** Where dispatched effects land. Defaults to an in-memory recorder. */
  readonly effects?: EffectSink;
  /** Which roles review every change, and which are summoned. */
  readonly panel?: PanelDefinition;
  /** Which arm a branch takes, keyed by node id. */
  readonly branchFor?: (
    nodeId: string,
    conditionIds: readonly string[],
  ) => string | undefined;
  /** Votes a judge returns, keyed by role name. */
  readonly votesFor?: (
    nodeId: string,
    judgeRef: string,
  ) => Readonly<Record<string, Vote>>;
  /**
   * Transform implementations, keyed by `transformRef`. A workflow read from
   * JSON cannot carry code, so a transform node that reads a value fails closed
   * unless a host supplies one here.
   */
  readonly transforms?: Readonly<Record<string, TransformFn>>;
  /**
   * The agent backend. Defaults to the deterministic mock; injected so a test
   * can count what a model was actually asked, which is the only way to show
   * that a re-entered run does not ask it again.
   */
  readonly provider?: ProviderPort;
  /** Set false to prove a required sandbox failing closed. */
  readonly sandboxAvailable?: boolean;
  /**
   * Profiles this deployment can provision. A workflow naming one that is
   * absent stops rather than running with less isolation than it declared, so
   * a host that serves a company must declare what that company's workflows
   * ask for.
   */
  readonly sandboxProfiles?: readonly string[];
  /**
   * Shared so that a host building one stack per run does not mint `run_1`
   * twice. Two runs with the same id are one run as far as any index is
   * concerned, and the second silently displaces the first.
   */
  readonly ids?: IdPort;
  /**
   * The two durable stores, shared.
   *
   * Everything a second process needs to re-enter a run it never started is in
   * these, so two stacks built over one pair *are* two processes as far as the
   * runtime is concerned — one stack's runtime, ledgers and in-memory effect
   * list are invisible to the other. That is the only way to show the durable
   * effect claim doing its job without a container.
   */
  readonly runs?: RunStorePort;
  readonly approvals?: ApprovalPort;
}

export interface LocalStack extends ControlPlaneStack {
  readonly runtime: Runtime;
  readonly approvals: ApprovalPort;
  readonly runs: RunStorePort;
  readonly clock: ClockPort;
  readonly ids: IdPort;
  /** Effects dispatched, in order, when the default recorder is used. */
  readonly dispatched: readonly string[];
  readonly observability: MemoryObservability;
  readonly runEvents: RunEventStorePort;
  readonly queue: QueuePort;
  /**
   * Settles once no job this stack accepted is still being walked.
   *
   * Delivery here is deliberately off the enqueuing caller's stack, so a test
   * that asserted straight after `POST /v1/runs` would be asserting on a run
   * that had not started. Polling would work — that is what a client does —
   * but in-process a test can simply be told when the work is over, and a
   * deterministic wait cannot pass because it happened to be slow enough.
   */
  drain(): Promise<void>;
  advanceClock(ms: number): void;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createLocalStack(options: LocalStackOptions = {}): LocalStack {
  let instant = new Date(options.startedAt ?? "2026-01-01T00:00:00.000Z");
  const clock: ClockPort = { now: () => new Date(instant) };

  const counters = new Map<string, number>();
  const ids: IdPort = options.ids ?? {
    next(prefix) {
      const value = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, value);
      return `${prefix}_${value}`;
    },
  };

  const dispatched: string[] = [];
  const effects: EffectSink = options.effects ?? {
    async perform(_runId, _nodeId, effect) {
      dispatched.push(effect);
      return undefined;
    },
  };

  const approvals = options.approvals ?? createMemoryApprovalStore(clock, ids);
  const observability = createMemoryObservability();
  // The run's timeline as a queryable history, beside the trace. Bound in both
  // roots so the control plane reads run events one way regardless of which
  // stack it got; here the history dies with the process, exactly as this
  // stack's runs and checkpoints do.
  const runEvents = createMemoryRunEventStore();
  // Writes are queued off the caller's stack, because telemetry must never
  // hold up a run. A test that emits and reads back therefore has to wait for
  // the queue, and nothing else can do that for it.
  const recorder = recordRunEvents(observability, runEvents, clock);
  const sandboxAvailable = options.sandboxAvailable ?? true;
  // The local stack's run store is a Map, exactly as its checkpoints are. The
  // runtime cannot tell it from the Postgres one, which is what makes `resume`
  // work identically in both. Named here rather than inlined because the
  // control plane reads it directly to list runs.
  const runs = options.runs ?? createMemoryRunStore();

  /**
   * The queue, and the one thing this root has to add to it.
   *
   * `createMemoryQueue` hands a job to its subscriber *inside* `enqueue`;
   * Redis hands it to another process a moment later. Both satisfy `QueuePort`
   * — the conformance suite polls for delivery precisely because the timing is
   * not part of the contract — but the difference is the whole point of this
   * change: if delivery happened inside `enqueue`, `POST /v1/runs` would still
   * be holding its request open across the walk, only less obviously than
   * before.
   *
   * So the handler is pushed onto a later turn of the loop, which is what a
   * separate worker process is. Nothing else about the local stack pretends to
   * be distributed; this one thing has to be, or the route it serves is not
   * the route a durable deployment serves.
   */
  const inFlight = new Set<Promise<void>>();
  const later = (work: () => Promise<void>): void => {
    const scheduled = new Promise<void>((settle) => setTimeout(settle, 0))
      .then(work)
      // The consumer already records a job it could not service. A rejection
      // escaping here would be an unhandled one, and would take down a
      // development server for a run that merely failed.
      .catch(() => {});
    inFlight.add(scheduled);
    void scheduled.finally(() => inFlight.delete(scheduled));
  };
  const delivered = createMemoryQueue();
  const queue: QueuePort = {
    ...delivered,
    subscribe: (handler) =>
      delivered.subscribe(async (job) => {
        later(() => handler(job));
      }),
  };

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
      available: sandboxAvailable,
    }),
    observability: recorder,
    panel: options.panel ?? { standing: [], summonable: [], quorum: 0.5 },
    ...(options.votesFor === undefined ? {} : { votesFor: options.votesFor }),
    ...(options.branchFor === undefined
      ? {}
      : { branchFor: options.branchFor }),
    ...(options.transforms === undefined
      ? {}
      : { transforms: (ref: string) => options.transforms?.[ref] }),
    effects,
    checkpoints: createMemoryCheckpointStore(),
    runs,
    clock,
    ids,
    actor: options.actor ?? "svc.forge.local",
    environment: options.environment ?? "local",
    approvalTtlMs: options.approvalTtlMs ?? DEFAULT_TTL_MS,
  });

  return {
    runtime,
    approvals,
    runs,
    clock,
    ids,
    dispatched,
    observability,
    runEvents,
    queue,
    async drain() {
      // A walk can outlive the turn it was scheduled on, so this waits for the
      // set to empty rather than for one snapshot of it.
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
    advanceClock(ms) {
      instant = new Date(instant.getTime() + ms);
    },
  };
}

export type CompileOutcome =
  | { readonly ok: true; readonly artifact: SealedArtifact }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** Compile a workflow source into the artifact shape the runtime executes. */
export function compileToArtifact(source: unknown): CompileOutcome {
  const compiled = compileWorkflow(source);
  if (!compiled.ok) return { ok: false, diagnostics: compiled.diagnostics };
  return {
    ok: true,
    artifact: {
      workflowId: compiled.value.ir.workflowId,
      fingerprint: compiled.value.fingerprint,
      ir: compiled.value.ir,
    },
  };
}
