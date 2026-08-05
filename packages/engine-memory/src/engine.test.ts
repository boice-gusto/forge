import { compileWorkflow } from "@forge/compiler";
import type { ForgeIr } from "@forge/ir";
import type { JsonValue, RunValues } from "@forge/ports";
import { describe, expect, test } from "vitest";

import { createMemoryGraphEngine } from "./engine.js";

/** A context that records effects and lets every other hook succeed. */
function context(performed: string[]) {
  return {
    runId: "run_1",
    assertCapability: async () => undefined,
    invokeAgent: async () => undefined,
    transform: async () => undefined,
    emitOutput: async () => undefined,
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
 * A value store the engine can consult. Backed by a plain map so a test can say
 * exactly what has been produced, including "nothing at all".
 */
function store(entries: Readonly<Record<string, JsonValue>> = {}): RunValues {
  const values = new Map(Object.entries(entries));
  return {
    read: (nodeId, path) => {
      if (!values.has(nodeId))
        throw new Error(`Node '${nodeId}' has produced no value to read.`);
      let current = values.get(nodeId) as JsonValue;
      for (const segment of path) {
        if (
          current === null ||
          typeof current !== "object" ||
          Array.isArray(current) ||
          !(segment in current)
        ) {
          throw new Error(`Node '${nodeId}' has no value at '${segment}'.`);
        }
        current = (current as { readonly [key: string]: JsonValue })[
          segment
        ] as JsonValue;
      }
      return current;
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
    store(),
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
      store(),
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
      store(),
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
      store(),
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
      store(),
    );

    expect(result.kind).toBe("interrupted");
    expect(performed).toEqual([]);
    if (result.kind !== "interrupted") throw new Error("unreachable");
    expect(result.nodeId).toBe("act");
    expect(result.gateIds).toEqual(["gate"]);
  });
});

/**
 * The data plane, at the layer that walks the graph. The engine resolves what a
 * node declared it reads and hands it to the hook; it never writes a value and
 * never invents one.
 */
describe("nodes read what they declared", () => {
  const flowing = {
    id: "probe.flow",
    version: "1.0.0",
    sideEffects: ["prod.write"],
    nodes: [
      { id: "intake", kind: "input", schemaRef: "s@1" },
      {
        id: "shape",
        kind: "transform",
        transformRef: "shape@1",
        reads: { node: "intake", path: ["inner"] },
      },
      { id: "gate", kind: "approval", gateSchemaRef: "g@1", gates: ["act"] },
      {
        id: "act",
        kind: "tool",
        skillRef: "t@1",
        effect: "prod.write",
        reads: { node: "shape" },
      },
      {
        id: "result",
        kind: "output",
        schemaRef: "s@1",
        reads: { node: "act" },
      },
    ],
    edges: [
      { from: "intake", to: "shape" },
      { from: "shape", to: "gate" },
      { from: "gate", to: "act" },
      { from: "act", to: "result" },
    ],
  } as const;

  async function run(
    values: RunValues,
    authorised: readonly string[] = ["act"],
  ) {
    const compiled = compileWorkflow(flowing);
    if (!compiled.ok) throw new Error("Fixture must compile.");
    const engine = createMemoryGraphEngine();
    const plan = await engine.materialize(compiled.value.ir);
    const seen: { node: string; input: unknown }[] = [];
    const result = await engine.execute(
      plan,
      {
        ...context([]),
        transform: async (nodeId, _ref, input) => {
          seen.push({ node: nodeId, input });
        },
        perform: async (nodeId, _effect, input) => {
          seen.push({ node: nodeId, input });
        },
        emitOutput: async (nodeId, value) => {
          seen.push({ node: nodeId, input: value });
        },
      },
      new Set(authorised),
      values,
    );
    return { result, seen };
  }

  test("each node is handed the value at the path it declared", async () => {
    const { result, seen } = await run(
      store({ intake: { inner: "payload" }, shape: "shaped", act: "done" }),
    );

    expect(result.kind).toBe("succeeded");
    expect(seen).toEqual([
      { node: "shape", input: "payload" },
      { node: "act", input: "shaped" },
      { node: "result", input: "done" },
    ]);
  });

  test("a missing value stops the walk at the node that read it", async () => {
    const { result, seen } = await run(store({}));

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("unreachable");
    expect(result.nodeId).toBe("shape");
    expect(result.retryable).toBe(false);
    expect(seen).toEqual([]);
  });

  test("a tool whose input cannot be resolved never reaches its gate", async () => {
    // Nothing is authorised, so an unresolved read must fail rather than
    // interrupt: an approval has to name an action that exists. `shape` has
    // produced nothing here, so `act` has nothing to act on.
    const { result } = await run(store({ intake: { inner: "x" } }), []);

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("unreachable");
    expect(result.nodeId).toBe("act");
    expect(result.retryable).toBe(false);
  });

  test("an unauthorised tool still interrupts once its input resolves", async () => {
    const { result } = await run(
      store({ intake: { inner: "x" }, shape: "shaped" }),
      [],
    );

    expect(result.kind).toBe("interrupted");
    if (result.kind !== "interrupted") throw new Error("unreachable");
    expect(result.nodeId).toBe("act");
  });

  test("a branch is offered the value it read, and the hook decides", async () => {
    const branching = {
      id: "probe.branch-data",
      version: "1.0.0",
      nodes: [
        { id: "intake", kind: "input", schemaRef: "s@1" },
        {
          id: "route",
          kind: "branch",
          conditionIds: ["left", "right"],
          reads: { node: "intake", path: ["arm"] },
        },
        { id: "l", kind: "transform", transformRef: "l@1" },
        { id: "r", kind: "transform", transformRef: "r@1" },
        { id: "result", kind: "output", schemaRef: "s@1" },
      ],
      edges: [
        { from: "intake", to: "route" },
        { from: "route", to: "l", conditionId: "left" },
        { from: "route", to: "r", conditionId: "right" },
        { from: "l", to: "result" },
        { from: "r", to: "result" },
      ],
    } as const;
    const compiled = compileWorkflow(branching);
    if (!compiled.ok) throw new Error("Fixture must compile.");
    const engine = createMemoryGraphEngine();
    const plan = await engine.materialize(compiled.value.ir);
    const offered: unknown[] = [];

    const result = await engine.execute(
      plan,
      {
        ...context([]),
        chooseBranch: async (_nodeId, _conditions, fromState) => {
          offered.push(fromState);
          return String(fromState);
        },
      },
      new Set(),
      store({ intake: { arm: "right" } }),
    );

    expect(offered).toEqual(["right"]);
    if (result.kind !== "succeeded") throw new Error("unreachable");
    expect(result.visited).toEqual(["intake", "route", "r", "result"]);
  });

  test("a judge is offered the votes it read", async () => {
    const judged = {
      id: "probe.judge-data",
      version: "1.0.0",
      nodes: [
        { id: "intake", kind: "input", schemaRef: "s@1" },
        {
          id: "panel",
          kind: "judge",
          judgeRef: "j@1",
          reads: { node: "intake", path: ["votes"] },
        },
        { id: "result", kind: "output", schemaRef: "s@1" },
      ],
      edges: [
        { from: "intake", to: "panel" },
        { from: "panel", to: "result" },
      ],
    } as const;
    const compiled = compileWorkflow(judged);
    if (!compiled.ok) throw new Error("Fixture must compile.");
    const engine = createMemoryGraphEngine();
    const plan = await engine.materialize(compiled.value.ir);
    const offered: unknown[] = [];

    await engine.execute(
      plan,
      {
        ...context([]),
        judge: async (_nodeId, _ref, fromState) => {
          offered.push(fromState);
          return "pass" as const;
        },
      },
      new Set(),
      store({ intake: { votes: { writer: "pass" } } }),
    );

    expect(offered).toEqual([{ writer: "pass" }]);
  });
});
