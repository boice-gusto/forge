import { createHash } from "node:crypto";

import type { ForgeIr } from "@forge/ir";
import {
  type Diagnostic,
  type Role,
  type WorkflowEdge,
  type WorkflowNode,
  WorkflowSourceSchema,
} from "@forge/types";

const COMPILER_VERSION = "0.1.0";

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

function successors(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): ReadonlyMap<string, readonly string[]> {
  const outgoing = new Map<string, string[]>(
    nodes.map((node) => [node.id, [] as string[]]),
  );
  for (const edge of edges) outgoing.get(edge.from)?.push(edge.to);
  return outgoing;
}

/** Where a walk starts. Every other node must be reachable from it. */
function entryOf(nodes: readonly WorkflowNode[]): WorkflowNode | undefined {
  return nodes.find((node) => node.kind === "input") ?? nodes[0];
}

function hasCycle(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): boolean {
  const adjacency = successors(nodes, edges);

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

type ApprovalNode = Extract<WorkflowNode, { kind: "approval" }>;
type ToolNode = Extract<WorkflowNode, { kind: "tool" }>;
type BranchNode = Extract<WorkflowNode, { kind: "branch" }>;
type JudgeNode = Extract<WorkflowNode, { kind: "judge" }>;

/**
 * Capability closure (007 §12, ADR-009). A role may not require a capability
 * the policy closure never granted, nor one it forbids itself. This is what
 * makes "the designer cannot merge code" a build failure rather than a
 * convention.
 */
function checkRoles(
  nodes: readonly WorkflowNode[],
  roles: Readonly<Record<string, Role>>,
  granted: readonly string[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const closure = new Set(granted);

  for (const node of nodes) {
    if (!("role" in node) || node.role === undefined) continue;
    if (roles[node.role] === undefined) {
      diagnostics.push({
        code: "WF_UNKNOWN_ROLE",
        message: `Node "${node.id}" names role "${node.role}", which is not declared.`,
        path: ["nodes", node.id],
        suggestion: "Declare the role under roles, or correct the reference.",
      });
    }
  }

  for (const [name, role] of Object.entries(roles)) {
    const forbids = new Set(role.capabilities.forbids);
    for (const capability of role.capabilities.requires) {
      if (forbids.has(capability)) {
        diagnostics.push({
          code: "WF_CAPABILITY_UNBOUND",
          message: `Role "${name}" both requires and forbids "${capability}".`,
          path: ["roles", name, "capabilities"],
          suggestion: "A role cannot require a capability it forbids itself.",
        });
        continue;
      }
      if (!closure.has(capability)) {
        diagnostics.push({
          code: "WF_CAPABILITY_UNBOUND",
          message: `Role "${name}" requires "${capability}", which exceeds the granted closure.`,
          path: ["roles", name, "capabilities", "requires"],
          suggestion: "Remove the capability, or grant it in policy.",
        });
      }
    }
  }

  return diagnostics;
}

/**
 * A branch must be exhaustive and every arm labelled: an unlabelled arm makes
 * control flow ambiguous, an unhandled condition makes it incomplete. Both are
 * WF_UNTYPED_EDGE (007 §11).
 */
function checkBranches(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
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
 * Judge verdict routing (007 §10). A judge that declares arms owns its own
 * control flow, so the branch rule applies: every arm labelled, every declared
 * verdict routed — otherwise the graph claims a route the engine does not take.
 * A judge that declares no arms is the fail-closed default (only `pass`
 * continues), so a label on one of its edges is an arm that routes nowhere.
 */
function checkJudges(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const judges = nodes.filter(
    (node): node is JudgeNode => node.kind === "judge",
  );

  for (const judge of judges) {
    const declared = new Set<string>(judge.verdicts ?? []);
    const covered = new Set<string>();

    for (const edge of edges.filter((entry) => entry.from === judge.id)) {
      if (edge.conditionId === undefined) {
        if (declared.size === 0) continue;
        diagnostics.push({
          code: "WF_UNTYPED_EDGE",
          message: `Edge ${judge.id} -> ${edge.to} leaves a routing judge without a verdict label.`,
          path: ["edges", judge.id, edge.to],
          suggestion: "Label the arm with one of the judge's verdicts.",
        });
        continue;
      }
      if (!declared.has(edge.conditionId)) {
        diagnostics.push({
          code: "WF_UNTYPED_EDGE",
          message: `Edge ${judge.id} -> ${edge.to} is labelled "${edge.conditionId}", which judge "${judge.id}" does not declare in verdicts.`,
          path: ["edges", judge.id, edge.to],
        });
        continue;
      }
      covered.add(edge.conditionId);
    }

    const unrouted = [...declared].filter((verdict) => !covered.has(verdict));
    if (unrouted.length > 0) {
      diagnostics.push({
        code: "WF_UNTYPED_EDGE",
        message: `Judge "${judge.id}" declares verdict ${unrouted.join(", ")} with no arm.`,
        path: ["nodes", judge.id],
        suggestion:
          "Add an edge labelled with that verdict, or stop declaring it.",
      });
    }
  }

  return diagnostics;
}

/**
 * A dead node defeats the approval analysis: an effect that cannot be reached
 * at all trivially cannot be reached while bypassing its gate, so the gate
 * check passes vacuously. Refuse the shape instead of reasoning about it.
 */
function checkReachability(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): Diagnostic[] {
  const entry = entryOf(nodes);
  if (entry === undefined) return [];

  const outgoing = successors(nodes, edges);
  const seen = new Set([entry.id]);
  const queue = [entry.id];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const next of outgoing.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }

  return nodes
    .filter((node) => !seen.has(node.id))
    .map((node) => ({
      code: "WF_UNREACHABLE_NODE",
      message: `Node "${node.id}" has no path from "${entry.id}".`,
      path: ["nodes", node.id],
      suggestion:
        "Connect it with an edge, or remove it. A dead node cannot be gated.",
    }));
}

/**
 * A `reads` binding names the node whose value this one consumes. Two things
 * make it a reference the compiler can check: the source must exist, and there
 * must be a path from it to the reader. A node reading something that cannot
 * possibly have run before it is a broken reference, not a runtime surprise —
 * the runtime still fails closed on it, but a typo should not need a run to
 * find.
 *
 * Reachability, not domination: on a graph with arms, a source on one arm and a
 * reader after the join is reachable but not guaranteed, and the runtime's
 * fail-closed read is what covers that.
 */
function checkDataFlow(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): Diagnostic[] {
  const adjacency = successors(nodes, edges);
  const known = new Set(nodes.map((node) => node.id));
  const diagnostics: Diagnostic[] = [];

  for (const node of nodes) {
    if (!("reads" in node) || node.reads === undefined) continue;
    const source = node.reads.node;

    if (!known.has(source)) {
      diagnostics.push({
        code: "WF_UNKNOWN_REF",
        message: `Node "${node.id}" reads from "${source}", which is not declared.`,
        path: ["nodes", node.id, "reads"],
        suggestion: "Correct the reference, or declare the node it names.",
      });
      continue;
    }

    if (
      source === node.id ||
      !reachableAvoiding(source, node.id, adjacency, new Set())
    ) {
      diagnostics.push({
        code: "WF_UNKNOWN_REF",
        message: `Node "${node.id}" reads from "${source}", which has no path to it.`,
        path: ["nodes", node.id, "reads"],
        suggestion:
          "Read from a node upstream of this one; a value that never exists cannot be defaulted.",
      });
    }
  }

  return diagnostics;
}

/**
 * Every side effect must sit behind an approval that names it. A generic
 * approval earlier in the graph authorises nothing: the gate binds to the
 * action, exactly as the runtime binds a decision to one (006 §6.4).
 */
function checkSideEffects(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  declaredEffects: readonly string[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const declared = new Set(declaredEffects);

  const adjacency = successors(nodes, edges);
  const entry = entryOf(nodes);
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

  const reachabilityDiagnostics = checkReachability(
    parsed.data.nodes,
    parsed.data.edges,
  );
  if (reachabilityDiagnostics.length > 0)
    return { ok: false, diagnostics: reachabilityDiagnostics };

  const dataDiagnostics = checkDataFlow(parsed.data.nodes, parsed.data.edges);
  if (dataDiagnostics.length > 0)
    return { ok: false, diagnostics: dataDiagnostics };

  const roleDiagnostics = checkRoles(
    parsed.data.nodes,
    parsed.data.roles,
    parsed.data.grantedCapabilities,
  );
  if (roleDiagnostics.length > 0)
    return { ok: false, diagnostics: roleDiagnostics };

  const armDiagnostics = [
    ...checkBranches(parsed.data.nodes, parsed.data.edges),
    ...checkJudges(parsed.data.nodes, parsed.data.edges),
  ];
  if (armDiagnostics.length > 0)
    return { ok: false, diagnostics: armDiagnostics };

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
    roles: parsed.data.roles,
    grantedCapabilities: [...parsed.data.grantedCapabilities].sort(),
    nodes: [...parsed.data.nodes].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    edges: [...parsed.data.edges].sort((left, right) =>
      `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`),
    ),
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ compilerVersion: COMPILER_VERSION, ir }))
    .digest("hex");
  return {
    ok: true,
    value: { compilerVersion: COMPILER_VERSION, fingerprint, ir },
  };
}
