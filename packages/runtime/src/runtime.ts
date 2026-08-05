import { createHash } from "node:crypto";

import type { ForgeIr } from "@forge/ir";
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
  GraphEnginePort,
  IdPort,
  JudgeVerdict,
  ObservabilityPort,
  PolicyPort,
  ProviderPort,
  SandboxPort,
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
  plan: unknown;
  roles: Readonly<Record<string, import("@forge/ir").Role>>;
  changedPaths: readonly string[];
  retryBudget: number;
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const runs = new Map<string, RunState>();
  const ledgers = new Map<string, string[]>();
  /**
   * Verdicts already reached in a run, per judge node.
   *
   * A resumed attempt re-walks the nodes before the interrupt, so without this
   * a judge is asked again — and a judge is a model call, not a pure function.
   * A verdict that changed on resume would silently reroute the run after a
   * human had already decided on the first route: the operator approves
   * `prod.write`, the judge answers differently the second time, the arm
   * carrying that effect dies, and the run reports SUCCEEDED having done
   * nothing. The decision a human acted on has to still be the decision in
   * force. Same reasoning as the effect ledger, applied to control flow.
   */
  const verdictLedgers = new Map<string, Map<string, JudgeVerdict>>();

  const update = (state: RunState, patch: Partial<RunRecord>): RunRecord => {
    state.record = { ...state.record, ...patch };
    return state.record;
  };

  /** Highest maxAttempts declared on any node, so a transient failure retries. */
  function maxAttemptsFor(state: RunState): number {
    return state.retryBudget;
  }

  async function advance(state: RunState): Promise<RunRecord> {
    const ledger = ledgers.get(state.record.runId) as string[];
    const verdicts = verdictLedgers.get(state.record.runId) as Map<
      string,
      JudgeVerdict
    >;

    const result = await options.engine.execute(
      state.plan as never,
      {
        runId: state.record.runId,

        invokeAgent: async (nodeId, promptRef, role) => {
          const span = options.observability.startSpan("forge.node.agent", {
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
          const span = options.observability.startSpan("forge.node.judge", {
            runId: state.record.runId,
            nodeId,
            judgeRef,
          });

          // Decided once per run. Re-asking on a resumed walk would let the
          // route change under a decision a human has already made.
          const settled = verdicts.get(nodeId);
          if (settled !== undefined) {
            span.end({ verdict: settled, replayed: true });
            return settled;
          }

          const panel = composePanel(state.roles, options.panel, {
            paths: state.changedPaths,
          });
          const votes = options.votesFor?.(nodeId, judgeRef) ?? {};
          const outcome = resolveVerdict(panel, votes);
          verdicts.set(nodeId, outcome.verdict);
          span.end({
            verdict: outcome.verdict,
            members: panel.members.length,
            reason: outcome.reason,
          });
          return outcome.verdict;
        },

        enterSandbox: async (nodeId, profile) => {
          const health = await options.sandbox.health();
          options.observability.event("forge.node.sandbox", {
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
        },
      },
      state.authorised,
    );

    if (result.kind === "failed") {
      // Workflow retry, distinct from transport retry (006 §7). The run stays
      // RUNNING and the attempt increments; it is not a separate state.
      if (result.retryable && state.record.attempt < maxAttemptsFor(state)) {
        options.observability.event("forge.run.retry", {
          runId: state.record.runId,
          nodeId: result.nodeId,
          attempt: state.record.attempt + 1,
        });
        update(state, { attempt: state.record.attempt + 1 });
        return advance(state);
      }
      options.observability.event("forge.run.failed", {
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
      options.observability.event("forge.run.succeeded", {
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
    const decision = await options.policy.decide({
      actor: options.actor,
      action: result.effect,
      environment: options.environment,
      capabilities: state.capabilities,
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
      expiresAt: new Date(
        options.clock.now().getTime() + options.approvalTtlMs,
      ).toISOString(),
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
      const span = options.observability.startSpan("forge.run.start", {
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
      verdictLedgers.set(runId, new Map());
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

      // The decision authorises one action under one compiled version. If the
      // recomputed binding disagrees with the stored one, the approval is
      // stale and must not be honoured.
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

      // An expired gate is not a slow yes. It times out rather than being
      // honoured late (006 §9).
      if (options.clock.now() > new Date(approval.expiresAt)) {
        await options.approvals.decide(
          approvalId,
          { kind: "timeout" },
          principal,
        );
        return update(state, {
          status: "FAILED",
          error: `Approval ${approvalId} expired before a decision was recorded.`,
          pendingApprovalId: undefined,
        });
      }

      await options.approvals.decide(approvalId, decision, principal);

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
        // Amending the action changes what was proposed, so the original
        // binding no longer describes it. The edit does not authorise
        // anything; it asks for a fresh decision on the new action.
        const reissued = await options.approvals.request({
          runId: approval.runId,
          nodeId: approval.nodeId,
          effect: approval.effect,
          effectHash: approval.effectHash,
          policyId: approval.policyId,
          approvers: approval.approvers,
          expiresAt: new Date(
            options.clock.now().getTime() + options.approvalTtlMs,
          ).toISOString(),
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
