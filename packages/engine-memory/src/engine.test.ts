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
