import { createMemoryApprovalStore } from "@forge/approval-memory";
import { createMemoryCheckpointStore } from "@forge/checkpoint-memory";
import { compileWorkflow } from "@forge/compiler";
import { createMemoryGraphEngine } from "@forge/engine-memory";
import { createMemoryPolicy, type PolicyRule } from "@forge/policy-memory";
import type { ApprovalPort, ClockPort, IdPort } from "@forge/ports";
import {
  createRuntime,
  type EffectSink,
  type Runtime,
  type SealedArtifact,
} from "@forge/runtime";
import type { Diagnostic } from "@forge/types";

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
}

export interface LocalStack {
  readonly runtime: Runtime;
  readonly approvals: ApprovalPort;
  readonly clock: ClockPort;
  readonly ids: IdPort;
  /** Effects dispatched, in order, when the default recorder is used. */
  readonly dispatched: readonly string[];
  advanceClock(ms: number): void;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createLocalStack(options: LocalStackOptions = {}): LocalStack {
  let instant = new Date(options.startedAt ?? "2026-01-01T00:00:00.000Z");
  const clock: ClockPort = { now: () => new Date(instant) };

  const counters = new Map<string, number>();
  const ids: IdPort = {
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
    },
  };

  const approvals = createMemoryApprovalStore(clock, ids);

  const runtime = createRuntime({
    engine: createMemoryGraphEngine(),
    policy: createMemoryPolicy({
      rules: options.rules ?? [],
      grants: options.grants ?? [],
    }),
    approvals,
    effects,
    checkpoints: createMemoryCheckpointStore(),
    clock,
    ids,
    actor: options.actor ?? "svc.forge.local",
    environment: options.environment ?? "local",
    approvalTtlMs: options.approvalTtlMs ?? DEFAULT_TTL_MS,
  });

  return {
    runtime,
    approvals,
    clock,
    ids,
    dispatched,
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
