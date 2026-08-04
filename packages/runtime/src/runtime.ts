import { createHash } from "node:crypto";

import type { ForgeIr } from "@forge/ir";
import type {
  CheckpointStorePort,
  ClockPort,
  GraphEnginePort,
  IdPort,
  PolicyPort,
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

export type ApprovalDecision =
  | { readonly kind: "approve" }
  | { readonly kind: "reject"; readonly reason: string };

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly effect: string;
  /** Binds the decision to this exact action (006 §6.4). */
  readonly effectHash: string;
  readonly policyId: string;
  readonly approvers: readonly string[];
  readonly status: "PENDING" | "APPROVED" | "REJECTED";
  readonly decidedBy?: string | undefined;
  readonly createdAt: string;
}

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
  readonly effects: EffectSink;
  readonly checkpoints: CheckpointStorePort;
  readonly clock: ClockPort;
  readonly ids: IdPort;
  readonly actor: string;
  readonly environment: string;
}

export interface StartInput {
  readonly artifact: SealedArtifact;
  /** Capabilities the workflow's roles require, closed at compile time. */
  readonly capabilities?: readonly string[];
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
  getApproval(approvalId: string): ApprovalRecord | undefined;
  /** Effects actually dispatched, in order. Used to prove exactly-once. */
  ledger(runId: string): readonly string[];
}

interface RunState {
  record: RunRecord;
  capabilities: readonly string[];
  authorised: Set<string>;
  plan: unknown;
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const runs = new Map<string, RunState>();
  const approvals = new Map<string, ApprovalRecord>();
  const ledgers = new Map<string, string[]>();

  const update = (state: RunState, patch: Partial<RunRecord>): RunRecord => {
    state.record = { ...state.record, ...patch };
    return state.record;
  };

  async function advance(state: RunState): Promise<RunRecord> {
    const ledger = ledgers.get(state.record.runId) as string[];

    const result = await options.engine.execute(
      state.plan as never,
      {
        runId: state.record.runId,
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
      return update(state, {
        status: "FAILED",
        error: `${result.nodeId}: ${result.reason}`,
        performedEffects: [...ledger],
      });
    }

    if (result.kind === "succeeded") {
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

    const approvalId = options.ids.next("approval");
    approvals.set(approvalId, {
      approvalId,
      runId: state.record.runId,
      nodeId: result.nodeId,
      effect: result.effect,
      effectHash: binding,
      policyId: decision.policyId,
      approvers: decision.approvers,
      status: "PENDING",
      createdAt: options.clock.now().toISOString(),
    });

    return update(state, {
      status: "AWAITING_APPROVAL",
      pendingApprovalId: approvalId,
      performedEffects: [...ledger],
    });
  }

  return {
    async start(input) {
      const runId = options.ids.next("run");
      const plan = await options.engine.materialize(input.artifact.ir);
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
      };
      runs.set(runId, state);
      ledgers.set(runId, []);
      update(state, { status: "RUNNING" });
      return advance(state);
    },

    async decide(approvalId, decision, principal) {
      const approval = approvals.get(approvalId);
      if (approval === undefined) throw new Error("Unknown approval.");
      const state = runs.get(approval.runId);
      if (state === undefined) throw new Error("Unknown run.");

      if (state.record.status === "CANCELLED")
        throw new Error("Run is cancelled.");

      // At-least-once delivery: deciding the same approval twice must not
      // dispatch the effect twice (006 §8).
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

      if (decision.kind === "reject") {
        approvals.set(approvalId, {
          ...approval,
          status: "REJECTED",
          decidedBy: principal,
        });
        return update(state, {
          status: "FAILED",
          error: `Rejected by ${principal}: ${decision.reason}`,
          pendingApprovalId: undefined,
        });
      }

      approvals.set(approvalId, {
        ...approval,
        status: "APPROVED",
        decidedBy: principal,
      });
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
    getApproval: (approvalId) => approvals.get(approvalId),
    ledger: (runId) => [...(ledgers.get(runId) ?? [])],
  };
}
