import { describe, expect, test } from "vitest";

import { compileWorkflow } from "./compiler.js";

const workflow = {
  id: "acme.discovery",
  version: "1.0.0",
  nodes: [
    { id: "intake", kind: "input", schemaRef: "acme.discovery.input@1" },
    { id: "result", kind: "output", schemaRef: "acme.discovery.output@1" },
  ],
  edges: [{ from: "intake", to: "result" }],
} as const;

describe("compileWorkflow", () => {
  test("produces stable sealed IR fingerprints for the same workflow", () => {
    const first = compileWorkflow(workflow);
    const second = compileWorkflow(workflow);

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    if (!first.ok || !second.ok) throw new Error("Expected valid compilation.");
    expect(first.value.fingerprint).toBe(second.value.fingerprint);
    expect(first.value.ir.nodes.map((node) => node.id)).toEqual([
      "intake",
      "result",
    ]);
  });

  test("returns a stable diagnostic for cycles without throwing", () => {
    const result = compileWorkflow({
      ...workflow,
      edges: [
        { from: "intake", to: "result" },
        { from: "result", to: "intake" },
      ],
    });

    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "WF_CYCLE" })],
    });
  });
});

const gatedWorkflow = {
  id: "acme.publish",
  version: "1.0.0",
  sideEffects: ["slack.post"],
  nodes: [
    { id: "intake", kind: "input", schemaRef: "acme.publish.input@1" },
    { id: "draft", kind: "agent", promptRef: "acme.publish.draft@1" },
    {
      id: "gate",
      kind: "approval",
      gateSchemaRef: "acme.publish.gate@1",
      gates: ["publish"],
    },
    {
      id: "publish",
      kind: "tool",
      skillRef: "slack.post@1",
      effect: "slack.post",
    },
    { id: "result", kind: "output", schemaRef: "acme.publish.output@1" },
  ],
  edges: [
    { from: "intake", to: "draft" },
    { from: "draft", to: "gate" },
    { from: "gate", to: "publish" },
    { from: "publish", to: "result" },
  ],
} as const;

describe("side-effect gating", () => {
  test("compiles when every effect sits behind an approval that names it", () => {
    const result = compileWorkflow(gatedWorkflow);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected valid compilation.");
    expect(result.value.ir.sideEffects).toEqual(["slack.post"]);
  });

  test("WF_MISSING_APPROVAL when an edge bypasses the gate", () => {
    const result = compileWorkflow({
      ...gatedWorkflow,
      edges: [...gatedWorkflow.edges, { from: "draft", to: "publish" }],
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "WF_MISSING_APPROVAL",
          path: ["nodes", "publish"],
        }),
      ],
    });
  });

  test("WF_MISSING_APPROVAL when no approval names the effect", () => {
    const result = compileWorkflow({
      ...gatedWorkflow,
      nodes: gatedWorkflow.nodes.map((node) =>
        node.kind === "approval" ? { ...node, gates: [] } : node,
      ),
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(result.diagnostics[0]?.code).toBe("WF_MISSING_APPROVAL");
    expect(result.diagnostics[0]?.message).toContain("gates");
  });

  test("an unrelated earlier approval does not authorise the effect", () => {
    const result = compileWorkflow({
      ...gatedWorkflow,
      nodes: gatedWorkflow.nodes.map((node) =>
        node.kind === "approval" ? { ...node, gates: ["result"] } : node,
      ),
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(result.diagnostics[0]?.code).toBe("WF_MISSING_APPROVAL");
  });

  test("WF_UNDECLARED_EFFECT when an effect is absent from sideEffects", () => {
    const result = compileWorkflow({ ...gatedWorkflow, sideEffects: [] });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "WF_UNDECLARED_EFFECT",
    );
  });

  test("a tool node without an effect needs no gate", () => {
    const result = compileWorkflow({
      ...gatedWorkflow,
      sideEffects: [],
      nodes: gatedWorkflow.nodes.map((node) =>
        node.kind === "tool"
          ? { id: node.id, kind: "tool", skillRef: node.skillRef }
          : node,
      ),
    });

    expect(result).toMatchObject({ ok: true });
  });

  test("declaring an effect changes the fingerprint", () => {
    const withEffect = compileWorkflow(gatedWorkflow);
    const withMore = compileWorkflow({
      ...gatedWorkflow,
      sideEffects: ["slack.post", "github.pr.open"],
    });

    if (!withEffect.ok || !withMore.ok)
      throw new Error("Expected valid compilations.");
    expect(withEffect.value.fingerprint).not.toBe(withMore.value.fingerprint);
  });
});

const branching = {
  id: "acme.triage",
  version: "1.0.0",
  nodes: [
    { id: "intake", kind: "input", schemaRef: "acme.triage.input@1" },
    {
      id: "normalise",
      kind: "transform",
      transformRef: "acme.triage.normalise@1",
    },
    { id: "isolate", kind: "sandbox", profile: "acme.triage.sandbox@1" },
    { id: "fanout", kind: "parallel", branches: ["normalise", "isolate"] },
    { id: "route", kind: "branch", conditionIds: ["urgent", "routine"] },
    { id: "fast", kind: "agent", promptRef: "acme.triage.fast@1" },
    { id: "slow", kind: "agent", promptRef: "acme.triage.slow@1" },
    { id: "result", kind: "output", schemaRef: "acme.triage.output@1" },
  ],
  edges: [
    { from: "intake", to: "fanout" },
    { from: "fanout", to: "normalise" },
    { from: "fanout", to: "isolate" },
    { from: "normalise", to: "route" },
    { from: "isolate", to: "route" },
    { from: "route", to: "fast", conditionId: "urgent" },
    { from: "route", to: "slow", conditionId: "routine" },
    { from: "fast", to: "result" },
    { from: "slow", to: "result" },
  ],
} as const;

describe("the full node taxonomy", () => {
  test("transform, parallel, sandbox and branch all compile", () => {
    const result = compileWorkflow(branching);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected valid compilation.");
    expect(result.value.ir.nodes.map((node) => node.kind).sort()).toEqual([
      "agent",
      "agent",
      "branch",
      "input",
      "output",
      "parallel",
      "sandbox",
      "transform",
    ]);
  });

  test("a policy_check node compiles and keeps its capability", () => {
    const result = compileWorkflow({
      ...branching,
      nodes: [
        ...branching.nodes,
        { id: "assert", kind: "policy_check", capability: "acme.triage.read" },
      ],
      edges: [...branching.edges, { from: "intake", to: "assert" }],
    });

    if (!result.ok) throw new Error("Expected valid compilation.");
    const node = result.value.ir.nodes.find((entry) => entry.id === "assert");
    expect(node).toEqual({
      id: "assert",
      kind: "policy_check",
      capability: "acme.triage.read",
    });
  });

  test("an unknown node kind is rejected rather than passed through", () => {
    const result = compileWorkflow({
      ...branching,
      nodes: [...branching.nodes, { id: "mystery", kind: "teleport" }],
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(result.diagnostics[0]?.code).toBe("WF_INVALID");
  });
});

describe("branch exhaustiveness", () => {
  test("WF_UNTYPED_EDGE when an arm carries no conditionId", () => {
    const result = compileWorkflow({
      ...branching,
      edges: branching.edges.map((edge) =>
        edge.from === "route" && edge.to === "fast"
          ? { from: "route", to: "fast" }
          : edge,
      ),
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(result.diagnostics[0]?.code).toBe("WF_UNTYPED_EDGE");
    expect(result.diagnostics[0]?.message).toContain("without a conditionId");
  });

  test("WF_UNTYPED_EDGE when an arm uses a condition the branch never declared", () => {
    const result = compileWorkflow({
      ...branching,
      edges: branching.edges.map((edge) =>
        edge.from === "route" && edge.to === "fast"
          ? { from: "route", to: "fast", conditionId: "invented" }
          : edge,
      ),
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected a diagnostic.");
    const codes = result.diagnostics.map((entry) => entry.code);
    expect(codes).toContain("WF_UNTYPED_EDGE");
    expect(
      result.diagnostics.some((entry) => entry.message.includes("invented")),
    ).toBe(true);
  });

  test("WF_UNTYPED_EDGE when a declared condition has no arm", () => {
    const result = compileWorkflow({
      ...branching,
      edges: branching.edges.filter(
        (edge) => !(edge.from === "route" && edge.to === "slow"),
      ),
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(
      result.diagnostics.some((entry) =>
        entry.message.includes("not exhaustive"),
      ),
    ).toBe(true);
  });

  test("an exhaustive branch with every arm labelled is accepted", () => {
    expect(compileWorkflow(branching)).toMatchObject({ ok: true });
  });
});
