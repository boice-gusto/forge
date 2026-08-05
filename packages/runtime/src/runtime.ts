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
  JudgeVerdict,
  ObservabilityPort,
  PolicyPort,
  ProviderPort,
  SandboxPort,
  Span,
} from "@forge/ports";

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
}

export interface EffectSink {
  perform(runId: string, nodeId: string, effect: string): Promise<void>;
}

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
  readonly effects: EffectSink;
  readonly checkpoints: CheckpointStorePort;
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

export interface Runtime {
  start(input: StartInput): Promise<RunRecord>;
  decide(
    approvalId: string,
    decision: ApprovalDecision,
    principal: string,
  ): Promise<RunRecord>;
  cancel(runId: string): Promise<RunRecord>;
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
   * The single place a run's status changes, so the lifecycle transition
   * (006 §5) is reported from one choke point rather than at each of the nine
   * call sites that move a run — one of which would eventually be missed.
   */
  const update = (state: RunState, patch: Partial<RunRecord>): RunRecord => {
    const from = state.record.status;
    state.record = { ...state.record, ...patch };
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

  /** When an approval this runtime issues stops being actionable. */
  const expiry = (): string =>
    new Date(
      options.clock.now().getTime() + options.approvalTtlMs,
    ).toISOString();

  async function advance(state: RunState): Promise<RunRecord> {
    const ledger = ledgers.get(state.record.runId) as string[];
    const routes = routeLedgers.get(state.record.runId) as Map<string, string>;

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
          const session = await options.provider.createSession({
            workspacePath: `/workspace/${state.record.runId}`,
            correlationId: state.record.runId,
            capabilities: [],
          });
          try {
            for await (const event of options.provider.execute(session, {
              prompt: promptRef,
            })) {
              if (event.type === "error") {
                throw new Error(`${event.code}: ${event.message}`);
              }
            }
          } finally {
            await options.provider.destroySession(session);
            span.end();
          }
        },

        judge: async (nodeId, judgeRef): Promise<JudgeVerdict> => {
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
          const votes = options.votesFor?.(nodeId, judgeRef) ?? {};
          const outcome = resolveVerdict(panel, votes);
          routes.set(nodeId, outcome.verdict);
          span.end({
            verdict: outcome.verdict,
            panelSize: panel.members.length,
            reason: outcome.reason,
          });
          return outcome.verdict;
        },

        chooseBranch: async (nodeId, conditionIds): Promise<string> => {
          const settled = routes.get(nodeId);
          if (settled !== undefined) return settled;

          const chosen = options.branchFor?.(nodeId, conditionIds);
          if (chosen === undefined) {
            // Fail closed: running every arm would make a branch a fan-out, and
            // picking one would invent a decision the workflow did not make.
            throw new Error(
              `No arm was chosen for branch '${nodeId}'; declared arms are ${conditionIds.join(", ")}.`,
            );
          }
          routes.set(nodeId, chosen);
          observability.event("forge.node.branch", {
            runId: state.record.runId,
            nodeId,
            arm: chosen,
          });
          return chosen;
        },

        enterSandbox: async (nodeId, profile) => {
          const health = await options.sandbox.health();
          observability.event("forge.node.sandbox", {
            runId: state.record.runId,
            nodeId,
            profile,
            available: health.available,
          });
          if (!health.available) {
            throw new Error(
              `Required sandbox profile '${profile}' is unavailable; host execution is not permitted.`,
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
        perform: async (nodeId, effect) => {
          // Replay safety: a resumed attempt re-walks pre-interrupt nodes, so
          // an already-dispatched effect must not fire twice (006 §8).
          if (ledger.includes(nodeId)) return;
          await options.effects.perform(state.record.runId, nodeId, effect);
          ledger.push(nodeId);
          observability.event("forge.effect.dispatched", {
            runId: state.record.runId,
            nodeId,
            effect,
            sequence: ledger.length,
          });
        },
      },
      state.authorised,
    );

    if (result.kind === "failed") {
      // Retry is an attempt, not a state (006 §7): the run stays RUNNING.
      if (result.retryable && state.record.attempt < state.retryBudget) {
        observability.event("forge.run.retry", {
          runId: state.record.runId,
          nodeId: result.nodeId,
          attempt: state.record.attempt + 1,
        });
        update(state, { attempt: state.record.attempt + 1 });
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

    await options.checkpoints.save({
      runId: state.record.runId,
      stepId: result.nodeId,
      stateVersion: state.record.attempt,
      resumeToken: binding,
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

  return {
    async start(input) {
      const runId = options.ids.next("run");
      const span = observability.startSpan("forge.run.start", {
        runId,
        workflowId: input.artifact.workflowId,
        fingerprint: input.artifact.fingerprint,
      });
      const plan = await options.engine.materialize(input.artifact.ir);
      const retryBudget = input.artifact.ir.nodes.reduce(
        (highest, node) =>
          "retry" in node && node.retry !== undefined
            ? Math.max(highest, node.retry.maxAttempts)
            : highest,
        1,
      );
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
        plan,
        roles: input.artifact.ir.roles,
        changedPaths: input.changedPaths ?? [],
        retryBudget,
      };
      runs.set(runId, state);
      ledgers.set(runId, []);
      routeLedgers.set(runId, new Map());
      update(state, { status: "RUNNING" });
      const record = await advance(state);
      span.end({ status: record.status });
      return record;
    },

    async decide(approvalId, decision, principal) {
      const approval = await options.approvals.get(approvalId);
      if (approval === undefined) throw new Error("Unknown approval.");
      const state = runs.get(approval.runId);
      if (state === undefined) throw new Error("Unknown run.");

      if (state.record.status === "CANCELLED")
        throw new Error("Run is cancelled.");

      // Single-use, enforced by the port. A repeat delivery is a no-op.
      if (approval.status !== "PENDING") return state.record;

      // The decision authorises one action under one compiled version, so a
      // binding that no longer recomputes is stale and must not be honoured.
      const expected = effectHash({
        runId: approval.runId,
        nodeId: approval.nodeId,
        effect: approval.effect,
        fingerprint: state.record.fingerprint,
      });
      if (expected !== approval.effectHash) {
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
      state.authorised.add(approval.nodeId);
      update(state, {
        status: "RUNNING",
        attempt: state.record.attempt + 1,
        pendingApprovalId: undefined,
      });
      return advance(state);
    },

    async cancel(runId) {
      const state = runs.get(runId);
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
