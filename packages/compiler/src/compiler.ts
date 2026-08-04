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

/** Can `target` be reached from `from` without entering any blocked node? */
function reachableAvoiding(
  from: string,
  target: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  blocked: ReadonlySet<string>,
): boolean {
  if (blocked.has(from)) return false;
  const seen = new Set([from]);
  const queue: string[] = [from];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (id === target) return true;
    for (const next of adjacency.get(id) ?? []) {
      if (seen.has(next) || blocked.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

type ApprovalNode = Extract<IrNode, { kind: "approval" }>;
type ToolNode = Extract<IrNode, { kind: "tool" }>;
type BranchNode = Extract<IrNode, { kind: "branch" }>;

/**
 * A branch must be exhaustive and every arm must be labelled. An unlabelled
 * arm makes control flow ambiguous; an unhandled condition makes it
 * incomplete. Both are WF_UNTYPED_EDGE (007 §11).
 */
function checkBranches(
  nodes: readonly IrNode[],
  edges: readonly IrEdge[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const branches = nodes.filter(
    (node): node is BranchNode => node.kind === "branch",
  );

  for (const branch of branches) {
    const outgoing = edges.filter((edge) => edge.from === branch.id);
    const declared = new Set(branch.conditionIds);
    const covered = new Set<string>();

    for (const edge of outgoing) {
      if (edge.conditionId === undefined) {
        diagnostics.push({
          code: "WF_UNTYPED_EDGE",
          message: `Edge ${branch.id} -> ${edge.to} leaves a branch without a conditionId.`,
          path: ["edges", branch.id, edge.to],
        });
        continue;
      }
      if (!declared.has(edge.conditionId)) {
        diagnostics.push({
          code: "WF_UNTYPED_EDGE",
          message: `Edge ${branch.id} -> ${edge.to} uses conditionId "${edge.conditionId}", which the branch does not declare.`,
          path: ["edges", branch.id, edge.to],
        });
        continue;
      }
      covered.add(edge.conditionId);
    }

    const unhandled = [...declared].filter((id) => !covered.has(id));
    if (unhandled.length > 0) {
      diagnostics.push({
        code: "WF_UNTYPED_EDGE",
        message: `Branch "${branch.id}" is not exhaustive; no edge handles ${unhandled.join(", ")}.`,
        path: ["nodes", branch.id],
      });
    }
  }

  return diagnostics;
}

/**
 * Every side effect must sit behind an approval that names it.
 *
 * A generic approval earlier in the graph does not authorise an unrelated
 * effect later — the gate binds to the action, exactly as the runtime binds a
 * decision to a run and an argument hash (006 §6.4).
 */
function checkSideEffects(
  nodes: readonly IrNode[],
  edges: readonly IrEdge[],
  declaredEffects: readonly string[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const declared = new Set(declaredEffects);

  const adjacency = new Map<string, string[]>(
    nodes.map((node) => [node.id, [] as string[]]),
  );
  for (const edge of edges) adjacency.get(edge.from)?.push(edge.to);

  const entry = nodes.find((node) => node.kind === "input") ?? nodes[0];
  const approvals = nodes.filter(
    (node): node is ApprovalNode => node.kind === "approval",
  );
  const effects = nodes.filter(
    (node): node is ToolNode =>
      node.kind === "tool" && node.effect !== undefined,
  );

  for (const node of effects) {
    const effect = node.effect as string;
    if (!declared.has(effect)) {
      diagnostics.push({
        code: "WF_UNDECLARED_EFFECT",
        message: `Effect "${effect}" is not listed in sideEffects.`,
        path: ["nodes", node.id],
      });
    }

    const gates = approvals.filter((approval) =>
      approval.gates.includes(node.id),
    );
    if (gates.length === 0) {
      diagnostics.push({
        code: "WF_MISSING_APPROVAL",
        message: `No approval node declares "${node.id}" in its gates.`,
        path: ["nodes", node.id],
      });
      continue;
    }

    const gateIds = new Set(gates.map((gate) => gate.id));
    if (
      entry !== undefined &&
      reachableAvoiding(entry.id, node.id, adjacency, gateIds)
    ) {
      diagnostics.push({
        code: "WF_MISSING_APPROVAL",
        message: `A path reaches side effect "${node.id}" without passing its approval gate.`,
        path: ["nodes", node.id],
      });
    }
  }

  return diagnostics;
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

  const branchDiagnostics = checkBranches(parsed.data.nodes, parsed.data.edges);
  if (branchDiagnostics.length > 0)
    return { ok: false, diagnostics: branchDiagnostics };

  const effectDiagnostics = checkSideEffects(
    parsed.data.nodes,
    parsed.data.edges,
    parsed.data.sideEffects,
  );
  if (effectDiagnostics.length > 0)
    return { ok: false, diagnostics: effectDiagnostics };

  const ir: ForgeIr = {
    workflowId: parsed.data.id,
    workflowVersion: parsed.data.version,
    sideEffects: [...parsed.data.sideEffects].sort(),
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
