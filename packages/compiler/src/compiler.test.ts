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
