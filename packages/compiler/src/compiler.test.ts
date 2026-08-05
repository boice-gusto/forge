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
    // Declare a third condition without adding an arm for it. Deleting an
    // existing arm would also orphan its target, which is a different defect.
    const result = compileWorkflow({
      ...branching,
      nodes: branching.nodes.map((node) =>
        node.id === "route"
          ? {
              id: "route",
              kind: "branch",
              conditionIds: ["urgent", "routine", "escalate"],
            }
          : node,
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

const judged = {
  id: "acme.judged",
  version: "1.0.0",
  nodes: [
    { id: "intake", kind: "input", schemaRef: "acme.judged.input@1" },
    {
      id: "panel",
      kind: "judge",
      judgeRef: "acme.judged.review@1",
      verdicts: ["pass", "review"],
    },
    { id: "escalate", kind: "agent", promptRef: "acme.judged.escalate@1" },
    { id: "result", kind: "output", schemaRef: "acme.judged.output@1" },
  ],
  edges: [
    { from: "intake", to: "panel" },
    { from: "panel", to: "result", conditionId: "pass" },
    { from: "panel", to: "escalate", conditionId: "review" },
    { from: "escalate", to: "result" },
  ],
} as const;

describe("judge verdict routing", () => {
  test("a judge with every declared verdict routed compiles and seals its arms", () => {
    const result = compileWorkflow(judged);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected valid compilation.");
    const node = result.value.ir.nodes.find((entry) => entry.id === "panel");
    expect(node).toMatchObject({ verdicts: ["pass", "review"] });
  });

  test("WF_UNTYPED_EDGE when an arm out of a routing judge is unlabelled", () => {
    const result = compileWorkflow({
      ...judged,
      edges: judged.edges.map((edge) =>
        edge.to === "escalate" ? { from: "panel", to: "escalate" } : edge,
      ),
    });

    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(result.diagnostics[0]?.code).toBe("WF_UNTYPED_EDGE");
    expect(result.diagnostics[0]?.message).toContain("without a verdict label");
  });

  test("WF_UNTYPED_EDGE when an arm claims a verdict the judge never declared", () => {
    const result = compileWorkflow({
      ...judged,
      edges: judged.edges.map((edge) =>
        edge.to === "escalate"
          ? { from: "panel", to: "escalate", conditionId: "fail" }
          : edge,
      ),
    });

    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(result.diagnostics[0]?.code).toBe("WF_UNTYPED_EDGE");
    expect(result.diagnostics[0]?.message).toContain("does not declare");
  });

  test("WF_UNTYPED_EDGE when a declared verdict has no arm at all", () => {
    const result = compileWorkflow({
      ...judged,
      nodes: judged.nodes.map((node) =>
        node.id === "panel"
          ? { ...node, verdicts: ["pass", "review", "fail"] }
          : node,
      ),
    });

    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(result.diagnostics[0]?.code).toBe("WF_UNTYPED_EDGE");
    expect(result.diagnostics[0]?.message).toContain("fail");
    expect(result.diagnostics[0]?.path).toEqual(["nodes", "panel"]);
  });

  test("a label on a judge that declares no arms routes nowhere, and is refused", () => {
    // The engine would ignore the label and fail closed on anything but pass,
    // so the graph would be claiming a route that does not exist.
    const result = compileWorkflow({
      ...judged,
      nodes: judged.nodes.map((node) =>
        node.id === "panel"
          ? { id: "panel", kind: "judge", judgeRef: "acme.judged.review@1" }
          : node,
      ),
    });

    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(result.diagnostics[0]?.code).toBe("WF_UNTYPED_EDGE");
  });

  test("a judge that declares no arms and labels none is the fail-closed default", () => {
    const result = compileWorkflow({
      ...judged,
      nodes: judged.nodes.map((node) =>
        node.id === "panel"
          ? { id: "panel", kind: "judge", judgeRef: "acme.judged.review@1" }
          : node,
      ),
      edges: [
        { from: "intake", to: "panel" },
        { from: "panel", to: "escalate" },
        { from: "escalate", to: "result" },
      ],
    });

    expect(result).toMatchObject({ ok: true });
  });

  test("a verdict outside pass, fail and review is not a verdict", () => {
    const result = compileWorkflow({
      ...judged,
      nodes: judged.nodes.map((node) =>
        node.id === "panel" ? { ...node, verdicts: ["maybe"] } : node,
      ),
    });

    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(result.diagnostics[0]?.code).toBe("WF_INVALID");
  });
});

const withRoles = {
  id: "acme.review",
  version: "1.0.0",
  grantedCapabilities: ["repo.read", "docs.write"],
  roles: {
    architect: {
      version: "1.0.0",
      capabilities: {
        requires: ["repo.read", "docs.write"],
        forbids: ["repo.merge"],
      },
      review: { weight: 1.5, blocking: false },
    },
    "security-reviewer": {
      version: "1.0.0",
      capabilities: { requires: ["repo.read"], forbids: ["repo.merge"] },
      review: { weight: 2, blocking: true },
      summon: { anyPathMatches: ["**/namedCredentials/**"] },
    },
  },
  nodes: [
    { id: "intake", kind: "input", schemaRef: "acme.review.input@1" },
    {
      id: "design",
      kind: "agent",
      promptRef: "acme.review.design@1",
      role: "architect",
    },
    { id: "result", kind: "output", schemaRef: "acme.review.output@1" },
  ],
  edges: [
    { from: "intake", to: "design" },
    { from: "design", to: "result" },
  ],
} as const;

describe("roles and capability closure", () => {
  test("a roster within the closure compiles and is sealed into the IR", () => {
    const result = compileWorkflow(withRoles);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected valid compilation.");
    expect(Object.keys(result.value.ir.roles).sort()).toEqual([
      "architect",
      "security-reviewer",
    ]);
    expect(result.value.ir.grantedCapabilities).toEqual([
      "docs.write",
      "repo.read",
    ]);
    expect(result.value.ir.roles.architect?.review?.weight).toBe(1.5);
    expect(
      result.value.ir.roles["security-reviewer"]?.summon?.anyPathMatches,
    ).toEqual(["**/namedCredentials/**"]);
  });

  test("WF_CAPABILITY_UNBOUND when a role exceeds the granted closure", () => {
    const result = compileWorkflow({
      ...withRoles,
      roles: {
        ...withRoles.roles,
        builder: {
          version: "1.0.0",
          capabilities: { requires: ["repo.read", "prod.write"], forbids: [] },
        },
      },
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected a diagnostic.");
    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === "WF_CAPABILITY_UNBOUND",
    );
    expect(diagnostic?.message).toContain("prod.write");
    expect(diagnostic?.message).toContain("exceeds the granted closure");
  });

  test("WF_CAPABILITY_UNBOUND when a role requires what it forbids", () => {
    const result = compileWorkflow({
      ...withRoles,
      roles: {
        architect: {
          version: "1.0.0",
          capabilities: {
            requires: ["repo.read", "repo.merge"],
            forbids: ["repo.merge"],
          },
        },
      },
    });

    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(result.diagnostics[0]?.message).toContain(
      "both requires and forbids",
    );
  });

  test("a designer cannot hold merge rights — it is a build failure, not a convention", () => {
    const result = compileWorkflow({
      ...withRoles,
      roles: {
        designer: {
          version: "1.0.0",
          capabilities: { requires: ["repo.merge"], forbids: [] },
        },
      },
      nodes: withRoles.nodes.map((node) =>
        node.id === "design" ? { ...node, role: "designer" } : node,
      ),
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(result.diagnostics[0]?.code).toBe("WF_CAPABILITY_UNBOUND");
  });

  test("WF_UNKNOWN_ROLE when a node names a role that is not declared", () => {
    const result = compileWorkflow({
      ...withRoles,
      nodes: withRoles.nodes.map((node) =>
        node.id === "design" ? { ...node, role: "phantom" } : node,
      ),
    });

    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(result.diagnostics[0]?.code).toBe("WF_UNKNOWN_ROLE");
    expect(result.diagnostics[0]?.message).toContain("phantom");
  });

  test("changing a role moves the fingerprint", () => {
    const base = compileWorkflow(withRoles);
    const bumped = compileWorkflow({
      ...withRoles,
      roles: {
        ...withRoles.roles,
        architect: { ...withRoles.roles.architect, version: "1.0.1" },
      },
    });

    if (!base.ok || !bumped.ok) throw new Error("Expected valid compilations.");
    expect(base.value.fingerprint).not.toBe(bumped.value.fingerprint);
  });

  test("a workflow with no roles still compiles", () => {
    const result = compileWorkflow(branching);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected valid compilation.");
    expect(result.value.ir.roles).toEqual({});
  });
});

describe("reachability", () => {
  test("WF_UNREACHABLE_NODE — a dead node cannot be gated, so it is refused", () => {
    const result = compileWorkflow({
      id: "acme.orphan",
      version: "1.0.0",
      sideEffects: ["prod.write"],
      nodes: [
        { id: "intake", kind: "input", schemaRef: "s@1" },
        { id: "result", kind: "output", schemaRef: "s@1" },
        {
          id: "gate",
          kind: "approval",
          gateSchemaRef: "g@1",
          gates: ["orphan"],
        },
        { id: "orphan", kind: "tool", skillRef: "t@1", effect: "prod.write" },
      ],
      edges: [
        { from: "intake", to: "result" },
        { from: "gate", to: "orphan" },
      ],
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected a diagnostic.");
    const codes = result.diagnostics.map((entry) => entry.code);
    expect(codes).toContain("WF_UNREACHABLE_NODE");
    // Both the gate and the orphan are unreachable from intake.
    expect(result.diagnostics.map((entry) => entry.path[1]).sort()).toEqual([
      "gate",
      "orphan",
    ]);
  });

  test("an orphaned effect cannot hide behind a vacuous approval check", () => {
    // WF_MISSING_APPROVAL asks whether an effect is reachable while bypassing
    // its gate. For an unreachable node that is trivially false, so the gate
    // check alone would pass. Reachability has to be checked first.
    const result = compileWorkflow({
      id: "acme.vacuous",
      version: "1.0.0",
      sideEffects: ["prod.write"],
      nodes: [
        { id: "intake", kind: "input", schemaRef: "s@1" },
        { id: "result", kind: "output", schemaRef: "s@1" },
        { id: "sneaky", kind: "tool", skillRef: "t@1", effect: "prod.write" },
      ],
      edges: [{ from: "intake", to: "result" }],
    });

    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(result.diagnostics[0]?.code).toBe("WF_UNREACHABLE_NODE");
  });

  test("a fully connected workflow reports no reachability diagnostic", () => {
    const result = compileWorkflow(gatedWorkflow);
    expect(result).toMatchObject({ ok: true });
  });
});

describe("data flow", () => {
  const flowing = {
    id: "acme.flow",
    version: "1.0.0",
    nodes: [
      { id: "intake", kind: "input", schemaRef: "s@1" },
      {
        id: "shape",
        kind: "transform",
        transformRef: "t@1",
        reads: { node: "intake" },
      },
      {
        id: "result",
        kind: "output",
        schemaRef: "s@1",
        reads: { node: "shape", path: ["body"] },
      },
    ],
    edges: [
      { from: "intake", to: "shape" },
      { from: "shape", to: "result" },
    ],
  } as const;

  test("a read of an upstream node compiles, and the ref survives into the IR", () => {
    const result = compileWorkflow(flowing);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected a valid compilation.");
    const output = result.value.ir.nodes.find((node) => node.id === "result");
    expect(output).toMatchObject({ reads: { node: "shape", path: ["body"] } });
  });

  test("a read with no path defaults to the whole value, not to nothing", () => {
    const result = compileWorkflow(flowing);
    if (!result.ok) throw new Error("Expected a valid compilation.");
    const shape = result.value.ir.nodes.find((node) => node.id === "shape");
    expect(shape).toMatchObject({ reads: { node: "intake", path: [] } });
  });

  test("WF_UNKNOWN_REF — reading a node that was never declared", () => {
    const result = compileWorkflow({
      ...flowing,
      nodes: flowing.nodes.map((node) =>
        node.id === "shape" ? { ...node, reads: { node: "ghost" } } : node,
      ),
    });

    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(result.diagnostics[0]?.code).toBe("WF_UNKNOWN_REF");
    expect(result.diagnostics[0]?.message).toContain("ghost");
    expect(result.diagnostics[0]?.path).toEqual(["nodes", "shape", "reads"]);
  });

  test("WF_UNKNOWN_REF — reading a node with no path to this one", () => {
    // `result` runs after `shape`, so `shape` reading `result` names a value
    // that cannot exist yet. Refused rather than left to fail at runtime.
    const result = compileWorkflow({
      ...flowing,
      nodes: flowing.nodes.map((node) =>
        node.id === "shape" ? { ...node, reads: { node: "result" } } : node,
      ),
    });

    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(result.diagnostics[0]?.code).toBe("WF_UNKNOWN_REF");
    expect(result.diagnostics[0]?.message).toContain("no path to it");
  });

  test("WF_UNKNOWN_REF — a node cannot read itself", () => {
    const result = compileWorkflow({
      ...flowing,
      nodes: flowing.nodes.map((node) =>
        node.id === "shape" ? { ...node, reads: { node: "shape" } } : node,
      ),
    });

    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(result.diagnostics[0]?.code).toBe("WF_UNKNOWN_REF");
  });

  test("a read on a node kind that has no input is not even schema-valid", () => {
    const result = compileWorkflow({
      ...flowing,
      nodes: [
        { id: "intake", kind: "input", schemaRef: "s@1", reads: {} },
        { id: "result", kind: "output", schemaRef: "s@1" },
      ],
      edges: [{ from: "intake", to: "result" }],
    });

    if (result.ok) throw new Error("Expected a diagnostic.");
    expect(result.diagnostics[0]?.code).toBe("WF_INVALID");
  });

  test("an arm-crossing read compiles, because the runtime is what fails closed", () => {
    // `late` is reachable from `early`, but only on one arm. The compiler
    // cannot prove the arm is taken; the runtime refuses the read when it is
    // not. Stating it here so the division of labour is deliberate.
    const result = compileWorkflow({
      id: "acme.arms",
      version: "1.0.0",
      nodes: [
        { id: "intake", kind: "input", schemaRef: "s@1" },
        { id: "route", kind: "branch", conditionIds: ["a", "b"] },
        { id: "early", kind: "transform", transformRef: "t@1" },
        { id: "other", kind: "transform", transformRef: "t@2" },
        {
          id: "late",
          kind: "output",
          schemaRef: "s@1",
          reads: { node: "early" },
        },
      ],
      edges: [
        { from: "intake", to: "route" },
        { from: "route", to: "early", conditionId: "a" },
        { from: "route", to: "other", conditionId: "b" },
        { from: "early", to: "late" },
        { from: "other", to: "late" },
      ],
    });

    expect(result).toMatchObject({ ok: true });
  });
});
