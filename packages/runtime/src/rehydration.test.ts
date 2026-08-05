import { createMemoryApprovalStore } from "@forge/approval-memory";
import { createMemoryCheckpointStore } from "@forge/checkpoint-memory";
import { compileWorkflow } from "@forge/compiler";
import { createMemoryGraphEngine } from "@forge/engine-memory";
import {
  createMemoryObservability,
  type MemoryObservability,
} from "@forge/observability-memory";
import { createMemoryPolicy, type PolicyRule } from "@forge/policy-memory";
import {
  type ApprovalPort,
  createSequentialIds,
  type JsonValue,
  type ProviderPort,
  type RunStorePort,
} from "@forge/ports";
import { createMemoryRunStore } from "@forge/run-store-memory";
import { createMemorySandbox } from "@forge/sandbox";
import { describe, expect, test } from "vitest";

import { createRuntime, type Runtime, type SealedArtifact } from "./runtime.js";

/**
 * Rehydration: a run re-entered by a runtime that did not start it.
 *
 * Two `createRuntime` calls sharing nothing but the stores stand for two
 * processes. That is a weaker claim than two operating-system processes, and
 * the real-process proof lives in `apps/worker/test/durable-restart.test.ts`;
 * what this file is for is the refusal points, which need a store that can be
 * tampered with and an approval port that can be made to misbehave.
 *
 * The fixture puts an `agent` and a `branch` before the gate on purpose. Both
 * are answers, not computations: re-walking would ask the model again and
 * choose the arm again, and neither has to come back the same. Every test here
 * gives the second runtime a model that says something else and a branch that
 * routes somewhere else, so a ledger that failed to survive is not a subtle
 * difference — it is a different action, or no action at all.
 */

const source = {
  id: "acme.rehydrate",
  version: "1.0.0",
  sideEffects: ["slack.post"],
  nodes: [
    { id: "intake", kind: "input", schemaRef: "acme.in@1" },
    { id: "draft", kind: "agent", promptRef: "acme.draft@1" },
    { id: "route", kind: "branch", conditionIds: ["go", "stop"] },
    {
      id: "gate",
      kind: "approval",
      gateSchemaRef: "acme.gate@1",
      gates: ["publish"],
    },
    {
      id: "publish",
      kind: "tool",
      skillRef: "slack.post@1",
      effect: "slack.post",
      reads: { node: "draft", path: [] },
    },
    {
      id: "result",
      kind: "output",
      schemaRef: "acme.out@1",
      reads: { node: "publish", path: [] },
    },
    {
      id: "halted",
      kind: "output",
      schemaRef: "acme.out@1",
      reads: { node: "draft", path: [] },
    },
  ],
  edges: [
    { from: "intake", to: "draft" },
    { from: "draft", to: "route" },
    { from: "route", to: "gate", conditionId: "go" },
    { from: "route", to: "halted", conditionId: "stop" },
    { from: "gate", to: "publish" },
    { from: "publish", to: "result" },
  ],
} as const;

function artifact(): SealedArtifact {
  const compiled = compileWorkflow(source);
  if (!compiled.ok) {
    throw new Error(`Fixture must compile: ${JSON.stringify(compiled)}`);
  }
  return {
    workflowId: compiled.value.ir.workflowId,
    fingerprint: compiled.value.fingerprint,
    ir: compiled.value.ir,
  };
}

/**
 * The same shape with nothing reading the agent, so a model that streams
 * nothing still lets the run reach its gate. What is being proved is that
 * "ran and produced nothing" is a ledger entry, not an absence: a second
 * runtime must not ask again to find out.
 */
const silentSource = {
  ...source,
  id: "acme.rehydrate.silent",
  nodes: source.nodes.map((node) =>
    node.id === "publish" || node.id === "halted"
      ? Object.fromEntries(
          Object.entries(node).filter(([key]) => key !== "reads"),
        )
      : node,
  ),
} as unknown;

function silentArtifact(): SealedArtifact {
  const compiled = compileWorkflow(silentSource);
  if (!compiled.ok) {
    throw new Error(`Fixture must compile: ${JSON.stringify(compiled)}`);
  }
  return {
    workflowId: compiled.value.ir.workflowId,
    fingerprint: compiled.value.fingerprint,
    ir: compiled.value.ir,
  };
}

const RULES: readonly PolicyRule[] = [
  {
    id: "acme.publish.external",
    action: "slack.post",
    environment: "production",
    decision: "require-approval",
    reason: "External publication is a human call.",
    approvers: ["marketing-lead"],
  },
];

const DRAFT_ONE = "written by the first runtime";
const DRAFT_TWO = "written by the second runtime";
const RECEIPT = { published: true };
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Streams one line and counts how often it was asked. */
function countingProvider(text: string | undefined): {
  provider: ProviderPort;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      providerId: "counting",
      capabilities: ["streaming"],
      async createSession() {
        return { sessionId: "session", providerId: "counting" };
      },
      async resumeSession() {
        return { sessionId: "session", providerId: "counting" };
      },
      async *execute() {
        calls += 1;
        if (text !== undefined) yield { type: "text-delta", text } as const;
        yield { type: "completed" } as const;
      },
      async cancel() {},
      async destroySession() {},
      async health() {
        return { available: true, providerId: "counting" };
      },
    },
  };
}

interface ProcessOptions {
  /** What this runtime's model would say, if it were asked. */
  readonly text?: string;
  /** A model that streams nothing, so the node runs and produces no value. */
  readonly silent?: boolean;
  /** Which arm this runtime's branch would take, if it were asked. */
  readonly arm?: string;
  /** Swapped in to prove a refusal; defaults to the shared store. */
  readonly runs?: RunStorePort;
  readonly approvals?: ApprovalPort;
}

interface Process {
  readonly runtime: Runtime;
  /** What the sink was asked to act on, in order. */
  readonly acted: (JsonValue | undefined)[];
  readonly modelCalls: () => number;
  readonly observability: MemoryObservability;
}

/** Two runtimes over one set of stores. */
function world() {
  let instant = new Date("2026-08-04T00:00:00.000Z");
  const clock = { now: () => new Date(instant) };
  // Shared, so a second runtime does not mint an id the first already used.
  const ids = createSequentialIds();
  const approvals = createMemoryApprovalStore(clock, ids);
  const checkpoints = createMemoryCheckpointStore();
  const runs = createMemoryRunStore();

  function start(options: ProcessOptions = {}): Process {
    const acted: (JsonValue | undefined)[] = [];
    const agent = countingProvider(
      options.silent === true ? undefined : (options.text ?? DRAFT_ONE),
    );
    const observability = createMemoryObservability();
    const runtime = createRuntime({
      engine: createMemoryGraphEngine(),
      policy: createMemoryPolicy({ rules: RULES, grants: ["slack.write"] }),
      approvals: options.approvals ?? approvals,
      provider: agent.provider,
      sandbox: createMemorySandbox({ profiles: ["docker"], available: true }),
      observability,
      panel: { standing: [], summonable: [], quorum: 0.5 },
      branchFor: () => options.arm ?? "go",
      effects: {
        async perform(_runId, _nodeId, _effect, input) {
          acted.push(input);
          return RECEIPT;
        },
      },
      checkpoints,
      runs: options.runs ?? runs,
      clock,
      ids,
      actor: "svc.forge.worker",
      environment: "production",
      approvalTtlMs: TTL_MS,
    });
    return { runtime, acted, modelCalls: agent.calls, observability };
  }

  return {
    start,
    runs,
    approvals,
    ids,
    advance: (ms: number) => {
      instant = new Date(instant.getTime() + ms);
    },
  };
}

/** Starts a run in one runtime and leaves it at its gate. */
async function parked(forge: ReturnType<typeof world>) {
  const first = forge.start();
  const run = await first.runtime.start({
    artifact: artifact(),
    capabilities: ["slack.write"],
    payload: { member: "synthetic-001" },
  });
  expect(run.status).toBe("AWAITING_APPROVAL");
  expect(first.modelCalls()).toBe(1);
  return { first, run };
}

/** Rewrites the durable record, standing in for a crash or for tampering. */
async function rewrite(
  forge: ReturnType<typeof world>,
  runId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const persisted = await forge.runs.load(runId);
  if (persisted === undefined) throw new Error("nothing to rewrite");
  await forge.runs.update({ ...persisted.record, ...patch } as never);
}

describe("a run is re-entered, not re-walked", () => {
  test("a second runtime decides the gate without asking the model again", async () => {
    const forge = world();
    const { run } = await parked(forge);

    const second = forge.start({ text: DRAFT_TWO, arm: "stop" });
    // It has never heard of this run until it is asked to decide.
    expect(second.runtime.getRun(run.runId)).toBeUndefined();

    const approvalId = run.pendingApprovalId as string;
    const finished = await second.runtime.decide(
      approvalId,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(finished).toMatchObject({ status: "SUCCEEDED", result: RECEIPT });
    // The value the approver saw, not the one this runtime would produce.
    expect(second.acted).toEqual([DRAFT_ONE]);
    expect(second.modelCalls()).toBe(0);
  });

  test("the arm the run took is replayed, so a second runtime cannot reroute it", async () => {
    const forge = world();
    const { run } = await parked(forge);

    // This runtime's branch says `stop`, which leads away from the gated
    // effect entirely. Re-choosing would report SUCCEEDED having dispatched
    // nothing, after an operator explicitly approved the action.
    const second = forge.start({ arm: "stop" });
    await second.runtime.decide(
      run.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(second.acted).toEqual([DRAFT_ONE]);
    expect(
      second.observability.events.filter(
        (event) => event.name === "forge.node.branch",
      ),
    ).toEqual([]);
  });

  test("a decision recorded in the store elsewhere is carried forward by resume", async () => {
    const forge = world();
    const { run } = await parked(forge);
    // What a control plane in another process can do, and all it can do.
    await forge.approvals.decide(
      run.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    const second = forge.start({ text: DRAFT_TWO, arm: "stop" });
    const finished = await second.runtime.resume(run.runId);

    expect(finished).toMatchObject({ status: "SUCCEEDED", result: RECEIPT });
    expect(second.acted).toEqual([DRAFT_ONE]);
    expect(second.modelCalls()).toBe(0);
    expect(
      second.observability.events.filter(
        (event) => event.name === "forge.run.resumed",
      ),
    ).toHaveLength(1);
  });

  test("a node that ran and produced nothing is not run again to find out", async () => {
    // Absent and "produced nothing" are different, and only the ledger knows
    // which this is. Asking again would be a second model call.
    const forge = world();
    const first = forge.start({ silent: true });
    const run = await first.runtime.start({
      artifact: silentArtifact(),
      capabilities: ["slack.write"],
      payload: { member: "synthetic-001" },
    });
    expect(run.status).toBe("AWAITING_APPROVAL");
    expect(first.modelCalls()).toBe(1);

    const second = forge.start({ text: DRAFT_TWO });
    const finished = await second.runtime.decide(
      run.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(finished.status).toBe("SUCCEEDED");
    expect(second.modelCalls()).toBe(0);
    expect(second.acted).toEqual([undefined]);
  });

  test("a run left RUNNING by a crash is re-entered and re-gated, not dispatched", async () => {
    const forge = world();
    const { run } = await parked(forge);
    // What a process that died mid-walk leaves behind.
    await rewrite(forge, run.runId, {
      status: "RUNNING",
      pendingApprovalId: undefined,
    });

    const second = forge.start({ text: DRAFT_TWO });
    const reentered = await second.runtime.resume(run.runId);

    expect(reentered).toMatchObject({ status: "AWAITING_APPROVAL" });
    expect(reentered?.pendingApprovalId).not.toBe(run.pendingApprovalId);
    expect(second.acted).toEqual([]);
    expect(second.modelCalls()).toBe(0);
  });

  test("a terminal run is reported, not walked again", async () => {
    const forge = world();
    const { first, run } = await parked(forge);
    await first.runtime.decide(
      run.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    const second = forge.start();
    expect(await second.runtime.resume(run.runId)).toMatchObject({
      status: "SUCCEEDED",
      result: RECEIPT,
    });
    expect(second.acted).toEqual([]);
  });

  test("an output node that already emitted replays its result", async () => {
    const forge = world();
    const { first, run } = await parked(forge);
    await first.runtime.decide(
      run.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );
    // A crash between emitting the output and recording the outcome.
    await rewrite(forge, run.runId, { status: "RUNNING", result: undefined });

    const second = forge.start();
    const finished = await second.runtime.resume(run.runId);

    expect(finished).toMatchObject({ status: "SUCCEEDED", result: RECEIPT });
    expect(second.acted).toEqual([]);
  });

  test("a run nobody started is nothing to re-enter", async () => {
    const forge = world();
    const second = forge.start();

    expect(await second.runtime.resume("run_never_started")).toBeUndefined();
    expect(await second.runtime.loadRun("run_never_started")).toBeUndefined();
  });

  test("the record and the cancel reach a run this runtime did not start", async () => {
    // The two calls a control plane could not make after a restart: the record
    // was not found, and cancelling threw "Unknown run".
    const forge = world();
    const { run } = await parked(forge);
    const second = forge.start();

    expect(await second.runtime.loadRun(run.runId)).toMatchObject({
      runId: run.runId,
      status: "AWAITING_APPROVAL",
    });
    expect(await second.runtime.cancel(run.runId)).toMatchObject({
      status: "CANCELLED",
    });
    expect(await forge.start().runtime.loadRun(run.runId)).toMatchObject({
      status: "CANCELLED",
    });
  });
});

describe("re-entering a gate refuses what it should", () => {
  test("an undecided gate leaves the run exactly where it parked", async () => {
    const forge = world();
    const { run } = await parked(forge);
    const second = forge.start();

    expect(await second.runtime.resume(run.runId)).toMatchObject({
      status: "AWAITING_APPROVAL",
      pendingApprovalId: run.pendingApprovalId,
    });
    expect(second.acted).toEqual([]);
  });

  test("a rejected gate authorises nothing", async () => {
    const forge = world();
    const { run } = await parked(forge);
    const approvalId = run.pendingApprovalId as string;
    await forge.approvals.decide(
      approvalId,
      { kind: "reject", reason: "not this one" },
      "marketing-lead",
    );

    const second = forge.start();
    expect(await second.runtime.resume(run.runId)).toMatchObject({
      status: "FAILED",
      error: `Approval ${approvalId} was REJECTED, which authorises nothing.`,
    });
    expect(second.acted).toEqual([]);
  });

  test("a gate decided after it expired is not a slow yes", async () => {
    const forge = world();
    const { run } = await parked(forge);
    const approvalId = run.pendingApprovalId as string;
    forge.advance(TTL_MS + 1);
    await forge.approvals.decide(
      approvalId,
      { kind: "approve" },
      "marketing-lead",
    );

    const second = forge.start();
    expect(await second.runtime.resume(run.runId)).toMatchObject({
      status: "FAILED",
      error: `Approval ${approvalId} was not decided within its deadline.`,
    });
    expect(second.acted).toEqual([]);
  });

  test("an approval that names no moment cannot be shown to have met its deadline", async () => {
    const forge = world();
    const { run } = await parked(forge);
    const approvalId = run.pendingApprovalId as string;
    await forge.approvals.decide(
      approvalId,
      { kind: "approve" },
      "marketing-lead",
    );

    // A store that forgot to write `decidedAt` would otherwise get the benefit
    // of the doubt on every deadline it holds.
    const forgetful: ApprovalPort = {
      ...forge.approvals,
      async get(id) {
        const record = await forge.approvals.get(id);
        if (record === undefined) return undefined;
        return { ...record, decidedAt: undefined };
      },
    };

    const second = forge.start({ approvals: forgetful });
    expect(await second.runtime.resume(run.runId)).toMatchObject({
      status: "FAILED",
      error: `Approval ${approvalId} was not decided within its deadline.`,
    });
    expect(second.acted).toEqual([]);
  });

  test("a binding that no longer recomputes authorises nothing", async () => {
    const forge = world();
    const { run } = await parked(forge);
    await forge.approvals.decide(
      run.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );
    // A different artifact behind the same run id. The approval was bound to
    // run + node + effect + fingerprint, so it no longer describes this action.
    await rewrite(forge, run.runId, { fingerprint: "sha256:something-else" });

    const second = forge.start();
    expect(await second.runtime.resume(run.runId)).toMatchObject({
      status: "FAILED",
      error: "Approval no longer matches the action it was bound to.",
    });
    expect(second.acted).toEqual([]);
  });

  test("a gate whose approval cannot be found leaves the run parked", async () => {
    const forge = world();
    const { run } = await parked(forge);
    await rewrite(forge, run.runId, { pendingApprovalId: "approval_missing" });

    const second = forge.start();
    expect(await second.runtime.resume(run.runId)).toMatchObject({
      status: "AWAITING_APPROVAL",
    });
    expect(second.acted).toEqual([]);
  });

  test("a parked run naming no gate is left alone rather than guessed at", async () => {
    const forge = world();
    const { run } = await parked(forge);
    await rewrite(forge, run.runId, { pendingApprovalId: undefined });

    const second = forge.start();
    const reentered = await second.runtime.resume(run.runId);

    expect(reentered).toMatchObject({ status: "AWAITING_APPROVAL" });
    expect(reentered?.pendingApprovalId).toBeUndefined();
    expect(second.acted).toEqual([]);
  });
});

describe("two workers racing one dispatch", () => {
  /**
   * A store that loses the claim to someone else at the last moment — the
   * window the in-process ledger check cannot see, because the other worker
   * arrived after this one had already looked.
   */
  const racing = (
    inner: RunStorePort,
    pinned: JsonValue | undefined,
  ): RunStorePort => ({
    ...inner,
    async claimEffect(claim) {
      await inner.claimEffect(claim);
      if (pinned !== undefined) {
        await inner.pinValue(claim.runId, claim.nodeId, pinned);
      }
      return inner.claimEffect(claim);
    },
  });

  test("the loser adopts what the winner pinned rather than acting again", async () => {
    const forge = world();
    const { run } = await parked(forge);

    const second = forge.start({ runs: racing(forge.runs, RECEIPT) });
    const finished = await second.runtime.decide(
      run.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    // The run completes on the winner's data, and this process performed
    // nothing at all.
    expect(finished).toMatchObject({ status: "SUCCEEDED", result: RECEIPT });
    expect(second.acted).toEqual([]);
  });

  test("the loser fails closed when the winner has pinned nothing yet", async () => {
    // Losing an effect is recoverable; performing one twice is not. A run that
    // cannot see what the action produced stops rather than inventing it.
    const forge = world();
    const { run } = await parked(forge);

    const second = forge.start({ runs: racing(forge.runs, undefined) });
    const finished = await second.runtime.decide(
      run.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(finished.status).toBe("FAILED");
    expect(second.acted).toEqual([]);
  });

  test("an effect already in the ledger is not re-dispatched on re-entry", async () => {
    const forge = world();
    const { run } = await parked(forge);
    // A worker that dispatched and then lost its process before the record
    // caught up. Both the claim and the value are already durable.
    await forge.runs.claimEffect({
      runId: run.runId,
      nodeId: "publish",
      effect: "slack.post",
      input: DRAFT_ONE,
      at: "2026-08-04T00:00:00.000Z",
    });
    await forge.runs.pinValue(run.runId, "publish", RECEIPT);
    await forge.approvals.decide(
      run.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    const second = forge.start();
    // Reading the run is enough to restore the ledger: it knows what it
    // dispatched before it is asked to do anything with it.
    await second.runtime.loadRun(run.runId);
    expect(second.runtime.ledger(run.runId)).toEqual(["publish"]);

    const finished = await second.runtime.resume(run.runId);

    expect(finished).toMatchObject({ status: "SUCCEEDED", result: RECEIPT });
    expect(second.acted).toEqual([]);
    expect(second.runtime.ledger(run.runId)).toEqual(["publish"]);
  });
});
