import type { JsonValue } from "@forge/ports";

/**
 * The fixture both halves of the restart proof share. It lives outside `src`
 * on purpose: `park-run.ts` beside it is a process entry point run by `node`,
 * not a module the worker ships, and neither belongs in the coverage set.
 *
 * The shape matters. `prepare` produces the value the tool acts on, so the
 * effect ledger's `input` column is a direct record of what the approver saw.
 * If a resume recomputed rather than restored, that column would show it.
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
 * `plan` is the knob the divergence test turns. Both processes normally agree;
 * one that disagrees is a resume computing fresh data, and the guard must
 * refuse it rather than dispatch on it.
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

export const RESTART_STACK_OPTIONS = {
  rules: RESTART_RULES,
  grants: ["prod.write"],
  environment: "production",
  actor: "svc.forge.test",
};
