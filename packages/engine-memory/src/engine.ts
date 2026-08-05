import type { DataRef, ForgeIr, IrEdge, IrNode } from "@forge/ir";
import type {
  AuthorisedEffects,
  EngineExecutionResult,
  EnginePlan,
  EngineRunContext,
  GraphEnginePort,
  JsonValue,
  RunValues,
} from "@forge/ports";

/**
 * In-memory graph engine. Deliberately not LangGraph: ADR-002 puts a vendor
 * engine behind `GraphEnginePort`, and this adapter lets the runtime be built
 * and proven against the port before that one lands.
 *
 * Execution is a topological walk from the input node. Reaching a side-effect
 * node the runtime has not authorised stops the walk and reports an interrupt;
 * the effect is never performed speculatively.
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
  /** A node took one declared arm; the arms it did not take are now dead. */
  | { readonly kind: "routed"; readonly nodeId: string; readonly arm: string }
  | Extract<EngineExecutionResult, { kind: "failed" }>
  | Omit<Extract<EngineExecutionResult, { kind: "interrupted" }>, "visited">;

const failed = (
  nodeId: string,
  reason: string,
  retryable: boolean,
): Extract<EngineExecutionResult, { kind: "failed" }> => ({
  kind: "failed",
  nodeId,
  reason,
  retryable,
});

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * What a node reads, or `undefined` when it declared nothing. Throws when the
 * value is missing: `RunValues.read` fails closed, and every caller here is
 * inside a `try` that turns that into a stopped run.
 */
function inputFor(
  reads: DataRef | undefined,
  values: RunValues,
): JsonValue | undefined {
  return reads === undefined ? undefined : values.read(reads.node, reads.path);
}

/**
 * Verdict routing (007 §10). A verdict with no declared arm stops the run, so a
 * `review` never arrives on the `pass` path. A judge that declares no arms
 * keeps the older, narrower rule — only `pass` continues.
 */
async function judgeStep(
  node: Extract<IrNode, { kind: "judge" }>,
  context: EngineRunContext,
  values: RunValues,
): Promise<StepOutcome> {
  try {
    const verdict = await context.judge(
      node.id,
      node.judgeRef,
      inputFor(node.reads, values),
    );
    if (node.verdicts === undefined) {
      return verdict === "pass"
        ? "continue"
        : failed(node.id, `judge verdict ${verdict}`, false);
    }
    return node.verdicts.includes(verdict)
      ? { kind: "routed", nodeId: node.id, arm: verdict }
      : failed(node.id, `judge verdict ${verdict} has no arm`, false);
  } catch (error) {
    // A judge that errors escalates; it never passes.
    return failed(node.id, `judge errored: ${messageOf(error)}`, false);
  }
}

/**
 * A node whose whole job is to consume one value. Resolving and handing it over
 * are the same failure: either way the node did not do what it declared, and a
 * missing value is never retried into existence.
 */
async function dataStep(
  nodeId: string,
  reads: DataRef | undefined,
  values: RunValues,
  consume: (input: JsonValue) => Promise<void>,
): Promise<StepOutcome> {
  if (reads === undefined) return "continue";
  try {
    await consume(values.read(reads.node, reads.path));
    return "continue";
  } catch (error) {
    return failed(nodeId, messageOf(error), false);
  }
}

/**
 * A tool resolves its input *before* the gate is considered: an action whose
 * argument cannot be constructed is not an action to ask a human about, and an
 * approval has to name something that exists.
 */
async function toolStep(
  node: Extract<IrNode, { kind: "tool" }>,
  context: EngineRunContext,
  authorised: AuthorisedEffects,
  materialized: MaterializedPlan,
  values: RunValues,
): Promise<StepOutcome> {
  let input: JsonValue | undefined;
  try {
    input = inputFor(node.reads, values);
  } catch (error) {
    return failed(node.id, messageOf(error), false);
  }

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
    await context.perform(node.id, node.effect, input);
    return "continue";
  } catch (error) {
    return failed(node.id, messageOf(error), true);
  }
}

/**
 * One node, one outcome. Each kind owns its failure semantics: an agent may be
 * retried, a judge may not, and an unauthorised effect interrupts rather than
 * failing. A `sandbox` node is absent here on purpose — it opens a scope around
 * the rest of the walk rather than being a step that starts and returns.
 */
async function step(
  node: IrNode,
  context: EngineRunContext,
  authorised: AuthorisedEffects,
  materialized: MaterializedPlan,
  values: RunValues,
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
      return judgeStep(node, context, values);

    case "branch": {
      // An undeclared or unchoosable arm stops the walk rather than defaulting
      // to one: a workflow that says *block or publish* must not do both.
      try {
        const arm = await context.chooseBranch(
          node.id,
          node.conditionIds,
          inputFor(node.reads, values),
        );
        return node.conditionIds.includes(arm)
          ? { kind: "routed", nodeId: node.id, arm }
          : failed(node.id, `branch arm ${arm} is not declared`, false);
      } catch (error) {
        return failed(node.id, messageOf(error), false);
      }
    }

    case "transform":
      // A node with nothing to read is not in the data plane at all.
      return dataStep(node.id, node.reads, values, (input) =>
        context.transform(node.id, node.transformRef, input),
      );

    case "output":
      return dataStep(node.id, node.reads, values, (value) =>
        context.emitOutput(node.id, value),
      );

    case "policy_check":
      try {
        await context.assertCapability(node.id, node.capability);
        return "continue";
      } catch (error) {
        return failed(node.id, messageOf(error), false);
      }

    case "tool":
      return toolStep(node, context, authorised, materialized, values);

    default:
      return "continue";
  }
}

/**
 * Kill every arm out of `nodeId` the verdict did not take, unlabelled ones
 * included — the compiler refuses that shape, but a hand-built IR may carry it.
 */
function pruneArms(
  ir: ForgeIr,
  nodeId: string,
  arm: string,
  pruned: Set<string>,
): void {
  for (const edge of ir.edges) {
    if (edge.from !== nodeId || edge.conditionId === arm) continue;
    pruned.add(edgeKey(edge));
  }
}

/** Everything one walk of a plan mutates, in one place rather than five. */
interface WalkState {
  readonly materialized: MaterializedPlan;
  readonly context: EngineRunContext;
  readonly authorised: AuthorisedEffects;
  readonly values: RunValues;
  readonly visited: string[];
  readonly pruned: Set<string>;
  /** Shrinks as arms are pruned; never grows. */
  live: ReadonlySet<string>;
}

/**
 * Walks a list of nodes in order. `undefined` means the list ran out — the
 * caller decides whether that is the whole run succeeding or a sandbox scope
 * having finished.
 */
async function walk(
  state: WalkState,
  nodes: readonly IrNode[],
): Promise<EngineExecutionResult | undefined> {
  const { ir, entryId } = state.materialized;

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index] as IrNode;
    // A pruned arm is not "skipped": it is no longer part of this run, exactly
    // like a node the graph never reaches.
    if (!state.live.has(node.id)) continue;

    if (node.kind === "sandbox") {
      return enterScope(state, node, nodes.slice(index + 1));
    }

    state.visited.push(node.id);
    const outcome = await step(
      node,
      state.context,
      state.authorised,
      state.materialized,
      state.values,
    );
    if (outcome === "continue") continue;
    if (outcome.kind === "routed") {
      pruneArms(ir, outcome.nodeId, outcome.arm, state.pruned);
      state.live = reachableFrom(ir, entryId, state.pruned);
      continue;
    }
    // `failed` carries no visited list in the port contract; `interrupted` does.
    return outcome.kind === "failed"
      ? outcome
      : { ...outcome, visited: state.visited };
  }
  return undefined;
}

/**
 * A `sandbox` node isolates what the graph reaches *from it* — nothing else.
 * Anything still pending that is not downstream of it is walked first, outside
 * the lease: those nodes never declared isolation, and a topological order
 * permits them before the sandbox precisely because no path leads from it to
 * them. The scope is then a contiguous tail, so one lease spans it and is
 * released the moment the tail stops — at the end, at a failure, or at a gate.
 */
async function enterScope(
  state: WalkState,
  node: Extract<IrNode, { kind: "sandbox" }>,
  rest: readonly IrNode[],
): Promise<EngineExecutionResult | undefined> {
  const scope = reachableFrom(state.materialized.ir, node.id, state.pruned);
  const before = await walk(
    state,
    rest.filter((next) => !scope.has(next.id)),
  );
  if (before !== undefined) return before;

  state.visited.push(node.id);
  try {
    return await state.context.withSandbox(node.id, node.profile, () =>
      walk(
        state,
        rest.filter((next) => scope.has(next.id)),
      ),
    );
  } catch (error) {
    // No host fallback. A sandbox that could not be provisioned — or that was
    // lost mid-scope — stops the walk rather than continuing on the host.
    return failed(node.id, messageOf(error), false);
  }
}

export function createMemoryGraphEngine(): GraphEnginePort {
  return {
    async materialize(ir: unknown): Promise<EnginePlan> {
      const typed = ir as ForgeIr;
      // Execution follows edges: a node with no path from the entry node is not
      // "later in the order", it is not part of this run at all.
      const entry =
        typed.nodes.find((node) => node.kind === "input") ?? typed.nodes[0];
      const reachable =
        entry === undefined
          ? new Set<string>()
          : reachableFrom(typed, entry.id);

      const token = {} as EnginePlan;
      plans.set(token, {
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
      values: RunValues,
    ): Promise<EngineExecutionResult> {
      const materialized = plans.get(plan);
      if (materialized === undefined) {
        return {
          kind: "failed",
          nodeId: "",
          reason: "Plan was not produced by this engine.",
          retryable: false,
        };
      }

      const state: WalkState = {
        materialized,
        context,
        authorised,
        values,
        visited: [],
        pruned: new Set<string>(),
        live: reachableFrom(materialized.ir, materialized.entryId),
      };

      return (
        (await walk(state, materialized.order)) ?? {
          kind: "succeeded",
          visited: state.visited,
        }
      );
    },
  };
}
