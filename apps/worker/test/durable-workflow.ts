import type { JsonValue, ProviderPort } from "@forge/ports";

/**
 * The fixtures both halves of the restart proof share. They live outside `src`
 * on purpose: `child-process.ts` beside them is a process entry point run by
 * `node`, not a module the worker ships, and neither belongs in the coverage
 * set.
 *
 * The shape matters. Every workflow here produces the value the tool acts on
 * *before* the gate, so the effect ledger's `input` column is a direct record
 * of what the approver saw. If a resume recomputed rather than restored, that
 * column would show it.
 */

export const RESTART_WORKFLOW = {
  id: "durable.restart",
  version: "1.0.0",
  sideEffects: ["prod.write"],
  nodes: [
    { id: "intake", kind: "input", schemaRef: "payload@1" },
    {
      id: "prepare",
      kind: "transform",
      transformRef: "prepare",
      reads: { node: "intake", path: [] },
    },
    {
      id: "gate",
      kind: "approval",
      gateSchemaRef: "gate@1",
      gates: ["publish"],
    },
    {
      id: "publish",
      kind: "tool",
      skillRef: "publisher@1",
      effect: "prod.write",
      reads: { node: "prepare", path: [] },
    },
    {
      id: "done",
      kind: "output",
      schemaRef: "receipt@1",
      reads: { node: "publish", path: [] },
    },
  ],
  edges: [
    { from: "intake", to: "prepare" },
    { from: "prepare", to: "gate" },
    { from: "gate", to: "publish" },
    { from: "publish", to: "done" },
  ],
} as const;

/**
 * The workflow the old design had to refuse.
 *
 * An `agent` and a `branch` both sit before the gate. Re-walking would ask the
 * model again and choose the arm again, and neither answer has to match the
 * first — which is why resuming used to mean "prove the walk reproduced the
 * state byte-for-byte, or refuse". Nothing is re-walked now: the value the
 * agent produced and the arm the branch took are read back from the run store.
 */
export const AGENT_WORKFLOW = {
  id: "durable.agent-gate",
  version: "1.0.0",
  sideEffects: ["prod.write"],
  nodes: [
    { id: "intake", kind: "input", schemaRef: "payload@1" },
    { id: "draft", kind: "agent", promptRef: "durable.draft@1" },
    { id: "route", kind: "branch", conditionIds: ["publish-it", "hold"] },
    {
      id: "gate",
      kind: "approval",
      gateSchemaRef: "gate@1",
      gates: ["publish"],
    },
    {
      id: "publish",
      kind: "tool",
      skillRef: "publisher@1",
      effect: "prod.write",
      reads: { node: "draft", path: [] },
    },
    {
      id: "done",
      kind: "output",
      schemaRef: "receipt@1",
      reads: { node: "publish", path: [] },
    },
    {
      id: "held",
      kind: "output",
      schemaRef: "receipt@1",
      reads: { node: "draft", path: [] },
    },
  ],
  edges: [
    { from: "intake", to: "draft" },
    { from: "draft", to: "route" },
    { from: "route", to: "gate", conditionId: "publish-it" },
    { from: "route", to: "held", conditionId: "hold" },
    { from: "gate", to: "publish" },
    { from: "publish", to: "done" },
  ],
} as const;

/** Synthetic throughout. Nothing here is a real member, wage or account. */
export const RESTART_PAYLOAD = { member: "synthetic-001", amount: 4200 };

/** What the effect sink hands back, and therefore the run's result. */
export const RESTART_PUBLISHED = { published: true };

export const RESTART_RULES = [
  {
    id: "durable.external",
    action: "prod.write",
    decision: "require-approval" as const,
    reason: "An external write needs a human.",
    approvers: ["operator"],
  },
];

/**
 * `plan` is the knob the divergence tests turn. A second process that computes
 * something different must still dispatch what the first one pinned.
 */
export function restartTransforms(
  plan = "stable",
): Record<string, (input: JsonValue) => JsonValue> {
  return {
    prepare: (input) => ({
      ...(input as Record<string, JsonValue>),
      plan,
    }),
  };
}

export interface CountingProvider {
  readonly provider: ProviderPort;
  /** How many times a model was asked, in this process. */
  calls(): number;
}

/**
 * A provider that streams one fixed line and counts how often it was asked.
 *
 * The count is per process, which is the point: the restart proof sums what
 * each process reports and requires the total to be one. The text differs per
 * process too, so a second invocation would also be visible in the effect
 * ledger's `input` column rather than only in a counter.
 */
export function countingProvider(text: string): CountingProvider {
  let calls = 0;
  let sessions = 0;
  const provider: ProviderPort = {
    providerId: "counting",
    capabilities: ["streaming"],
    async createSession() {
      sessions += 1;
      return { sessionId: `session_${sessions}`, providerId: "counting" };
    },
    async resumeSession(input) {
      return { sessionId: input.sessionId, providerId: "counting" };
    },
    async *execute() {
      calls += 1;
      yield { type: "text-delta", text } as const;
      yield { type: "completed" } as const;
    },
    async cancel() {},
    async destroySession() {},
    async health() {
      return { available: true, providerId: "counting" };
    },
  };
  return { provider, calls: () => calls };
}

export const RESTART_STACK_OPTIONS = {
  rules: RESTART_RULES,
  grants: ["prod.write"],
  environment: "production",
  actor: "svc.forge.test",
};
