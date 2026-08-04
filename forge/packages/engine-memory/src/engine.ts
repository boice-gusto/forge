import type { ForgeIr, IrNode } from "@forge/ir";
import type {
  AuthorisedEffects,
  EngineExecutionResult,
  EnginePlan,
  EngineRunContext,
  GraphEnginePort,
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
  readonly order: readonly IrNode[];
  readonly gatesFor: ReadonlyMap<string, readonly string[]>;
}

const plans = new WeakMap<object, MaterializedPlan>();

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

export function createMemoryGraphEngine(): GraphEnginePort {
  return {
    async materialize(ir: unknown): Promise<EnginePlan> {
      const typed = ir as ForgeIr;
      const token = {} as EnginePlan;
      plans.set(token as unknown as object, {
        ir: typed,
        order: topologicalOrder(typed),
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
      for (const node of materialized.order) {
        visited.push(node.id);

        if (node.kind !== "tool" || node.effect === undefined) continue;

        if (!authorised.has(node.id)) {
          return {
            kind: "interrupted",
            nodeId: node.id,
            effect: node.effect,
            gateIds: materialized.gatesFor.get(node.id) ?? [],
            visited,
          };
        }

        try {
          await context.perform(node.id, node.effect);
        } catch (error) {
          return {
            kind: "failed",
            nodeId: node.id,
            reason: error instanceof Error ? error.message : String(error),
            retryable: true,
          };
        }
      }

      return { kind: "succeeded", visited };
    },
  };
}
