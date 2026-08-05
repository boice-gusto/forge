import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { compileToArtifact } from "@forge/composition";
import {
  createDurableStack,
  type DurableStack,
  type DurableStackOptions,
  type RunRecord,
} from "@forge/composition/durable";
import { createMemoryObservability } from "@forge/observability-memory";
import type { JsonValue } from "@forge/ports";
import { containerRuntimeAvailable } from "@forge/store-conformance";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedRedisContainer } from "@testcontainers/redis";
import { RedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createWorkerConsumer, type RunHost } from "../src/consumer.js";
import {
  AGENT_WORKFLOW,
  countingProvider,
  RESTART_PAYLOAD,
  RESTART_PUBLISHED,
  RESTART_STACK_OPTIONS,
  RESTART_WORKFLOW,
  restartTransforms,
} from "./durable-workflow.js";

/**
 * The proof that durability is real.
 *
 * A run is started in a `node` process that then exits. Its runtime, its value
 * ledger, its route ledger, its effect ledger and its connection pool go with
 * it. A second process decides the gate, a `workflow.resume` job travels over
 * Redis, and a worker in that second process drives the run to completion.
 *
 * The assertions are about *what* was dispatched, not that something was: the
 * effect ledger records the input the action was performed on, and it has to
 * equal the value the first process pinned before it parked. A second process
 * that computes something different — a different transform, a different
 * model answer, a different branch arm — must still dispatch the first one's
 * value, and there are tests below that turn each of those on deliberately.
 */

const POSTGRES_IMAGE = "postgres:16-alpine";
const REDIS_IMAGE = "redis:7-alpine";
const CONTAINER_START_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 60_000;

const PREPARED = { ...RESTART_PAYLOAD, plan: "stable" };
const PUBLISHED = RESTART_PUBLISHED;
const DRAFT_ONE = "drafted by process one";
const DRAFT_TWO = "drafted by process two";

const dockerAvailable = await containerRuntimeAvailable(
  "worker-durable-restart",
);

const spawn = promisify(execFile);

async function waitFor(
  what: string,
  holds: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (await holds()) return;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(!dockerAvailable)("a run survives a process restart", () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let databaseUrl: string;
  let redisUrl: string;
  let namespaces = 0;
  const stacks: DurableStack[] = [];

  const compile = (source: unknown) => {
    const compiled = compileToArtifact(source);
    if (!compiled.ok) {
      throw new Error(
        `a restart fixture must compile: ${JSON.stringify(compiled.diagnostics)}`,
      );
    }
    return compiled.artifact;
  };
  // The child processes compile these themselves; compiling them here fails
  // the suite loudly if a fixture stops being a legal workflow, rather than
  // letting every test time out on a child that exited with diagnostics.
  const fingerprints = [RESTART_WORKFLOW, AGENT_WORKFLOW].map(
    (source) => compile(source).fingerprint,
  );

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).start(),
      new RedisContainer(REDIS_IMAGE).start(),
    ]);
    databaseUrl = postgres.getConnectionUri();
    redisUrl = redis.getConnectionUrl();
  }, CONTAINER_START_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all(stacks.splice(0).map((stack) => stack.close()));
    await Promise.all([postgres?.stop(), redis?.stop()]);
  });

  interface ChildReport {
    readonly runId: string;
    readonly status: string;
    readonly error?: string;
    readonly dispatched: readonly JsonValue[];
    /** How many times *that* process asked a model. */
    readonly providerCalls: number;
  }

  interface ChildOptions {
    readonly runId?: string;
    readonly ttlMs?: number;
    readonly workflow?: "restart" | "agent";
    readonly text?: string;
    readonly arm?: string;
  }

  /**
   * A whole other process. `execFile` resolves when the child has exited, so
   * by the time this returns there is nothing of it left to help — no runtime,
   * no value ledger, no in-process record of what it dispatched.
   */
  async function inAnotherProcess(
    mode: "park" | "resume",
    options: ChildOptions = {},
  ): Promise<ChildReport> {
    namespaces += 1;
    const script = fileURLToPath(
      new URL("./child-process.ts", import.meta.url),
    );
    const { stdout } = await spawn(
      process.execPath,
      ["--import", "tsx", script],
      {
        env: {
          ...process.env,
          FORGE_DATABASE_URL: databaseUrl,
          FORGE_REDIS_URL: redisUrl,
          FORGE_QUEUE_NAME: `forge-child-${namespaces}`,
          FORGE_TEST_MODE: mode,
          ...(options.workflow === undefined
            ? {}
            : { FORGE_TEST_WORKFLOW: options.workflow }),
          ...(options.runId === undefined
            ? {}
            : { FORGE_TEST_RUN_ID: options.runId }),
          ...(options.ttlMs === undefined
            ? {}
            : { FORGE_TEST_TTL_MS: String(options.ttlMs) }),
          ...(options.text === undefined
            ? {}
            : { FORGE_TEST_TEXT: options.text }),
          ...(options.arm === undefined ? {} : { FORGE_TEST_ARM: options.arm }),
        },
      },
    );
    return JSON.parse(stdout) as ChildReport;
  }

  const parkInAnotherProcess = (ttlMs?: number) =>
    inAnotherProcess("park", ttlMs === undefined ? {} : { ttlMs });

  interface SecondProcess {
    readonly stack: DurableStack;
    /** What the sink was actually asked to do, in order. */
    readonly acted: JsonValue[];
    readonly resumed: (RunRecord | undefined)[];
    /** How many times this process asked a model. */
    readonly providerCalls: () => number;
    readonly host: RunHost;
  }

  /** Process two: a fresh stack, sharing nothing but Postgres and Redis. */
  async function secondProcess(
    overrides: Partial<DurableStackOptions> = {},
  ): Promise<SecondProcess> {
    namespaces += 1;
    const acted: JsonValue[] = [];
    const resumed: (RunRecord | undefined)[] = [];
    // A model that would answer differently, and an arm that would route
    // elsewhere. Neither may be reached for a node that already answered.
    const agent = countingProvider(DRAFT_TWO);
    const stack = await createDurableStack({
      databaseUrl,
      redisUrl,
      queueName: `forge-worker-${namespaces}`,
      ...RESTART_STACK_OPTIONS,
      transforms: restartTransforms(),
      provider: agent.provider,
      branchFor: () => "hold",
      effects: {
        async perform(_runId, _nodeId, _effect, input) {
          acted.push(input ?? null);
          return PUBLISHED;
        },
      },
      ...overrides,
    });
    stacks.push(stack);

    return {
      stack,
      acted,
      resumed,
      providerCalls: agent.calls,
      host: {
        async execute() {
          throw new Error("this proof never starts a run from the queue");
        },
        async resume(runId) {
          const run = await stack.resume(runId);
          resumed.push(run);
          return run?.status ?? "unknown";
        },
        async cancel() {},
      },
    };
  }

  async function consume(second: SecondProcess): Promise<void> {
    await createWorkerConsumer({
      queue: second.stack.queue,
      host: second.host,
      observability: createMemoryObservability(),
    }).start();
  }

  /** Approves the run's one open gate, from the process doing the approving. */
  async function approve(
    second: SecondProcess,
    runId: string,
  ): Promise<string> {
    const pending = (await second.stack.approvals.getPending(runId))[0];
    if (pending === undefined) throw new Error("the gate should be pending");
    await second.stack.approvals.decide(
      pending.approvalId,
      { kind: "approve" },
      "operator",
    );
    return pending.approvalId;
  }

  test(
    "the gate is decided and the run completes after the starting process is gone",
    async () => {
      const parked = await parkInAnotherProcess();
      expect(parked.status).toBe("AWAITING_APPROVAL");

      const second = await secondProcess();

      // What process one pinned, read back from Postgres by a process that
      // never saw it computed.
      const before = await second.stack.checkpoints.listByRun(parked.runId);
      expect(before.at(-1)?.stepId).toBe("publish");
      expect(before.at(-1)?.values).toEqual({
        intake: RESTART_PAYLOAD,
        prepare: PREPARED,
      });
      expect(await second.stack.dispatched(parked.runId)).toEqual([]);

      // The human decides, here, in the second process.
      const approvalId = await approve(second, parked.runId);

      // The resume travels over Redis to a worker, as it would in production.
      await consume(second);
      await second.stack.queue.enqueue({
        type: "workflow.resume",
        runId: parked.runId,
        approvalId,
        attempt: 2,
      });

      await waitFor("the run to finish", async () => {
        return second.resumed.length === 1;
      });

      expect(second.resumed[0]).toMatchObject({
        status: "SUCCEEDED",
        result: PUBLISHED,
      });

      // Exactly the effect that was approved, exactly once, on exactly the
      // value pinned before parking.
      expect(second.acted).toEqual([PREPARED]);
      const ledger = await second.stack.dispatched(parked.runId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        nodeId: "publish",
        effect: "prod.write",
        input: PREPARED,
        output: PUBLISHED,
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an agent before the gate resumes across a restart without asking the model again",
    async () => {
      /**
       * The case the previous design had to refuse outright.
       *
       * Process one runs the agent, takes the `publish-it` arm and parks.
       * Process two would answer `drafted by process two` and would route to
       * `hold` — so if either the value ledger or the route ledger failed to
       * survive, this test would either dispatch the wrong text or dispatch
       * nothing at all. The provider count is asserted on both sides, and the
       * total across the two processes must be one.
       */
      const parked = await inAnotherProcess("park", {
        workflow: "agent",
        text: DRAFT_ONE,
        arm: "publish-it",
      });
      expect(parked.status).toBe("AWAITING_APPROVAL");
      expect(parked.providerCalls).toBe(1);

      const second = await secondProcess();
      const approvalId = await approve(second, parked.runId);

      await consume(second);
      await second.stack.queue.enqueue({
        type: "workflow.resume",
        runId: parked.runId,
        approvalId,
        attempt: 2,
      });
      await waitFor("the run to finish", async () => {
        return second.resumed.length === 1;
      });

      expect(second.resumed[0]).toMatchObject({
        status: "SUCCEEDED",
        result: PUBLISHED,
      });
      // The value the approver saw, not one computed on resume.
      expect(second.acted).toEqual([DRAFT_ONE]);
      expect(await second.stack.dispatched(parked.runId)).toMatchObject([
        { nodeId: "publish", effect: "prod.write", input: DRAFT_ONE },
      ]);

      // One model call, in total, across both processes.
      expect(second.providerCalls()).toBe(0);
      expect(parked.providerCalls + second.providerCalls()).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "neither process that touches an agent run is the one that ran the model twice",
    async () => {
      // The same claim with the deciding half in a real process too: this test
      // process only writes the decision, and the run is driven by a second
      // `node` that has its own module graph and its own everything.
      const parked = await inAnotherProcess("park", {
        workflow: "agent",
        text: DRAFT_ONE,
        arm: "publish-it",
      });
      const second = await secondProcess();
      await approve(second, parked.runId);

      const driver = await inAnotherProcess("resume", {
        runId: parked.runId,
        workflow: "agent",
        text: DRAFT_TWO,
        arm: "hold",
      });

      expect(driver).toMatchObject({ status: "SUCCEEDED", providerCalls: 0 });
      expect(driver.dispatched).toEqual([DRAFT_ONE]);
      expect(parked.providerCalls + driver.providerCalls).toBe(1);
      expect(await second.stack.dispatched(parked.runId)).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a second process that computes different data still dispatches what was pinned",
    async () => {
      // The failure this whole design exists to prevent, approached from the
      // other side: the resuming process is *made* to disagree, and the action
      // still has to be the one the approver saw. The old design refused this
      // run; nothing is recomputed now, so it completes.
      const parked = await parkInAnotherProcess();
      const second = await secondProcess({
        transforms: restartTransforms("drifted"),
      });
      const approvalId = await approve(second, parked.runId);

      await consume(second);
      await second.stack.queue.enqueue({
        type: "workflow.resume",
        runId: parked.runId,
        approvalId,
        attempt: 2,
      });
      await waitFor("the run to finish", async () => {
        return second.resumed.length === 1;
      });

      expect(second.resumed[0]).toMatchObject({ status: "SUCCEEDED" });
      expect(second.acted).toEqual([PREPARED]);
      expect((await second.stack.dispatched(parked.runId))[0]?.input).toEqual(
        PREPARED,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a dispatch whose process died before the record caught up is not repeated",
    async () => {
      /**
       * The sharpest form of exactly-once across processes, and the one the
       * test below cannot make on its own: there, the run is already
       * SUCCEEDED, so a redelivered resume returns early and never reaches the
       * tool at all. Passing that proves the status short-circuit works, not
       * that the ledger does.
       *
       * Here the ledger is the only thing standing in the way. A worker
       * claimed the dispatch, performed it, pinned what it produced — and then
       * died before the run record moved off `AWAITING_APPROVAL`. A second
       * process therefore walks all the way to the tool node with a run that
       * still looks undispatched. It must find the row and act on nothing.
       */
      const parked = await parkInAnotherProcess();
      const second = await secondProcess();
      await second.stack.runs.claimEffect({
        runId: parked.runId,
        nodeId: "publish",
        effect: "prod.write",
        input: PREPARED,
        at: "2026-08-04T00:00:00.000Z",
      });
      await second.stack.runs.pinValue(parked.runId, "publish", PUBLISHED);
      await approve(second, parked.runId);

      const driver = await inAnotherProcess("resume", {
        runId: parked.runId,
      });

      expect(driver).toMatchObject({ status: "SUCCEEDED" });
      // A whole other process, walking a run that had not been marked done,
      // and it performed nothing.
      expect(driver.dispatched).toEqual([]);
      expect(await second.stack.dispatched(parked.runId)).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the effect ledger outlives the process that dispatched, so a later resume does not act again",
    async () => {
      // The process that dispatched is *gone* before the second resume runs.
      // Its run is terminal by then, so what this proves is that re-entering a
      // finished run reports it rather than walking it; the test above is the
      // one that pins the ledger itself.
      const parked = await parkInAnotherProcess();
      const second = await secondProcess();
      const approvalId = await approve(second, parked.runId);

      const dispatcher = await inAnotherProcess("resume", {
        runId: parked.runId,
      });
      expect(dispatcher).toMatchObject({ status: "SUCCEEDED" });
      expect(dispatcher.dispatched).toEqual([PREPARED]);
      expect(await second.stack.dispatched(parked.runId)).toHaveLength(1);

      // A redelivery reaching a different process, after the first one ended.
      await consume(second);
      await second.stack.queue.enqueue({
        type: "workflow.resume",
        runId: parked.runId,
        approvalId,
        attempt: 3,
      });
      await waitFor("the redelivered resume", async () => {
        return second.resumed.length === 1;
      });

      // Suppressed, not crashed: the run is already terminal and re-entering
      // it reports that, rather than walking it again.
      expect(second.resumed[0]).toMatchObject({ status: "SUCCEEDED" });
      expect(second.acted).toEqual([]);
      expect(await second.stack.dispatched(parked.runId)).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the same resume operation delivered twice is handled once",
    async () => {
      const parked = await parkInAnotherProcess();
      const second = await secondProcess();
      const approvalId = await approve(second, parked.runId);

      await consume(second);
      const job = {
        type: "workflow.resume",
        runId: parked.runId,
        approvalId,
        attempt: 2,
      } as const;
      // `operationKey()` is the same for both, so the transport must not hand
      // the second one over at all.
      await second.stack.queue.enqueue(job);
      await second.stack.queue.enqueue({ ...job, attempt: 9 });

      await waitFor("the resume", async () => {
        return second.resumed.length === 1;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(second.resumed).toHaveLength(1);
      expect(second.acted).toEqual([PREPARED]);
      expect(await second.stack.dispatched(parked.runId)).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a rejected gate authorises nothing on resume",
    async () => {
      const parked = await parkInAnotherProcess();
      const second = await secondProcess();
      const pending = (
        await second.stack.approvals.getPending(parked.runId)
      )[0];
      if (pending === undefined) throw new Error("the gate should be pending");
      await second.stack.approvals.decide(
        pending.approvalId,
        { kind: "reject", reason: "not this one" },
        "operator",
      );

      const run = await second.stack.resume(parked.runId);

      expect(run).toMatchObject({
        status: "FAILED",
        error: `Approval ${pending.approvalId} was REJECTED, which authorises nothing.`,
      });
      expect(second.acted).toEqual([]);
      expect(await second.stack.dispatched(parked.runId)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a gate decided after it expired is not a slow yes",
    async () => {
      // The runtime enforces this on the path it owns. A control plane in
      // another process writes the decision straight to the store, so the
      // deadline has to be re-checked where the dispatch is authorised.
      const parked = await parkInAnotherProcess(1);
      const second = await secondProcess();
      const pending = (
        await second.stack.approvals.getPending(parked.runId)
      )[0];
      if (pending === undefined) throw new Error("the gate should be pending");
      const decided = await second.stack.approvals.decide(
        pending.approvalId,
        { kind: "approve" },
        "operator",
      );
      expect((decided?.decidedAt ?? "") > pending.expiresAt).toBe(true);

      const run = await second.stack.resume(parked.runId);

      expect(run).toMatchObject({
        status: "FAILED",
        error: `Approval ${pending.approvalId} was not decided within its deadline.`,
      });
      expect(await second.stack.dispatched(parked.runId)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an undecided gate is waited on, not walked past",
    async () => {
      const parked = await parkInAnotherProcess();
      const second = await secondProcess();

      const run = await second.stack.resume(parked.runId);

      expect(run).toMatchObject({ status: "AWAITING_APPROVAL" });
      expect(await second.stack.dispatched(parked.runId)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a run nobody started is nothing to resume",
    async () => {
      const second = await secondProcess();

      expect(await second.stack.resume("run_never_started")).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a run started elsewhere is readable and cancellable here",
    async () => {
      // The two calls `apps/api` could not make after a restart: the record
      // 404'd, and cancelling threw "Unknown run".
      const parked = await parkInAnotherProcess();
      const second = await secondProcess();

      expect(await second.stack.runtime.loadRun(parked.runId)).toMatchObject({
        runId: parked.runId,
        status: "AWAITING_APPROVAL",
        workflowId: "durable.restart",
      });
      expect(await second.stack.runtime.cancel(parked.runId)).toMatchObject({
        status: "CANCELLED",
      });

      // Cancelled is durable too: a third process sees it.
      const third = await secondProcess();
      expect(await third.stack.runtime.loadRun(parked.runId)).toMatchObject({
        status: "CANCELLED",
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a run started and decided in one process is still recorded durably",
    async () => {
      // The default wiring: no effect sink supplied, so the stack's own one is
      // used. It performs nothing, which is exactly why the ledger row is the
      // only evidence that the gated action was reached and authorised.
      namespaces += 1;
      const only = await createDurableStack({
        databaseUrl,
        redisUrl,
        queueName: `forge-default-${namespaces}`,
        ...RESTART_STACK_OPTIONS,
        transforms: restartTransforms(),
      });
      stacks.push(only);

      expect(await only.dispatched("run_never_started")).toEqual([]);

      const run = await only.runtime.start({
        artifact: compile(RESTART_WORKFLOW),
        payload: RESTART_PAYLOAD,
      });
      const pending = (await only.approvals.getPending(run.runId))[0];
      if (pending === undefined) throw new Error("the gate should be pending");
      const finished = await only.runtime.decide(
        pending.approvalId,
        { kind: "approve" },
        "operator",
      );

      // The action was authorised, dispatched and recorded — and then the
      // output node had nothing to read, because this sink produces nothing.
      // Fail closed: the run stops rather than reporting a result nobody made.
      expect(finished).toMatchObject({
        status: "FAILED",
        error: "done: Node 'publish' produced no value to read.",
      });
      expect(await only.dispatched(run.runId)).toMatchObject([
        { nodeId: "publish", effect: "prod.write", input: PREPARED },
      ]);
      // Absent, not an invented empty one.
      expect((await only.dispatched(run.runId))[0]?.output).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  test("the two fixtures are distinct sealed artifacts", () => {
    // A shared fingerprint would mean the agent proof was silently running the
    // transform workflow, and passing for the wrong reason.
    expect(new Set(fingerprints).size).toBe(2);
  });
});
