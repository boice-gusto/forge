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
    // The default runs the scope, so a test that does not care about isolation
    // still walks the nodes inside one.
    withSandbox: async <T>(
      _nodeId: string,
      _profile: string,
      work: () => Promise<T>,
    ): Promise<T> => work(),
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

/**
 * A `sandbox` node is a scope, not a step. What is being proved here is that
 * the lease spans the work the graph reaches from it: before this, the engine
 * asked for a sandbox, was told it existed, and then ran everything on the
 * host anyway.
 */
describe("a sandbox node scopes what the graph reaches from it", () => {
  const isolated = {
    id: "probe.sandbox",
    version: "1.0.0",
    sideEffects: ["prod.write"],
    nodes: [
      { id: "intake", kind: "input", schemaRef: "s@1" },
      { id: "isolate", kind: "sandbox", profile: "docker" },
      { id: "work", kind: "agent", promptRef: "p@1" },
      { id: "gate", kind: "approval", gateSchemaRef: "g@1", gates: ["act"] },
      { id: "act", kind: "tool", skillRef: "t@1", effect: "prod.write" },
      { id: "result", kind: "output", schemaRef: "s@1" },
    ],
    edges: [
      { from: "intake", to: "isolate" },
      { from: "isolate", to: "work" },
      { from: "work", to: "gate" },
      { from: "gate", to: "act" },
      { from: "act", to: "result" },
    ],
  } as const;

  /**
   * Records what happened and, for each node, whether a lease was open at the
   * time. "Ran inside the sandbox" is not observable any other way from here.
   */
  function tracing(options: { readonly provision?: () => void } = {}) {
    const log: string[] = [];
    let open = 0;
    return {
      log,
      hooks: {
        ...context([]),
        withSandbox: async <T>(
          nodeId: string,
          profile: string,
          work: () => Promise<T>,
        ): Promise<T> => {
          options.provision?.();
          log.push(`enter ${nodeId} ${profile}`);
          open += 1;
          try {
            return await work();
          } finally {
            open -= 1;
            log.push(`release ${nodeId}`);
          }
        },
        invokeAgent: async (nodeId: string) => {
          log.push(`agent ${nodeId} inside=${open > 0}`);
        },
        perform: async (nodeId: string) => {
          log.push(`perform ${nodeId} inside=${open > 0}`);
        },
        emitOutput: async (nodeId: string) => {
          log.push(`output ${nodeId} inside=${open > 0}`);
        },
      },
    };
  }

  async function execute(source: unknown, trace: ReturnType<typeof tracing>) {
    const compiled = compileWorkflow(source);
    if (!compiled.ok) throw new Error("Fixture must compile.");
    const engine = createMemoryGraphEngine();
    const plan = await engine.materialize(compiled.value.ir);
    return engine.execute(plan, trace.hooks, new Set(["act"]), store());
  }

  test("the downstream nodes run inside the lease, and it closes after them", async () => {
    const trace = tracing();

    const result = await execute(isolated, trace);

    expect(result.kind).toBe("succeeded");
    expect(trace.log).toEqual([
      "enter isolate docker",
      "agent work inside=true",
      "perform act inside=true",
      "release isolate",
    ]);
  });

  test("a node the sandbox does not reach runs outside it", async () => {
    // `sibling` is not downstream of `isolate`, so it never declared isolation
    // and must not silently acquire it. Its id sorts after `isolate` on
    // purpose: the topological order therefore offers it *after* the sandbox
    // node, which is the only arrangement in which the scope has to be
    // partitioned rather than simply followed.
    const trace = tracing();

    const result = await execute(
      {
        ...isolated,
        id: "probe.sandbox-sibling",
        nodes: [
          ...isolated.nodes,
          { id: "sibling", kind: "agent", promptRef: "p@2" },
        ],
        edges: [
          ...isolated.edges,
          { from: "intake", to: "sibling" },
          { from: "sibling", to: "result" },
        ],
      },
      trace,
    );

    expect(result.kind).toBe("succeeded");
    expect(trace.log).toContain("agent sibling inside=false");
    // Scheduled before the lease opens, so the environment is held for the
    // scope that asked for it and no longer.
    expect(trace.log.indexOf("agent sibling inside=false")).toBeLessThan(
      trace.log.indexOf("enter isolate docker"),
    );
    expect(trace.log).toContain("agent work inside=true");
  });

  test("a sandbox that cannot be provisioned stops the walk, and nothing downstream runs", async () => {
    const trace = tracing({
      provision: () => {
        throw new Error("no container runtime is reachable");
      },
    });

    const result = await execute(isolated, trace);

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("unreachable");
    expect(result.nodeId).toBe("isolate");
    expect(result.reason).toContain("no container runtime is reachable");
    // Not retryable: a host that cannot isolate will not isolate on a retry,
    // and the walk must never continue un-isolated.
    expect(result.retryable).toBe(false);
    expect(trace.log).toEqual([]);
  });

  test("an interrupt inside the scope releases the lease before it is reported", async () => {
    const trace = tracing();
    const compiled = compileWorkflow(isolated);
    if (!compiled.ok) throw new Error("Fixture must compile.");
    const engine = createMemoryGraphEngine();
    const plan = await engine.materialize(compiled.value.ir);

    // Nothing authorised: the walk stops at the gated effect.
    const result = await engine.execute(plan, trace.hooks, new Set(), store());

    expect(result.kind).toBe("interrupted");
    if (result.kind !== "interrupted") throw new Error("unreachable");
    expect(result.nodeId).toBe("act");
    // A lease must not be held across a decision that may take days.
    expect(trace.log.at(-1)).toBe("release isolate");
    expect(trace.log).not.toContain("perform act inside=true");
  });
});
