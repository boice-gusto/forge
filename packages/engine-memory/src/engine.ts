import type { ForgeIr, IrEdge, IrNode } from "@forge/ir";
import type {
  AuthorisedEffects,
  EngineExecutionResult,
  EnginePlan,
  EngineRunContext,
  GraphEnginePort,
  JudgeVerdict,
} from "@forge/ports";

/**
 * In-memory graph engine.
 *
 * Deliberately not LangGraph. ADR-002 puts a vendor engine behind
 * `GraphEnginePort`; this adapter exists so the runtime can be built and
 * proven against the port before that adapter lands, and so the conformance
 * expectations are written down as executable tests rather than prose.
 *
 * Execution is a topological walk from the input node. When it reaches a
 * side-effect node the runtime has not authorised, it stops and reports an
 * interrupt — it never performs the effect speculatively.
 */

interface MaterializedPlan {
  readonly ir: ForgeIr;
  readonly entryId: string;
  readonly order: readonly IrNode[];
  readonly gatesFor: ReadonlyMap<string, readonly string[]>;
}

const plans = new WeakMap<object, MaterializedPlan>();

/** Two arms can share a target, so identity is the whole edge. */
const edgeKey = (edge: IrEdge): string =>
  JSON.stringify([edge.from, edge.to, edge.conditionId ?? null]);

/** Nodes reachable from the entry node, following edges no verdict pruned. */
function reachableFrom(
  ir: ForgeIr,
  entryId: string,
  pruned: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const outgoing = new Map<string, string[]>(
    ir.nodes.map((node) => [node.id, [] as string[]]),
  );
  for (const edge of ir.edges) {
    if (pruned.has(edgeKey(edge))) continue;
    outgoing.get(edge.from)?.push(edge.to);
  }

  const seen = new Set([entryId]);
  const queue = [entryId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const next of outgoing.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function topologicalOrder(ir: ForgeIr): readonly IrNode[] {
  const byId = new Map(ir.nodes.map((node) => [node.id, node]));
  const indegree = new Map(ir.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>(
    ir.nodes.map((node) => [node.id, [] as string[]]),
  );
  for (const edge of ir.edges) {
    outgoing.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  // Ties break on node id so the order is deterministic for a given IR.
  const ready = ir.nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id)
    .sort();
  const order: IrNode[] = [];

  while (ready.length > 0) {
    const id = ready.shift() as string;
    const node = byId.get(id);
    if (node !== undefined) order.push(node);
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }

  return order;
}

function gateIndex(ir: ForgeIr): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();
  for (const node of ir.nodes) {
    if (node.kind !== "approval") continue;
    for (const gated of node.gates) {
      const existing = index.get(gated) ?? [];
      existing.push(node.id);
      index.set(gated, existing);
    }
  }
  return index;
}

type StepOutcome =
  | "continue"
  /** A judge took a declared arm; the arms it did not take are now dead. */
  | {
      readonly kind: "routed";
      readonly nodeId: string;
      readonly verdict: JudgeVerdict;
    }
  | Extract<EngineExecutionResult, { kind: "failed" }>
  | Omit<Extract<EngineExecutionResult, { kind: "interrupted" }>, "visited">;

const failed = (
  nodeId: string,
  reason: string,
  retryable: boolean,
): StepOutcome => ({ kind: "failed", nodeId, reason, retryable });

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Verdict routing (007 §10). A workflow may handle its own review outcomes by
 * declaring an arm per verdict. What it may not do is continue on a verdict it
 * declared no arm for: with no arm the run stops, so a `review` never arrives
 * on the `pass` path. A judge that declares no arms keeps the older, narrower
 * rule — only `pass` continues.
 */
async function judgeStep(
  node: Extract<IrNode, { kind: "judge" }>,
  context: EngineRunContext,
): Promise<StepOutcome> {
  try {
    const verdict = await context.judge(node.id, node.judgeRef);
    if (node.verdicts === undefined) {
      return verdict === "pass"
        ? "continue"
        : failed(node.id, `judge verdict ${verdict}`, false);
    }
    return node.verdicts.includes(verdict)
      ? { kind: "routed", nodeId: node.id, verdict }
      : failed(node.id, `judge verdict ${verdict} has no arm`, false);
  } catch (error) {
    // A judge that errors escalates; it never passes.
    return failed(node.id, `judge errored: ${messageOf(error)}`, false);
  }
}

/**
 * One node, one outcome. Each kind owns its failure semantics: an agent may be
 * retried, a judge or a sandbox may not, and an unauthorised effect interrupts
 * rather than failing.
 */
async function step(
  node: IrNode,
  context: EngineRunContext,
  authorised: AuthorisedEffects,
  materialized: MaterializedPlan,
): Promise<StepOutcome> {
  switch (node.kind) {
    case "agent":
      try {
        await context.invokeAgent(node.id, node.promptRef, node.role);
        return "continue";
      } catch (error) {
        return failed(node.id, messageOf(error), true);
      }

    case "judge":
      return judgeStep(node, context);

    case "sandbox":
      try {
        await context.enterSandbox(node.id, node.profile);
        return "continue";
      } catch (error) {
        // No host fallback. An unavailable sandbox stops the walk.
        return failed(node.id, messageOf(error), false);
      }

    case "policy_check":
      try {
        await context.assertCapability(node.id, node.capability);
        return "continue";
      } catch (error) {
        return failed(node.id, messageOf(error), false);
      }

    case "tool": {
      if (node.effect === undefined) return "continue";
      if (!authorised.has(node.id)) {
        return {
          kind: "interrupted",
          nodeId: node.id,
          effect: node.effect,
          gateIds: materialized.gatesFor.get(node.id) ?? [],
        };
      }
      try {
        await context.perform(node.id, node.effect);
        return "continue";
      } catch (error) {
        return failed(node.id, messageOf(error), true);
      }
    }

    default:
      return "continue";
  }
}

/**
 * Kill every arm out of `nodeId` the verdict did not take. An unlabelled arm
 * out of a routing judge is one of them — the compiler refuses that shape, and
 * the engine must not walk it if a hand-built IR carries it anyway.
 */
function pruneArms(
  ir: ForgeIr,
  nodeId: string,
  verdict: JudgeVerdict,
  pruned: Set<string>,
): void {
  for (const edge of ir.edges) {
    if (edge.from !== nodeId || edge.conditionId === verdict) continue;
    pruned.add(edgeKey(edge));
  }
}

export function createMemoryGraphEngine(): GraphEnginePort {
  return {
    async materialize(ir: unknown): Promise<EnginePlan> {
      const typed = ir as ForgeIr;
      // Execution follows edges. A node with no path from the entry node is
      // not "later in the order" — it is not part of this workflow's
      // execution at all, and running it would let graph shape decide what
      // happens instead of the graph.
      const entry =
        typed.nodes.find((node) => node.kind === "input") ?? typed.nodes[0];
      const reachable =
        entry === undefined
          ? new Set<string>()
          : reachableFrom(typed, entry.id);

      const token = {} as EnginePlan;
      plans.set(token as unknown as object, {
        ir: typed,
        entryId: entry?.id ?? "",
        order: topologicalOrder(typed).filter((node) => reachable.has(node.id)),
        gatesFor: gateIndex(typed),
      });
      return token;
    },

    async execute(
      plan: EnginePlan,
      context: EngineRunContext,
      authorised: AuthorisedEffects,
    ): Promise<EngineExecutionResult> {
      const materialized = plans.get(plan as unknown as object);
      if (materialized === undefined) {
        return {
          kind: "failed",
          nodeId: "",
          reason: "Plan was not produced by this engine.",
          retryable: false,
        };
      }

      const visited: string[] = [];
      const pruned = new Set<string>();
      let live = reachableFrom(materialized.ir, materialized.entryId);

      for (const node of materialized.order) {
        // An arm a judge did not take is not "skipped": it is no longer part
        // of this run, exactly like a node the graph never reaches.
        if (!live.has(node.id)) continue;
        visited.push(node.id);
        const outcome = await step(node, context, authorised, materialized);
        if (outcome === "continue") continue;
        if (outcome.kind === "routed") {
          pruneArms(materialized.ir, outcome.nodeId, outcome.verdict, pruned);
          live = reachableFrom(materialized.ir, materialized.entryId, pruned);
          continue;
        }
        // `failed` carries no visited list in the port contract; `interrupted` does.
        return outcome.kind === "failed" ? outcome : { ...outcome, visited };
      }

      return { kind: "succeeded", visited };
    },
  };
}
