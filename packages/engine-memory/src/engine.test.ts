import { compileWorkflow } from "@forge/compiler";
import type { ForgeIr } from "@forge/ir";
import { describe, expect, test } from "vitest";

import { createMemoryGraphEngine } from "./engine.js";

/** A context that records effects and lets every other hook succeed. */
function context(performed: string[]) {
  return {
    runId: "run_1",
    assertCapability: async () => undefined,
    invokeAgent: async () => undefined,
    judge: async () => "pass" as const,
    // Fails closed like the runtime: a test that walks a branch must say which
    // arm it takes, rather than inheriting a silent default.
    chooseBranch: async (nodeId: string): Promise<string> => {
      throw new Error(`No arm was chosen for branch '${nodeId}'.`);
    },
    enterSandbox: async () => undefined,
    perform: async (_nodeId: string, effect: string) => {
      performed.push(effect);
    },
  };
}

/**
 * The engine must execute what the graph reaches and nothing else. Building
 * the IR by hand here on purpose: the compiler now refuses unreachable nodes,
 * so this is the only way to prove the engine is independently safe rather
 * than relying on the compiler having caught it first. Defence in depth —
 * either layer alone would have let the orphan run.
 */
const irWithOrphan: ForgeIr = {
  workflowId: "probe.orphan",
  workflowVersion: "1.0.0",
  sideEffects: ["prod.write"],
  roles: {},
  grantedCapabilities: [],
  nodes: [
    { id: "intake", kind: "input", schemaRef: "s@1" },
    { id: "result", kind: "output", schemaRef: "s@1" },
    { id: "orphan", kind: "tool", skillRef: "t@1", effect: "prod.write" },
  ],
  edges: [{ from: "intake", to: "result" }],
};

/** A judge that routes: one arm per verdict it is allowed to reach. */
const routed = {
  id: "probe.routed",
  version: "1.0.0",
  nodes: [
    { id: "intake", kind: "input", schemaRef: "s@1" },
    {
      id: "panel",
      kind: "judge",
      judgeRef: "j@1",
      verdicts: ["pass", "review"],
    },
    { id: "ship", kind: "transform", transformRef: "ship@1" },
    { id: "revise", kind: "transform", transformRef: "revise@1" },
    { id: "result", kind: "output", schemaRef: "s@1" },
  ],
  edges: [
    { from: "intake", to: "panel" },
    { from: "panel", to: "ship", conditionId: "pass" },
    { from: "panel", to: "revise", conditionId: "review" },
    { from: "ship", to: "result" },
    { from: "revise", to: "result" },
  ],
} as const;

async function walk(
  source: unknown,
  judge: () => Promise<"pass" | "fail" | "review">,
) {
  const compiled = compileWorkflow(source);
  if (!compiled.ok) throw new Error("Fixture must compile.");
  const engine = createMemoryGraphEngine();
  const plan = await engine.materialize(compiled.value.ir);
  const performed: string[] = [];
  const result = await engine.execute(
    plan,
    { ...context(performed), judge },
    new Set(),
  );
  return { result, performed };
}

describe("judge verdict routing", () => {
  test("a review verdict takes its own arm and leaves the pass arm unwalked", async () => {
    const { result } = await walk(routed, async () => "review");

    expect(result.kind).toBe("succeeded");
    if (result.kind !== "succeeded") throw new Error("unreachable");
    expect(result.visited).toEqual(["intake", "panel", "revise", "result"]);
  });

  test("a pass verdict takes the pass arm and leaves the review arm unwalked", async () => {
    const { result } = await walk(routed, async () => "pass");

    expect(result.kind).toBe("succeeded");
    if (result.kind !== "succeeded") throw new Error("unreachable");
    expect(result.visited).toEqual(["intake", "panel", "ship", "result"]);
  });

  test("a verdict with no declared arm stops the run instead of falling through", async () => {
    const { result } = await walk(routed, async () => "fail");

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("unreachable");
    expect(result.reason).toContain("judge verdict fail has no arm");
    expect(result.retryable).toBe(false);
  });

  test("a judge that throws routes nowhere at all", async () => {
    const { result } = await walk(routed, async () => {
      throw new Error("judge provider is down");
    });

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("unreachable");
    expect(result.reason).toContain("judge errored");
    expect(result.retryable).toBe(false);
  });

  test("an unlabelled arm out of a routing judge is dead, whatever the verdict", async () => {
    // Hand-built: the compiler refuses this shape, so the only way to prove
    // the engine is independently safe is to hand it one anyway.
    const engine = createMemoryGraphEngine();
    const plan = await engine.materialize({
      ...routed,
      workflowId: routed.id,
      workflowVersion: routed.version,
      sideEffects: [],
      roles: {},
      grantedCapabilities: [],
      edges: [
        { from: "intake", to: "panel" },
        { from: "panel", to: "ship" },
        { from: "panel", to: "revise", conditionId: "review" },
        { from: "ship", to: "result" },
        { from: "revise", to: "result" },
      ],
    } as unknown as ForgeIr);
    const performed: string[] = [];

    const result = await engine.execute(
      plan,
      { ...context(performed), judge: async () => "review" as const },
      new Set(),
    );

    if (result.kind !== "succeeded") throw new Error("unreachable");
    expect(result.visited).not.toContain("ship");
  });

  test("a node the pruned arm shared with a live path still runs", async () => {
    const { result } = await walk(
      {
        ...routed,
        edges: [
          { from: "intake", to: "panel" },
          { from: "panel", to: "ship", conditionId: "pass" },
          { from: "panel", to: "revise", conditionId: "review" },
          { from: "revise", to: "ship" },
          { from: "ship", to: "result" },
        ],
      },
      async () => "review",
    );

    if (result.kind !== "succeeded") throw new Error("unreachable");
    expect(result.visited).toEqual([
      "intake",
      "panel",
      "revise",
      "ship",
      "result",
    ]);
  });
});

describe("engine reachability", () => {
  test("an unreachable effect node is never visited, even when authorised", async () => {
    const engine = createMemoryGraphEngine();
    const plan = await engine.materialize(irWithOrphan);
    const performed: string[] = [];

    const result = await engine.execute(
      plan,
      {
        ...context(performed),
      },
      new Set(["orphan"]),
    );

    expect(result.kind).toBe("succeeded");
    expect(performed).toEqual([]);
    if (result.kind !== "succeeded") throw new Error("unreachable");
    expect(result.visited).toEqual(["intake", "result"]);
  });

  test("a connected effect node is visited and performed", async () => {
    const compiled = compileWorkflow({
      id: "probe.connected",
      version: "1.0.0",
      sideEffects: ["prod.write"],
      nodes: [
        { id: "intake", kind: "input", schemaRef: "s@1" },
        { id: "gate", kind: "approval", gateSchemaRef: "g@1", gates: ["act"] },
        { id: "act", kind: "tool", skillRef: "t@1", effect: "prod.write" },
        { id: "result", kind: "output", schemaRef: "s@1" },
      ],
      edges: [
        { from: "intake", to: "gate" },
        { from: "gate", to: "act" },
        { from: "act", to: "result" },
      ],
    });
    if (!compiled.ok) throw new Error("Fixture must compile.");

    const engine = createMemoryGraphEngine();
    const plan = await engine.materialize(compiled.value.ir);
    const performed: string[] = [];
    const result = await engine.execute(
      plan,
      {
        ...context(performed),
      },
      new Set(["act"]),
    );

    expect(result.kind).toBe("succeeded");
    expect(performed).toEqual(["prod.write"]);
  });

  test("an unauthorised reachable effect interrupts instead of performing", async () => {
    const compiled = compileWorkflow({
      id: "probe.gated",
      version: "1.0.0",
      sideEffects: ["prod.write"],
      nodes: [
        { id: "intake", kind: "input", schemaRef: "s@1" },
        { id: "gate", kind: "approval", gateSchemaRef: "g@1", gates: ["act"] },
        { id: "act", kind: "tool", skillRef: "t@1", effect: "prod.write" },
        { id: "result", kind: "output", schemaRef: "s@1" },
      ],
      edges: [
        { from: "intake", to: "gate" },
        { from: "gate", to: "act" },
        { from: "act", to: "result" },
      ],
    });
    if (!compiled.ok) throw new Error("Fixture must compile.");

    const engine = createMemoryGraphEngine();
    const plan = await engine.materialize(compiled.value.ir);
    const performed: string[] = [];
    const result = await engine.execute(
      plan,
      {
        ...context(performed),
      },
      new Set(),
    );

    expect(result.kind).toBe("interrupted");
    expect(performed).toEqual([]);
    if (result.kind !== "interrupted") throw new Error("unreachable");
    expect(result.nodeId).toBe("act");
    expect(result.gateIds).toEqual(["gate"]);
  });
});
