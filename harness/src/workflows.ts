/**
 * Three workflow shapes, all gated on `slack.post` — the one action Acme's
 * policy pack requires a human for. Every scenario in this harness drives a run
 * to that gate and then attacks the moment around the decision, so the fixtures
 * differ only in what makes the window observable.
 */

/** The value every scenario starts a run with. */
export const PAYLOAD = { body: "the copy" } as const;

/** What the harness effect sink returns, so a downstream node has something. */
export const PUBLISHED = { published: true, at: "harness" } as const;

/**
 * Gate, dispatch, stop. Nothing downstream reads the tool's output, so this one
 * runs unchanged against the shipped `apps/api` and `apps/worker`, whose effect
 * sink performs nothing and returns nothing.
 */
export const GATED = {
  id: "harness.gated",
  version: "1.0.0",
  sideEffects: ["slack.post"],
  nodes: [
    { id: "intake", kind: "input", schemaRef: "harness.brief@1" },
    {
      id: "gate",
      kind: "approval",
      gateSchemaRef: "harness.gate@1",
      gates: ["publish"],
    },
    {
      id: "publish",
      kind: "tool",
      skillRef: "harness.publish@1",
      effect: "slack.post",
      reads: { node: "intake", path: ["body"] },
    },
    { id: "done", kind: "output", schemaRef: "harness.result@1" },
  ],
  edges: [
    { from: "intake", to: "gate" },
    { from: "gate", to: "publish" },
    { from: "publish", to: "done" },
  ],
} as const;

/**
 * The same shape, with the output node reading what the tool produced.
 *
 * That one edge is what makes a lost dispatch visible: a walk that reaches
 * `done` without `publish` having pinned a value fails closed rather than
 * reporting SUCCEEDED with nothing behind it. Two workers racing the gate are
 * told apart by it.
 */
export const CHAINED = {
  ...GATED,
  id: "harness.chained",
  nodes: [
    ...GATED.nodes.slice(0, 3),
    {
      id: "done",
      kind: "output",
      schemaRef: "harness.result@1",
      reads: { node: "publish", path: [] },
    },
  ],
} as const;

/** The transform ref the harness worker binds; see `worker-entry.ts`. */
export const SLOW_TRANSFORM = "harness.slow";

/**
 * A run with a slow node *before* the gate, so a scenario has a window in which
 * the walk is genuinely in flight and no effect has been claimed. Everything
 * after the gate reads `prepare`, so a resumed walk that failed to replay the
 * pinned value would be visible rather than silent.
 */
export const SLOW = {
  id: "harness.slow-walk",
  version: "1.0.0",
  sideEffects: ["slack.post"],
  nodes: [
    { id: "intake", kind: "input", schemaRef: "harness.brief@1" },
    {
      id: "prepare",
      kind: "transform",
      transformRef: SLOW_TRANSFORM,
      reads: { node: "intake", path: [] },
    },
    {
      id: "gate",
      kind: "approval",
      gateSchemaRef: "harness.gate@1",
      gates: ["publish"],
    },
    {
      id: "publish",
      kind: "tool",
      skillRef: "harness.publish@1",
      effect: "slack.post",
      reads: { node: "prepare", path: ["body"] },
    },
    {
      id: "done",
      kind: "output",
      schemaRef: "harness.result@1",
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
