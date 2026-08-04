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
