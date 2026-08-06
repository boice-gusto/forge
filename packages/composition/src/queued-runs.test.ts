import { createMemoryApprovalStore } from "@forge/approval-memory";
import { createMemoryObservability } from "@forge/observability-memory";
import type { ClockPort, IdPort, ProviderPort } from "@forge/ports";
import { createMemoryRunStore } from "@forge/run-store-memory";
import { describe, expect, test } from "vitest";

import {
  compileToArtifact,
  createLocalStack,
  createRunConsumer,
  type LocalStack,
  runtimeHost,
} from "./index.js";

/**
 * The queued path, end to end in one process.
 *
 * `Runtime.create` writes a run and stops; a `workflow.execute` job carries it
 * to a consumer; the consumer re-enters it with `resume`. Everything here is
 * about the seam between those three, because that seam is new and because it
 * is where "exactly once" is easiest to lose: a job may be delivered twice, and
 * two deliveries of the same run must act once.
 *
 * The runs below stop at a **gate**, not at a terminal state. That is
 * deliberate. A redelivery aimed at a finished run hits the terminal
 * short-circuit in `resume` and never reaches the node it was supposed to be
 * guarding, which is how a double-dispatch check in this repository once
 * passed while proving nothing.
 */

const RULES = [
  {
    id: "test.external",
    action: "prod.write",
    decision: "require-approval" as const,
    reason: "External writes need a human.",
    approvers: ["operator"],
  },
];

/** An agent before the gate, so "was the model asked twice" is answerable. */
const WORKFLOW = {
  id: "queued.gated",
  version: "1.0.0",
  sideEffects: ["prod.write"],
  nodes: [
    { id: "intake", kind: "input", schemaRef: "s@1" },
    { id: "draft", kind: "agent", promptRef: "p@1" },
    { id: "gate", kind: "approval", gateSchemaRef: "g@1", gates: ["act"] },
    { id: "act", kind: "tool", skillRef: "t@1", effect: "prod.write" },
    { id: "done", kind: "output", schemaRef: "s@1" },
  ],
  edges: [
    { from: "intake", to: "draft" },
    { from: "draft", to: "gate" },
    { from: "gate", to: "act" },
    { from: "act", to: "done" },
  ],
} as const;

function artifact() {
  const compiled = compileToArtifact(WORKFLOW);
  if (!compiled.ok) {
    throw new Error(
      `the fixture must compile: ${compiled.diagnostics.map((d) => d.code).join(", ")}`,
    );
  }
  return compiled.artifact;
}

/** A provider that counts how many times a model was actually asked. */
function countingProvider(): { provider: ProviderPort; calls: () => number } {
  let calls = 0;
  let sessions = 0;
  const provider: ProviderPort = {
    providerId: "counting",
    capabilities: ["streaming"],
    async createSession() {
      sessions += 1;
      return { sessionId: `session_${sessions}`, providerId: "counting" };
    },
    async resumeSession(input) {
      return { sessionId: input.sessionId, providerId: "counting" };
    },
    async *execute() {
      calls += 1;
      yield { type: "text-delta", text: "drafted" } as const;
      yield { type: "completed" } as const;
    },
    async cancel() {},
    async destroySession() {},
    async health() {
      return { available: true, providerId: "counting" };
    },
  };
  return { provider, calls: () => calls };
}

function deployment(overrides: Parameters<typeof createLocalStack>[0] = {}) {
  return createLocalStack({
    rules: RULES,
    grants: ["repo.read"],
    environment: "production",
    ...overrides,
  });
}

/** Binds the same consumer `apps/api` and `apps/worker` bind. */
async function consume(stack: LocalStack) {
  const consumer = createRunConsumer({
    queue: stack.queue,
    host: runtimeHost(stack.runtime),
    observability: stack.observability,
  });
  await consumer.start();
  return consumer;
}

const enqueueExecute = (stack: LocalStack, runId: string, attempt = 1) =>
  stack.queue.enqueue({
    type: "workflow.execute",
    runId,
    workflowVersionId: "sha256:pinned",
    attempt,
  });

describe("a created run is carried to its gate by the queue", () => {
  test("create leaves the run PENDING with nothing walked", async () => {
    const stack = deployment();
    const run = await stack.runtime.create({ artifact: artifact() });

    expect(run.status).toBe("PENDING");
    expect(run.pendingApprovalId).toBeUndefined();
    expect(stack.dispatched).toEqual([]);
    // Durable before anything else happens: the consumer only gets an id.
    expect((await stack.runs.load(run.runId))?.record.status).toBe("PENDING");
  });

  test("the consumer advances it to the gate, and the record says RUNNING first", async () => {
    const stack = deployment();
    await consume(stack);

    const created = await stack.runtime.create({ artifact: artifact() });
    await enqueueExecute(stack, created.runId);
    await stack.drain();

    const run = await stack.runtime.loadRun(created.runId);
    expect(run?.status).toBe("AWAITING_APPROVAL");
    expect(stack.dispatched).toEqual([]);

    // PENDING means "not picked up yet" (006 §5). A run that went straight
    // from PENDING to AWAITING_APPROVAL would make the distinction a fiction.
    const transitions = stack.observability.timeline
      .filter((entry) => entry.name === "forge.run.transition")
      .map((entry) => `${entry.attributes.from}->${entry.attributes.to}`);
    expect(transitions).toEqual([
      "PENDING->RUNNING",
      "RUNNING->AWAITING_APPROVAL",
    ]);
  });

  test("delivery is off the enqueuer's stack, so nothing walks inside enqueue", async () => {
    // The property `POST /v1/runs` depends on. A memory queue that delivered
    // inside `enqueue` would leave this run already parked.
    const stack = deployment();
    await consume(stack);

    const created = await stack.runtime.create({ artifact: artifact() });
    await enqueueExecute(stack, created.runId);

    expect((await stack.runtime.loadRun(created.runId))?.status).toBe(
      "PENDING",
    );
    await stack.drain();
    expect((await stack.runtime.loadRun(created.runId))?.status).toBe(
      "AWAITING_APPROVAL",
    );
  });
});

describe("a run consumed twice acts once", () => {
  test("a redelivered execute job re-enters a parked run without re-asking a model", async () => {
    const agent = countingProvider();
    const stack = deployment({ provider: agent.provider });
    await consume(stack);

    const created = await stack.runtime.create({ artifact: artifact() });
    await enqueueExecute(stack, created.runId);
    await stack.drain();
    expect((await stack.runtime.loadRun(created.runId))?.status).toBe(
      "AWAITING_APPROVAL",
    );
    expect(agent.calls()).toBe(1);

    // The run is at a gate, not finished, so this delivery genuinely re-enters
    // it rather than bouncing off a terminal short-circuit. Attempt 2 so the
    // queue's own de-duplication is not what is being tested.
    await enqueueExecute(stack, created.runId, 2);
    await stack.drain();

    expect(agent.calls()).toBe(1);
    expect(stack.dispatched).toEqual([]);
    expect((await stack.runtime.loadRun(created.runId))?.status).toBe(
      "AWAITING_APPROVAL",
    );
  });

  test("two processes racing one decided gate dispatch the effect once", async () => {
    /**
     * The case a redelivery test cannot reach on its own.
     *
     * Two stacks over one pair of stores stand for two workers: neither can
     * see the other's runtime, ledgers or in-memory effect list, so the only
     * thing between them is the durable claim. Both walks start while the run
     * is `AWAITING_APPROVAL` with the gate already approved, so neither sees a
     * terminal state and both reach the tool node.
     */
    let performing: (() => void) | undefined;
    const held = new Promise<void>((settle) => {
      performing = settle;
    });
    const entered: string[] = [];
    const performed: string[] = [];

    // One database, two workers.
    const clock: ClockPort = {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    };
    let minted = 0;
    const ids: IdPort = {
      next: (prefix) => {
        minted += 1;
        return `${prefix}_${minted}`;
      },
    };
    const sharedRuns = createMemoryRunStore();
    const sharedApprovals = createMemoryApprovalStore(clock, ids);

    const worker = (name: string, provider: ProviderPort) =>
      deployment({
        runs: sharedRuns,
        approvals: sharedApprovals,
        ids,
        provider,
        effects: {
          async perform(_runId, _nodeId, effect) {
            entered.push(name);
            // Hold the first dispatch open long enough for the second walk to
            // reach the same node. Sequential walks would let the second find
            // a finished run, which is the shape that proves nothing.
            await held;
            performed.push(effect);
            return undefined;
          },
        },
      });

    const one = countingProvider();
    const two = countingProvider();
    const first = worker("one", one.provider);
    const second = worker("two", two.provider);

    const created = await first.runtime.create({ artifact: artifact() });
    await enqueueExecute(first, created.runId);
    await consume(first);
    await first.drain();

    const parked = await first.runtime.loadRun(created.runId);
    expect(parked?.status).toBe("AWAITING_APPROVAL");
    expect(one.calls()).toBe(1);

    // Decided straight into the approval store, as a control plane in another
    // process can only do. Both workers then find an approved gate.
    await sharedApprovals.decide(
      parked?.pendingApprovalId as string,
      { kind: "approve" },
      "operator",
    );

    const left = first.runtime.resume(created.runId);
    const right = second.runtime.resume(created.runId);
    // Let both reach the sink before either is allowed to finish.
    await new Promise((settle) => setTimeout(settle, 5));
    performing?.();
    const [a, b] = await Promise.all([left, right]);

    expect(entered).toHaveLength(1);
    expect(performed).toEqual(["prod.write"]);
    // The second worker replays the draft from the value ledger rather than
    // asking a model of its own.
    expect(two.calls()).toBe(0);

    /**
     * Both return a record and neither throws. They do not have to agree on
     * the status, and it would be a worse system if they did: the loser is a
     * process that discovered mid-walk that another had already advanced the
     * run, and the only honest thing it can report is where the run stood when
     * it stepped aside. Waiting for the winner to finish so both could say
     * `SUCCEEDED` would be a poll loop invented to make an assertion tidy.
     *
     * The properties that matter are below, and neither is about agreement:
     * one dispatch, and a run that reaches its terminal state exactly once.
     */
    expect([a, b].every((record) => record !== undefined)).toBe(true);
    expect([a?.status, b?.status]).toContain("SUCCEEDED");

    const stored = await sharedRuns.load(created.runId);
    expect(stored?.record.status).toBe("SUCCEEDED");
    expect(stored?.effects.map((effect) => effect.nodeId)).toEqual(["act"]);
  });
});

describe("every job verb lands on the runtime the stack bound", () => {
  test("a resume job carries a decided gate out, without a decision route", async () => {
    // The other half of 006 §10.3: the decision is already durable, and the
    // job only moves the walk off whatever request recorded it.
    const stack = deployment();
    await consume(stack);

    const created = await stack.runtime.create({ artifact: artifact() });
    await enqueueExecute(stack, created.runId);
    await stack.drain();
    const parked = await stack.runtime.loadRun(created.runId);
    const approvalId = parked?.pendingApprovalId as string;
    await stack.approvals.decide(approvalId, { kind: "approve" }, "operator");

    await stack.queue.enqueue({
      type: "workflow.resume",
      runId: created.runId,
      approvalId,
      attempt: 2,
    });
    await stack.drain();

    expect((await stack.runtime.loadRun(created.runId))?.status).toBe(
      "SUCCEEDED",
    );
    expect(stack.dispatched).toEqual(["prod.write"]);
    expect(
      stack.observability.events
        .filter((event) => event.name === "forge.worker.resumed")
        .map((event) => event.attributes.status),
    ).toEqual(["SUCCEEDED"]);
  });

  test("a cancel job cancels the run and dispatches nothing", async () => {
    const stack = deployment();
    await consume(stack);

    const created = await stack.runtime.create({ artifact: artifact() });
    await enqueueExecute(stack, created.runId);
    await stack.drain();

    await stack.queue.enqueue({
      type: "workflow.cancel",
      runId: created.runId,
    });
    await stack.drain();

    expect((await stack.runtime.loadRun(created.runId))?.status).toBe(
      "CANCELLED",
    );
    expect(stack.dispatched).toEqual([]);
  });

  test("a job for a run no store has is UNKNOWN, not a crash", async () => {
    const stack = deployment();
    await consume(stack);

    await enqueueExecute(stack, "run_never_created");
    await stack.drain();

    expect(
      stack.observability.events
        .filter((event) => event.name === "forge.worker.executed")
        .map((event) => event.attributes.status),
    ).toEqual(["UNKNOWN"]);
  });
});

describe("the consumer reports what it did with a job", () => {
  test("a job for a run that does not exist is recorded, not fatal", async () => {
    const stack = deployment();
    const observability = createMemoryObservability();
    await createRunConsumer({
      queue: stack.queue,
      host: {
        async execute() {
          throw new Error("no such run");
        },
        async resume() {
          return "UNKNOWN";
        },
        async cancel() {},
      },
      observability,
    }).start();

    await enqueueExecute(stack, "run_missing");
    await stack.drain();

    expect(observability.events.map((event) => event.name)).toContain(
      "forge.worker.job_failed",
    );
  });
});

/**
 * A stack given no `startedAt` runs on the real clock.
 *
 * The default used to be a literal instant in the past, so every gate the
 * running product issued was created *and* expired before a browser could
 * render it — the UI drew no approve control, and `pnpm dev` could not approve
 * anything at all. A frozen clock is a test affordance; it had become the
 * production default, and `apps/api` passes no `startedAt`.
 */
describe("the default clock is the real one", () => {
  test("a gate issued with no startedAt expires in the future", async () => {
    const stack = deployment({ approvalTtlMs: 60_000 });
    const before = Date.now();
    const run = await stack.runtime.start({ artifact: artifact() });
    const gate = (await stack.approvals.getPending(run.runId))[0];

    expect(run.status).toBe("AWAITING_APPROVAL");
    expect(gate).toBeDefined();
    // Both ends: created no earlier than this test started, and still open.
    expect(Date.parse(gate?.createdAt as string)).toBeGreaterThanOrEqual(
      before,
    );
    expect(Date.parse(gate?.expiresAt as string)).toBeGreaterThan(Date.now());
  });

  test("a stack that asked to be frozen still is, and still advances", async () => {
    // The affordance is kept, because determinism is what a suite about
    // expiry needs — it just has to be asked for.
    const stack = deployment({ startedAt: "2030-06-01T00:00:00.000Z" });
    expect(stack.clock.now().toISOString()).toBe("2030-06-01T00:00:00.000Z");

    stack.advanceClock(3_600_000);
    expect(stack.clock.now().toISOString()).toBe("2030-06-01T01:00:00.000Z");
  });
});
