import { createHash } from "node:crypto";

import {
  type ForgeIr,
  type IrEdge,
  type IrNode,
  WorkflowSourceSchema,
} from "@forge/ir";
import type { Diagnostic } from "@forge/types";

const COMPILER_VERSION = "0.1.0";
const SHA256 = "sha256";

export type WorkflowCompilation =
  | { readonly ok: true; readonly value: CompiledWorkflow }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export interface CompiledWorkflow {
  readonly compilerVersion: string;
  readonly fingerprint: string;
  readonly ir: ForgeIr;
}

function diagnostic(
  code: string,
  message: string,
  path: readonly string[],
): WorkflowCompilation {
  return { ok: false, diagnostics: [{ code, message, path }] };
}

function hasCycle(nodes: readonly IrNode[], edges: readonly IrEdge[]): boolean {
  const adjacency = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) adjacency.get(edge.from)?.push(edge.to);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cycle = (adjacency.get(id) ?? []).some(visit);
    visiting.delete(id);
    visited.add(id);
    return cycle;
  };
  return nodes.some((node) => visit(node.id));
}

export function compileWorkflow(source: unknown): WorkflowCompilation {
  const parsed = WorkflowSourceSchema.safeParse(source);
  if (!parsed.success)
    return diagnostic("WF_INVALID", "Workflow source is invalid.", []);

  const ids = parsed.data.nodes.map((node) => node.id);
  if (new Set(ids).size !== ids.length)
    return diagnostic("WF_DUPLICATE_NODE", "Node IDs must be unique.", [
      "nodes",
    ]);
  const knownIds = new Set(ids);
  if (
    parsed.data.edges.some(
      (edge) => !knownIds.has(edge.from) || !knownIds.has(edge.to),
    )
  ) {
    return diagnostic(
      "WF_UNKNOWN_REF",
      "Every edge must reference declared nodes.",
      ["edges"],
    );
  }
  if (hasCycle(parsed.data.nodes, parsed.data.edges)) {
    return diagnostic("WF_CYCLE", "Workflow graph must be acyclic.", ["edges"]);
  }

  const ir: ForgeIr = {
    workflowId: parsed.data.id,
    workflowVersion: parsed.data.version,
    nodes: [...parsed.data.nodes].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    edges: [...parsed.data.edges].sort((left, right) =>
      `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`),
    ),
  };
  const fingerprint = createHash(SHA256)
    .update(JSON.stringify({ compilerVersion: COMPILER_VERSION, ir }))
    .digest("hex");
  return {
    ok: true,
    value: { compilerVersion: COMPILER_VERSION, fingerprint, ir },
  };
}
