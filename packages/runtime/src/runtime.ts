import { createHash } from "node:crypto";

import type { ForgeIr, Role } from "@forge/ir";
import {
  composePanel,
  type PanelDefinition,
  resolveVerdict,
  type Vote,
} from "@forge/panel";
import type {
  ApprovalDecision,
  ApprovalPort,
  ApprovalRecord,
  CheckpointStorePort,
  ClockPort,
  EnginePlan,
  GraphEnginePort,
  IdPort,
  JsonValue,
  JudgeVerdict,
  ObservabilityPort,
  PolicyPort,
  ProviderPort,
  RunRecord,
  RunStorePort,
  RunValues,
  SandboxLease,
  SandboxPort,
  Span,
} from "@forge/ports";

/**
 * The run lifecycle (006 §5) and the record that carries it live on
 * `RunStorePort`, because `AWAITING_APPROVAL` is durable state rather than
 * something one process happens to remember. Re-exported here so callers keep
 * reading them in runtime terms.
 */
export type { RunRecord, RunStatus } from "@forge/ports";

export interface EffectSink {
  /**
   * `input` is the value the tool node read, if it declared one. Anything
   * returned becomes that node's value, so a later node can read the result of
   * the action rather than only the fact that it happened.
   */
  perform(
    runId: string,
    nodeId: string,
    effect: string,
    input: JsonValue | undefined,
  ): Promise<JsonValue | undefined>;
}

/** A transform's implementation, resolved from its `transformRef`. */
export type TransformFn = (
  input: JsonValue,
) => JsonValue | undefined | Promise<JsonValue | undefined>;

export interface SealedArtifact {
  readonly workflowId: string;
  readonly fingerprint: string;
  readonly ir: ForgeIr;
}

export interface RuntimeOptions {
  readonly engine: GraphEnginePort;
  readonly policy: PolicyPort;
  readonly approvals: ApprovalPort;
  readonly provider: ProviderPort;
  readonly sandbox: SandboxPort;
  readonly observability: ObservabilityPort;
  /** Which roles sit on every panel and which are summoned. */
  readonly panel: PanelDefinition;
  /** Votes a judge returns, keyed by role. Supplied by the review adapter. */
  readonly votesFor?: (
    nodeId: string,
    judgeRef: string,
  ) => Readonly<Record<string, Vote>>;
  /**
   * Which arm a branch takes. A local stand-in until run data flows between
   * nodes; without it a branch stops the run rather than guessing.
   */
  readonly branchFor?: (
    nodeId: string,
    conditionIds: readonly string[],
  ) => string | undefined;
  /**
   * Resolves a `transformRef` to the function that computes it. A transform
   * node whose ref resolves to nothing stops the run: computing nothing and
   * carrying on would put an unwritten value in front of the next node.
   */
  readonly transforms?: (transformRef: string) => TransformFn | undefined;
  readonly effects: EffectSink;
  readonly checkpoints: CheckpointStorePort;
  /**
   * Where the run and its three ledgers live. Bind the memory adapter and the
   * runtime behaves exactly as it always did; bind the Postgres one and a
   * second process can re-enter a run this one started.
   */
  readonly runs: RunStorePort;
  readonly clock: ClockPort;
  readonly ids: IdPort;
  readonly actor: string;
  readonly environment: string;
  /** How long an approval stays actionable before it expires. */
  readonly approvalTtlMs: number;
}

export interface StartInput {
  readonly artifact: SealedArtifact;
  /** Capabilities the workflow's roles require, closed at compile time. */
  readonly capabilities?: readonly string[];
  /** What this run changed, used to compose the review panel. */
  readonly changedPaths?: readonly string[];
  /**
   * The run's payload, which becomes the value of every `input` node. Omitting
   * it does not produce an empty value: a node reading an input that was never
   * supplied stops the run.
   */
  readonly payload?: JsonValue;
}

export function effectHash(input: {
  readonly runId: string;
  readonly nodeId: string;
  readonly effect: string;
  readonly fingerprint: string;
}): string {
  return createHash("sha256")
    .update(
      `${input.runId} ${input.nodeId} ${input.effect} ${input.fingerprint}`,
    )
    .digest("hex");
}

const NOOP_SPAN: Span = { end: () => undefined };

/**
 * Telemetry is a report, never a dependency: alone among the ports it fails
 * open, because a throwing sink must not fail a run that would otherwise have
 * succeeded, nor abort one midway and leave a gate open.
 */
function failSafe(port: ObservabilityPort): ObservabilityPort {
  return {
    startSpan(name, attributes) {
      try {
        const span = port.startSpan(name, attributes);
        return {
          end(endAttributes) {
            try {
              span.end(endAttributes);
            } catch {}
          },
        };
      } catch {
        return NOOP_SPAN;
      }
    },
    event(name, attributes) {
      try {
        port.event(name, attributes);
      } catch {}
    },
  };
}

/**
 * A principal is PII. "Who decided this" belongs on the durable
 * `ApprovalRecord`; a span only needs to tell two deciders apart.
 */
function principalTag(principal: string): string {
  return createHash("sha256").update(principal).digest("hex").slice(0, 16);
}

/**
 * A produced value is stored as JSON and nothing else. The round trip does two
 * jobs: it refuses anything a checkpoint could not hold, and it detaches the
 * value from whatever produced it, so a sink that keeps a reference and mutates
 * it later cannot change what a human already approved.
 */
function pin(nodeId: string, value: JsonValue): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    throw new Error(
      `Node '${nodeId}' produced a value that is not JSON; a checkpoint could not hold it.`,
    );
  }
}

/** A node's outcome for one run. `undefined` means "ran, produced nothing". */
type ValueLedger = Map<string, JsonValue | undefined>;

/**
 * Fail closed. Every absence here is an absence of data, and the only safe
 * answer to "what is the value?" when there is none is to stop.
 */
function readPath(
  values: ValueLedger,
  nodeId: string,
  path: readonly string[],
): JsonValue {
  if (!values.has(nodeId)) {
    throw new Error(`Node '${nodeId}' has produced no value to read.`);
  }
  let current: JsonValue | undefined = values.get(nodeId);
  const walked: string[] = [];
  for (const segment of path) {
    const record =
      current !== null && typeof current === "object" && !Array.isArray(current)
        ? (current as { readonly [key: string]: JsonValue })
        : undefined;
    if (record === undefined || !(segment in record)) {
      throw new Error(
        `Node '${nodeId}' has no value at '${[...walked, segment].join(".")}'.`,
      );
    }
    current = record[segment];
    walked.push(segment);
  }
  if (current === undefined) {
    throw new Error(`Node '${nodeId}' produced no value to read.`);
  }
  return current;
}

/** Values as a checkpoint stores them: the ones that exist, keyed by node. */
function snapshot(values: ValueLedger): Record<string, JsonValue> {
  return Object.fromEntries(
    [...values].filter(
      (entry): entry is [string, JsonValue] => entry[1] !== undefined,
    ),
  );
}

/**
 * One agent turn, reduced to what the data plane keeps: the text it streamed,
 * or nothing if it streamed none. The session is destroyed either way — a
 * throw here is an agent that produced nothing, not one that produced silence.
 *
 * `workspacePath` is the sandbox's when the node is inside one (010 §10): the
 * session runs with the lease's workspace as its cwd, which is what makes the
 * isolation reach the work rather than merely surround it.
 */
async function runAgent(
  provider: ProviderPort,
  runId: string,
  promptRef: string,
  span: Span,
  workspacePath: string,
): Promise<string | undefined> {
  const session = await provider.createSession({
    workspacePath,
    correlationId: runId,
    capabilities: [],
  });
  const chunks: string[] = [];
  try {
    for await (const event of provider.execute(session, {
      prompt: promptRef,
    })) {
      if (event.type === "error") {
        throw new Error(`${event.code}: ${event.message}`);
      }
      if (event.type === "text-delta") chunks.push(event.text);
    }
    return chunks.length === 0 ? undefined : chunks.join("");
  } finally {
    await provider.destroySession(session);
    span.end();
  }
}

const VOTES: ReadonlySet<string> = new Set(["pass", "fail", "error"]);

/**
 * Run data supplies ballots, never a verdict. The panel still resolves the
 * outcome, so a value an agent wrote cannot talk an empty panel into passing.
 */
function votesFromState(
  nodeId: string,
  value: JsonValue | undefined,
): Readonly<Record<string, Vote>> {
  if (value === undefined) return {};
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.values(value).every(
      (vote) => typeof vote === "string" && VOTES.has(vote),
    )
  ) {
    throw new Error(
      `Judge '${nodeId}' read a value that is not a set of votes keyed by role.`,
    );
  }
  return value as Readonly<Record<string, Vote>>;
}

export interface Runtime {
  start(input: StartInput): Promise<RunRecord>;
  /**
   * Re-enters a run this process may never have started.
   *
   * Loads the record, the pinned values, the route ledger and the effect
   * ledger from the run store, then continues from where the run stopped. It
   * does **not** re-walk in the sense that matters: every node that already
   * produced a value, took an arm, or dispatched an effect is replayed from
   * its ledger, so no provider, judge, branch or sink is asked a second time.
   *
   * A run parked at a gate stays parked unless the gate has been decided —
   * possibly by a control plane in another process, which can only write to
   * the approval store. The binding and the deadline are re-checked here,
   * because here is where the dispatch is authorised.
   *
   * `undefined` means no such run exists anywhere.
   */
  resume(runId: string): Promise<RunRecord | undefined>;
  /**
   * The run record, from the store if this process does not know it. Reads
   * only: a run mid-walk is not advanced by being looked at.
   */
  loadRun(runId: string): Promise<RunRecord | undefined>;
  decide(
    approvalId: string,
    decision: ApprovalDecision,
    principal: string,
  ): Promise<RunRecord>;
  cancel(runId: string): Promise<RunRecord>;
  /** What this process knows, without going to the store. */
  getRun(runId: string): RunRecord | undefined;
  getApproval(approvalId: string): Promise<ApprovalRecord | undefined>;
  /** Effects actually dispatched, in order. Used to prove exactly-once. */
  ledger(runId: string): readonly string[];
}

interface RunState {
  record: RunRecord;
  capabilities: readonly string[];
  authorised: Set<string>;
  plan: EnginePlan;
  roles: Readonly<Record<string, Role>>;
  changedPaths: readonly string[];
  /** Highest maxAttempts declared on any node (006 §7). */
  retryBudget: number;
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const observability = failSafe(options.observability);
  const runs = new Map<string, RunState>();
  const ledgers = new Map<string, string[]>();
  /**
   * The arm each routing node took, per run — a verdict for a judge, a
   * condition for a branch. A resumed attempt re-walks the nodes before the
   * interrupt, and a judge is a model call, not a pure function: an answer that
   * changed on resume would reroute the run away from the effect a human had
   * already approved. Same reasoning as the effect ledger, applied to control
   * flow.
   */
  const routeLedgers = new Map<string, Map<string, string>>();
  /**
   * What each node produced, per run. Third ledger, same reason as the first
   * two: a resumed attempt re-walks the nodes before the interrupt, and an
   * agent is a model call, not a pure function. If its output changed on
   * resume, the tool downstream would act on data the approver never saw — the
   * action performed would not be the action approved.
   */
  const valueLedgers = new Map<string, ValueLedger>();

  /**
   * The single place a run's status changes, so the lifecycle transition
   * (006 §5) is reported from one choke point rather than at each of the nine
   * call sites that move a run — one of which would eventually be missed.
   *
   * It is also the single place the record is persisted, for the same reason:
   * a status a second process cannot read is a status only this one believes.
   */
  const update = async (
    state: RunState,
    patch: Partial<RunRecord>,
  ): Promise<RunRecord> => {
    const from = state.record.status;
    state.record = { ...state.record, ...patch };
    await options.runs.update(state.record);
    if (patch.status !== undefined && patch.status !== from) {
      observability.event("forge.run.transition", {
        runId: state.record.runId,
        workflowId: state.record.workflowId,
        from,
        to: patch.status,
        attempt: state.record.attempt,
      });
    }
    return state.record;
  };

  /** Highest maxAttempts declared on any node (006 §7). */
  const retryBudgetFor = (ir: ForgeIr): number =>
    ir.nodes.reduce(
      (highest, node) =>
        "retry" in node && node.retry !== undefined
          ? Math.max(highest, node.retry.maxAttempts)
          : highest,
      1,
    );

  /**
   * Brings a run this process may never have started into memory, ledgers and
   * all. Nothing is recomputed: the values, the arms and the dispatches are the
   * ones the run recorded, which is what makes re-entering it safe.
   */
  async function hydrate(runId: string): Promise<RunState | undefined> {
    const known = runs.get(runId);
    if (known !== undefined) return known;

    const persisted = await options.runs.load(runId);
    if (persisted === undefined) return undefined;

    // The one narrowing in the file. `@forge/ports` sits beside `@forge/ir`
    // rather than above it, so the store holds the sealed IR as JSON; the
    // fingerprint travelling with it is what the approval's binding is
    // recomputed against, and a substituted artifact fails that check.
    const ir = persisted.artifact.ir as unknown as ForgeIr;

    const state: RunState = {
      record: persisted.record,
      capabilities: persisted.capabilities,
      /**
       * Derived from the effect ledger rather than stored. A node that already
       * dispatched is walked past instead of being gated a second time — and
       * only such a node is, so re-entering a run cannot authorise anything a
       * policy or a human has not.
       */
      authorised: new Set(persisted.effects.map((effect) => effect.nodeId)),
      plan: await options.engine.materialize(ir),
      roles: ir.roles,
      changedPaths: persisted.changedPaths,
      retryBudget: retryBudgetFor(ir),
    };

    runs.set(runId, state);
    ledgers.set(runId, [...persisted.effects.map((effect) => effect.nodeId)]);
    routeLedgers.set(
      runId,
      new Map(persisted.routes.map((route) => [route.nodeId, route.arm])),
    );
    // A node that ran and produced nothing is a key with no value, so `has`
    // still answers "this node has run" and it is never invoked again.
    valueLedgers.set(
      runId,
      new Map(persisted.values.map((pinned) => [pinned.nodeId, pinned.value])),
    );
    return state;
  }

  /**
   * Whether this approval still describes the action it was opened on. The
   * binding covers run, node, effect and artifact fingerprint, so a mismatch
   * means the decision authorises something else — including when the artifact
   * came back out of a store rather than from the caller.
   */
  const bindsTo = (state: RunState, approval: ApprovalRecord): boolean =>
    effectHash({
      runId: approval.runId,
      nodeId: approval.nodeId,
      effect: approval.effect,
      fingerprint: state.record.fingerprint,
    }) === approval.effectHash;

  /** When an approval this runtime issues stops being actionable. */
  const expiry = (): string =>
    new Date(
      options.clock.now().getTime() + options.approvalTtlMs,
    ).toISOString();

  async function advance(state: RunState): Promise<RunRecord> {
    const runId = state.record.runId;
    const ledger = ledgers.get(runId) as string[];
    const routes = routeLedgers.get(runId) as Map<string, string>;
    const values = valueLedgers.get(runId) as ValueLedger;

    /**
     * A produced value goes into the run store as it goes into the Map. The
     * store refuses a second write for the same node, so the pin is a fact
     * about the run rather than about the process that computed it.
     */
    const pinValue = async (
      nodeId: string,
      value: JsonValue | undefined,
    ): Promise<void> => {
      values.set(nodeId, value);
      await options.runs.pinValue(runId, nodeId, value);
    };

    const pinRoute = async (nodeId: string, arm: string): Promise<void> => {
      routes.set(nodeId, arm);
      await options.runs.pinRoute(runId, nodeId, arm);
    };

    /**
     * The lease the walk is currently inside, if any. Scoped to this attempt on
     * purpose: the walk that resumes after an approval enters the sandbox
     * again, rather than reaching for one that was released at the gate.
     */
    let inSandbox: SandboxLease | undefined;

    // The engine reads; only the hooks below write. A walk cannot invent a
    // value, and a value cannot be produced twice under one run.
    const view: RunValues = {
      read: (nodeId, path) => readPath(values, nodeId, path),
    };

    const result = await options.engine.execute(
      state.plan,
      {
        runId: state.record.runId,

        invokeAgent: async (nodeId, promptRef, role) => {
          const span = observability.startSpan("forge.node.agent", {
            runId: state.record.runId,
            nodeId,
            promptRef,
            ...(role === undefined ? {} : { role }),
          });

          // Answered once per run, for the same reason a verdict is.
          if (values.has(nodeId)) {
            span.end({ replayed: true });
            return;
          }

          // Pinned only once the call completed: a failed agent has produced
          // nothing, and a retry must be free to ask again.
          await pinValue(
            nodeId,
            await runAgent(
              options.provider,
              runId,
              promptRef,
              span,
              inSandbox?.workspacePath ?? `/workspace/${runId}`,
            ),
          );
        },

        transform: async (nodeId, transformRef, input) => {
          if (values.has(nodeId)) return;
          const compute = options.transforms?.(transformRef);
          if (compute === undefined) {
            throw new Error(
              `No transform is registered for '${transformRef}'; node '${nodeId}' has nothing to compute with.`,
            );
          }
          const produced = await compute(input);
          await pinValue(
            nodeId,
            produced === undefined ? undefined : pin(nodeId, produced),
          );
        },

        emitOutput: async (nodeId, value) => {
          if (values.has(nodeId)) {
            // A rehydrated run reports the result it pinned, not the one in
            // front of it. Without this a run that emitted its output and then
            // lost its process would come back SUCCEEDED with no result.
            await update(state, { result: values.get(nodeId) });
            return;
          }
          const pinned = pin(nodeId, value);
          await pinValue(nodeId, pinned);
          await update(state, { result: pinned });
        },

        judge: async (nodeId, judgeRef, fromState): Promise<JudgeVerdict> => {
          const span = observability.startSpan("forge.node.judge", {
            runId: state.record.runId,
            nodeId,
            judgeRef,
          });

          // Decided once per run. Re-asking on a resumed walk would let the
          // route change under a decision a human has already made.
          const settled = routes.get(nodeId);
          if (settled !== undefined) {
            span.end({ verdict: settled, replayed: true });
            return settled as JudgeVerdict;
          }

          const panel = composePanel(state.roles, options.panel, {
            paths: state.changedPaths,
          });
          // Injected votes win: the review adapter is the authority, run data
          // only stands in for one when there is none.
          const votes =
            options.votesFor?.(nodeId, judgeRef) ??
            votesFromState(nodeId, fromState);
          const outcome = resolveVerdict(panel, votes);
          await pinRoute(nodeId, outcome.verdict);
          span.end({
            verdict: outcome.verdict,
            panelSize: panel.members.length,
            reason: outcome.reason,
          });
          return outcome.verdict;
        },

        chooseBranch: async (
          nodeId,
          conditionIds,
          fromState,
        ): Promise<string> => {
          const settled = routes.get(nodeId);
          if (settled !== undefined) return settled;

          if (fromState !== undefined && typeof fromState !== "string") {
            throw new Error(
              `Branch '${nodeId}' read a value that does not name an arm.`,
            );
          }
          // An injected arm overrides run data, so an explicit decision is
          // never overruled by a value a model wrote.
          const chosen = options.branchFor?.(nodeId, conditionIds) ?? fromState;
          if (chosen === undefined) {
            // Fail closed: running every arm would make a branch a fan-out, and
            // picking one would invent a decision the workflow did not make.
            throw new Error(
              `No arm was chosen for branch '${nodeId}'; declared arms are ${conditionIds.join(", ")}.`,
            );
          }
          await pinRoute(nodeId, chosen);
          observability.event("forge.node.branch", {
            runId: state.record.runId,
            nodeId,
            arm: chosen,
          });
          return chosen;
        },

        /**
         * The lease spans the scope the engine hands over, and the adapter's
         * own `finally` ends it. Nothing here can forget to release: the walk
         * stopping at a gate returns out of `work`, which closes the lease
         * before the run parks — a container must not sit idle across a
         * decision that may take days (006 §"Sandbox during long HITL waits").
         */
        withSandbox: async (nodeId, profile, work) => {
          let acquired = false;
          try {
            return await options.sandbox.withSandbox(
              { profile, correlationId: state.record.runId },
              async (lease) => {
                acquired = true;
                observability.event("forge.node.sandbox", {
                  runId: state.record.runId,
                  nodeId,
                  profile,
                  sandboxId: lease.sandboxId,
                  available: true,
                });
                const outer = inSandbox;
                inSandbox = lease;
                try {
                  return await work();
                } finally {
                  inSandbox = outer;
                }
              },
            );
          } catch (error) {
            if (acquired) throw error;
            // The refusal is the runtime's to word, not the adapter's: whatever
            // a backend says about its socket, what the run must report is that
            // the isolation it declared did not happen and it stopped there.
            observability.event("forge.node.sandbox", {
              runId: state.record.runId,
              nodeId,
              profile,
              available: false,
            });
            throw new Error(
              `Sandbox profile '${profile}' could not be provisioned for node '${nodeId}'; host execution is not permitted (${error instanceof Error ? error.message : String(error)}).`,
            );
          }
        },

        assertCapability: async (_nodeId, capability) => {
          const granted = await options.policy.grantedCapabilities();
          if (!granted.includes(capability)) {
            throw new Error(
              `Capability "${capability}" is outside the granted closure.`,
            );
          }
        },
        perform: async (nodeId, effect, input) => {
          // Replay safety: a re-entered run walks the nodes before the
          // interrupt again, so an already-dispatched effect must not fire
          // twice (006 §8).
          if (ledger.includes(nodeId)) return;

          /**
           * The claim is durable, and it is written *before* the action. A
           * crash between the two loses an effect; a crash the other way round
           * performs one twice, and for a system whose premise is that a human
           * authorised exactly one action, only the first is recoverable.
           *
           * The check above cannot separate two workers racing a resume. The
           * row can.
           */
          const claimed = await options.runs.claimEffect({
            runId,
            nodeId,
            effect,
            ...(input === undefined ? {} : { input }),
            at: options.clock.now().toISOString(),
          });
          ledger.push(nodeId);

          if (!claimed) {
            // Another worker owns this dispatch. Adopt what it pinned, so the
            // run continues on the same data rather than on nothing.
            const persisted = await options.runs.load(runId);
            const already = persisted?.values.find(
              (pinned) => pinned.nodeId === nodeId,
            );
            if (already !== undefined) values.set(nodeId, already.value);
            return;
          }

          const produced = await options.effects.perform(
            runId,
            nodeId,
            effect,
            input,
          );
          await pinValue(
            nodeId,
            produced === undefined ? undefined : pin(nodeId, produced),
          );
          observability.event("forge.effect.dispatched", {
            runId,
            nodeId,
            effect,
            sequence: ledger.length,
          });
        },
      },
      state.authorised,
      view,
    );

    if (result.kind === "failed") {
      // Retry is an attempt, not a state (006 §7): the run stays RUNNING.
      if (result.retryable && state.record.attempt < state.retryBudget) {
        observability.event("forge.run.retry", {
          runId: state.record.runId,
          nodeId: result.nodeId,
          attempt: state.record.attempt + 1,
        });
        await update(state, { attempt: state.record.attempt + 1 });
        return advance(state);
      }
      observability.event("forge.run.failed", {
        runId: state.record.runId,
        nodeId: result.nodeId,
      });
      return update(state, {
        status: "FAILED",
        error: `${result.nodeId}: ${result.reason}`,
        performedEffects: [...ledger],
      });
    }

    if (result.kind === "succeeded") {
      observability.event("forge.run.succeeded", {
        runId: state.record.runId,
        effects: ledger.length,
      });
      return update(state, {
        status: "SUCCEEDED",
        performedEffects: [...ledger],
        pendingApprovalId: undefined,
      });
    }

    // An unauthorised side effect. Ask policy before asking a human.
    const policySpan = observability.startSpan("forge.policy.decide", {
      runId: state.record.runId,
      nodeId: result.nodeId,
      action: result.effect,
      environment: options.environment,
    });
    const decision = await options.policy.decide({
      actor: options.actor,
      action: result.effect,
      environment: options.environment,
      capabilities: state.capabilities,
    });
    // `PolicyDecision` carries no rule id on an allow, so the span reports it
    // absent rather than substituting one the evaluator never named.
    policySpan.end({
      decision: decision.kind,
      allow: decision.kind === "allow",
      ...(decision.kind === "allow" ? {} : { policyId: decision.policyId }),
    });

    if (decision.kind === "deny") {
      return update(state, {
        status: "FAILED",
        error: `${decision.policyId}: ${decision.reason}`,
        performedEffects: [...ledger],
      });
    }

    if (decision.kind === "allow") {
      state.authorised.add(result.nodeId);
      return advance(state);
    }

    // require-approval: checkpoint, create the record, release the worker.
    const binding = effectHash({
      runId: state.record.runId,
      nodeId: result.nodeId,
      effect: result.effect,
      fingerprint: state.record.fingerprint,
    });

    // The values go with the position. Resuming on freshly computed data would
    // perform a different action from the one on the approval.
    const pinned = snapshot(values);
    await options.checkpoints.save({
      runId: state.record.runId,
      stepId: result.nodeId,
      stateVersion: state.record.attempt,
      resumeToken: binding,
      ...(Object.keys(pinned).length === 0 ? {} : { values: pinned }),
    });

    const approval = await options.approvals.request({
      runId: state.record.runId,
      nodeId: result.nodeId,
      effect: result.effect,
      effectHash: binding,
      policyId: decision.policyId,
      approvers: decision.approvers,
      expiresAt: expiry(),
    });

    // Approvers are counted rather than named: who may decide is on the durable
    // record, and how many is what a dashboard needs.
    observability.event("forge.approval.requested", {
      runId: state.record.runId,
      nodeId: result.nodeId,
      approvalId: approval.approvalId,
      effect: result.effect,
      effectHash: binding,
      policyId: decision.policyId,
      approverCount: decision.approvers.length,
      expiresAt: approval.expiresAt,
    });

    return update(state, {
      status: "AWAITING_APPROVAL",
      pendingApprovalId: approval.approvalId,
      performedEffects: [...ledger],
    });
  }

  /** Leaves the gate on an approval, authorising exactly the node it named. */
  async function carry(state: RunState, nodeId: string): Promise<RunRecord> {
    state.authorised.add(nodeId);
    await update(state, {
      status: "RUNNING",
      attempt: state.record.attempt + 1,
      pendingApprovalId: undefined,
    });
    return advance(state);
  }

  /**
   * A run parked at a gate, re-entered.
   *
   * The decision may already be durable without this runtime having processed
   * it: writing to the approval store is all a control plane in another
   * process can do. So the two things the gate exists to guarantee are checked
   * again here, where the dispatch is actually authorised — the binding still
   * describes this action, and the deadline had not passed when it was
   * decided. Neither is re-derived from anything this process chose.
   */
  async function reenterGate(state: RunState): Promise<RunRecord> {
    const approvalId = state.record.pendingApprovalId;
    if (approvalId === undefined) return state.record;

    const approval = await options.approvals.get(approvalId);
    // Undecided is not a yes. The run stays exactly where it parked.
    if (approval === undefined || approval.status === "PENDING") {
      return state.record;
    }

    const refuse = (error: string): Promise<RunRecord> =>
      update(state, { status: "FAILED", error, pendingApprovalId: undefined });

    if (!bindsTo(state, approval)) {
      return refuse("Approval no longer matches the action it was bound to.");
    }

    if (approval.status !== "APPROVED") {
      return refuse(
        `Approval ${approvalId} was ${approval.status}, which authorises nothing.`,
      );
    }

    // An expired gate is not a slow yes (006 §9). The runtime enforces this on
    // the path it owns; a decision written straight to the store has to meet
    // it here too, or the deadline means nothing across processes. An approval
    // that names no moment cannot be shown to have met it.
    if (
      approval.decidedAt === undefined ||
      approval.decidedAt > approval.expiresAt
    ) {
      observability.event("forge.approval.expired", {
        runId: state.record.runId,
        nodeId: approval.nodeId,
        approvalId,
        effect: approval.effect,
        expiresAt: approval.expiresAt,
      });
      return refuse(
        `Approval ${approvalId} was not decided within its deadline.`,
      );
    }

    observability.event("forge.run.resumed", {
      runId: state.record.runId,
      nodeId: approval.nodeId,
      approvalId,
      effectHash: approval.effectHash,
    });
    return carry(state, approval.nodeId);
  }

  return {
    async start(input) {
      const runId = options.ids.next("run");
      const span = observability.startSpan("forge.run.start", {
        runId,
        workflowId: input.artifact.workflowId,
        fingerprint: input.artifact.fingerprint,
      });
      const state: RunState = {
        record: {
          runId,
          workflowId: input.artifact.workflowId,
          fingerprint: input.artifact.fingerprint,
          status: "PENDING",
          attempt: 1,
          performedEffects: [],
        },
        capabilities: input.capabilities ?? [],
        authorised: new Set<string>(),
        plan: await options.engine.materialize(input.artifact.ir),
        roles: input.artifact.ir.roles,
        changedPaths: input.changedPaths ?? [],
        retryBudget: retryBudgetFor(input.artifact.ir),
      };
      runs.set(runId, state);
      ledgers.set(runId, []);
      routeLedgers.set(runId, new Map());
      valueLedgers.set(runId, new Map());

      // The sealed artifact goes with the run, which is what lets another
      // process re-enter it from a run id alone. Until there is an artifact
      // registry, the run row is one.
      await options.runs.create({
        record: state.record,
        artifact: {
          workflowId: input.artifact.workflowId,
          fingerprint: input.artifact.fingerprint,
          ir: input.artifact.ir as unknown as JsonValue,
        },
        capabilities: state.capabilities,
        changedPaths: state.changedPaths,
      });

      // The run's payload is the value of its input nodes, and of nothing else.
      // With no payload they produce nothing, so a node that reads one stops
      // the run rather than proceeding on an invented empty object.
      const values = valueLedgers.get(runId) as ValueLedger;
      if (input.payload !== undefined) {
        for (const node of input.artifact.ir.nodes) {
          if (node.kind !== "input") continue;
          const pinned = pin(node.id, input.payload);
          values.set(node.id, pinned);
          await options.runs.pinValue(runId, node.id, pinned);
        }
      }

      await update(state, { status: "RUNNING" });
      const record = await advance(state);
      span.end({ status: record.status });
      return record;
    },

    async resume(runId) {
      const state = await hydrate(runId);
      if (state === undefined) return undefined;

      if (state.record.status === "AWAITING_APPROVAL") {
        return reenterGate(state);
      }
      // A run that was mid-walk when its process ended. Re-entering replays
      // every ledger and invokes nothing that already answered.
      if (
        state.record.status === "RUNNING" ||
        state.record.status === "PENDING"
      ) {
        return advance(state);
      }
      // Terminal. There is nothing to continue, and nothing to redo.
      return state.record;
    },

    async loadRun(runId) {
      return (await hydrate(runId))?.record;
    },

    async decide(approvalId, decision, principal) {
      const approval = await options.approvals.get(approvalId);
      if (approval === undefined) throw new Error("Unknown approval.");
      const state = await hydrate(approval.runId);
      if (state === undefined) throw new Error("Unknown run.");

      if (state.record.status === "CANCELLED")
        throw new Error("Run is cancelled.");

      // Single-use, enforced by the port. A repeat delivery is a no-op.
      if (approval.status !== "PENDING") return state.record;

      // The decision authorises one action under one compiled version, so a
      // binding that no longer recomputes is stale and must not be honoured.
      if (!bindsTo(state, approval)) {
        throw new Error(
          "Approval no longer matches the action it was bound to.",
        );
      }

      // An expired gate is not a slow yes; it times out (006 §9).
      if (options.clock.now() > new Date(approval.expiresAt)) {
        await options.approvals.decide(
          approvalId,
          { kind: "timeout" },
          principal,
        );
        observability.event("forge.approval.expired", {
          runId: approval.runId,
          nodeId: approval.nodeId,
          approvalId,
          effect: approval.effect,
          expiresAt: approval.expiresAt,
          // The decision the clock refused.
          attempted: decision.kind,
        });
        return update(state, {
          status: "FAILED",
          error: `Approval ${approvalId} expired before a decision was recorded.`,
          pendingApprovalId: undefined,
        });
      }

      await options.approvals.decide(approvalId, decision, principal);
      observability.event("forge.approval.decided", {
        runId: approval.runId,
        nodeId: approval.nodeId,
        approvalId,
        effect: approval.effect,
        effectHash: approval.effectHash,
        decision: decision.kind,
        principalHash: principalTag(principal),
      });

      if (decision.kind === "reject") {
        return update(state, {
          status: "FAILED",
          error: `Rejected by ${principal}: ${decision.reason}`,
          pendingApprovalId: undefined,
        });
      }

      if (decision.kind === "timeout") {
        return update(state, {
          status: "FAILED",
          error: `Approval ${approvalId} timed out.`,
          pendingApprovalId: undefined,
        });
      }

      if (decision.kind === "edit") {
        // An edit authorises nothing: amending the action makes the original
        // binding no longer describe it, so it asks for a fresh decision.
        const reissued = await options.approvals.request({
          runId: approval.runId,
          nodeId: approval.nodeId,
          effect: approval.effect,
          effectHash: approval.effectHash,
          policyId: approval.policyId,
          approvers: approval.approvers,
          expiresAt: expiry(),
        });
        observability.event("forge.approval.edited", {
          runId: approval.runId,
          nodeId: approval.nodeId,
          approvalId,
          effect: approval.effect,
          // Names the successor, so the audit shows which gate authorised the
          // amended action.
          reissuedAs: reissued.approvalId,
        });
        return update(state, {
          status: "AWAITING_APPROVAL",
          pendingApprovalId: reissued.approvalId,
        });
      }

      // The approval authorises exactly the node it was bound to.
      return carry(state, approval.nodeId);
    },

    async cancel(runId) {
      const state = await hydrate(runId);
      if (state === undefined) throw new Error("Unknown run.");
      if (
        state.record.status === "SUCCEEDED" ||
        state.record.status === "FAILED"
      ) {
        return state.record;
      }
      return update(state, {
        status: "CANCELLED",
        pendingApprovalId: undefined,
      });
    },

    getRun: (runId) => runs.get(runId)?.record,
    getApproval: (approvalId) => options.approvals.get(approvalId),
    ledger: (runId) => [...(ledgers.get(runId) ?? [])],
  };
}
