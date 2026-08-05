import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { compileToArtifact } from "@forge/composition";
import {
  createDurableStack,
  type DurableStack,
  type DurableStackOptions,
  type ResumeOutcome,
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
 * ledger, its effect ledger and its connection pool go with it. A second
 * process decides the gate, a `workflow.resume` job travels over Redis, and a
 * worker in that second process drives the run to completion.
 *
 * The assertions are about *what* was dispatched, not that something was: the
 * effect ledger records the input the action was performed on, and it has to
 * equal the value the first process pinned before it parked. A resume that
 * recomputed would show a different one, and there is a test below that turns
 * that on deliberately to prove the guard fires.
 */

const POSTGRES_IMAGE = "postgres:16-alpine";
const REDIS_IMAGE = "redis:7-alpine";
const CONTAINER_START_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 60_000;

const PREPARED = { ...RESTART_PAYLOAD, plan: "stable" };
const PUBLISHED = RESTART_PUBLISHED;

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

  const compiled = compileToArtifact(RESTART_WORKFLOW);
  if (!compiled.ok) {
    throw new Error(
      `the restart fixture must compile: ${JSON.stringify(compiled.diagnostics)}`,
    );
  }
  const artifact = compiled.artifact;

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
    readonly kind?: string;
    readonly dispatched?: readonly JsonValue[];
  }

  /**
   * A whole other process. `execFile` resolves when the child has exited, so
   * by the time this returns there is nothing of it left to help — no runtime,
   * no value ledger, no in-process record of what it dispatched.
   */
  async function inAnotherProcess(
    mode: "park" | "resume",
    runId?: string,
    ttlMs?: number,
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
          ...(runId === undefined ? {} : { FORGE_TEST_RUN_ID: runId }),
          ...(ttlMs === undefined ? {} : { FORGE_TEST_TTL_MS: String(ttlMs) }),
        },
      },
    );
    return JSON.parse(stdout) as ChildReport;
  }

  const parkInAnotherProcess = (ttlMs?: number) =>
    inAnotherProcess("park", undefined, ttlMs);

  interface SecondProcess {
    readonly stack: DurableStack;
    /** What the sink was actually asked to do, in order. */
    readonly acted: JsonValue[];
    readonly outcomes: ResumeOutcome[];
    readonly host: RunHost;
  }

  /** Process two: a fresh stack, sharing nothing but Postgres and Redis. */
  async function secondProcess(
    overrides: Partial<DurableStackOptions> = {},
  ): Promise<SecondProcess> {
    namespaces += 1;
    const acted: JsonValue[] = [];
    const outcomes: ResumeOutcome[] = [];
    const stack = await createDurableStack({
      databaseUrl,
      redisUrl,
      queueName: `forge-worker-${namespaces}`,
      ...RESTART_STACK_OPTIONS,
      transforms: restartTransforms(),
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
      outcomes,
      host: {
        async execute() {
          throw new Error("this proof never starts a run from the queue");
        },
        async resume(runId) {
          const outcome = await stack.resume({ runId, artifact });
          outcomes.push(outcome);
          return outcome.kind === "resumed" ? outcome.run.status : outcome.kind;
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
      const pending = (
        await second.stack.approvals.getPending(parked.runId)
      )[0];
      if (pending === undefined) throw new Error("the gate should be pending");
      expect(pending.effect).toBe("prod.write");
      await second.stack.approvals.decide(
        pending.approvalId,
        { kind: "approve" },
        "operator",
      );

      // The resume travels over Redis to a worker, as it would in production.
      await consume(second);
      await second.stack.queue.enqueue({
        type: "workflow.resume",
        runId: parked.runId,
        approvalId: pending.approvalId,
        attempt: 2,
      });

      await waitFor("the run to finish", async () => {
        return second.outcomes.length === 1;
      });

      expect(second.outcomes[0]).toMatchObject({
        kind: "resumed",
        run: { status: "SUCCEEDED", result: PUBLISHED },
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
    "the effect ledger outlives the process that dispatched, so a later resume does not act again",
    async () => {
      // The one that matters, and the one an in-process Set passes by
      // accident: the process that dispatched is *gone* before the second
      // resume runs. Nothing but the row in Postgres can stop it.
      const parked = await parkInAnotherProcess();
      const second = await secondProcess();
      const pending = (
        await second.stack.approvals.getPending(parked.runId)
      )[0];
      if (pending === undefined) throw new Error("the gate should be pending");
      await second.stack.approvals.decide(
        pending.approvalId,
        { kind: "approve" },
        "operator",
      );

      const dispatcher = await inAnotherProcess("resume", parked.runId);
      expect(dispatcher).toMatchObject({
        kind: "resumed",
        status: "SUCCEEDED",
      });
      expect(dispatcher.dispatched).toEqual([PREPARED]);
      expect(await second.stack.dispatched(parked.runId)).toHaveLength(1);

      // A redelivery reaching a different process, after the first one ended.
      await consume(second);
      await second.stack.queue.enqueue({
        type: "workflow.resume",
        runId: parked.runId,
        approvalId: pending.approvalId,
        attempt: 3,
      });
      await waitFor("the redelivered resume", async () => {
        return second.outcomes.length === 1;
      });

      // Suppressed, not crashed: the ledger hands back what the first
      // dispatch produced, so the run still completes on the same data. A
      // resume that threw on the duplicate would also leave one row, and
      // would be a very different thing.
      expect(second.outcomes[0]).toMatchObject({
        kind: "resumed",
        run: { status: "SUCCEEDED", result: PUBLISHED },
      });
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
      const pending = (
        await second.stack.approvals.getPending(parked.runId)
      )[0];
      if (pending === undefined) throw new Error("the gate should be pending");
      await second.stack.approvals.decide(
        pending.approvalId,
        { kind: "approve" },
        "operator",
      );

      await consume(second);
      const job = {
        type: "workflow.resume",
        runId: parked.runId,
        approvalId: pending.approvalId,
        attempt: 2,
      } as const;
      // `operationKey()` is the same for both, so the transport must not hand
      // the second one over at all.
      await second.stack.queue.enqueue(job);
      await second.stack.queue.enqueue({ ...job, attempt: 9 });

      await waitFor("the resume", async () => {
        return second.outcomes.length === 1;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(second.outcomes).toHaveLength(1);
      expect(second.acted).toEqual([PREPARED]);
      expect(await second.stack.dispatched(parked.runId)).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a resume that does not reproduce the pinned values dispatches nothing",
    async () => {
      // The failure this whole design exists to prevent: the second process
      // recomputes instead of restoring, and would otherwise perform an action
      // on data the approver never saw.
      const parked = await parkInAnotherProcess();
      const second = await secondProcess({
        transforms: restartTransforms("drifted"),
      });
      const pending = (
        await second.stack.approvals.getPending(parked.runId)
      )[0];
      if (pending === undefined) throw new Error("the gate should be pending");
      await second.stack.approvals.decide(
        pending.approvalId,
        { kind: "approve" },
        "operator",
      );

      const outcome = await second.stack.resume({
        runId: parked.runId,
        artifact,
      });

      expect(outcome).toEqual({
        kind: "refused",
        reason:
          "the resumed walk did not reproduce the state the gate was decided on",
      });
      expect(second.acted).toEqual([]);
      expect(await second.stack.dispatched(parked.runId)).toEqual([]);
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

      const outcome = await second.stack.resume({
        runId: parked.runId,
        artifact,
      });

      expect(outcome).toEqual({
        kind: "refused",
        reason: "the gate was REJECTED, which authorises nothing",
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

      const outcome = await second.stack.resume({
        runId: parked.runId,
        artifact,
      });

      expect(outcome).toEqual({
        kind: "refused",
        reason: `approval ${pending.approvalId} was decided after it expired`,
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

      const outcome = await second.stack.resume({
        runId: parked.runId,
        artifact,
      });

      expect(outcome).toEqual({
        kind: "waiting",
        reason: "the gate for this action has not been decided",
      });
      expect(await second.stack.dispatched(parked.runId)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a run nobody started is nothing to resume",
    async () => {
      const second = await secondProcess();

      expect(
        await second.stack.resume({ runId: "run_never_started", artifact }),
      ).toEqual({
        kind: "waiting",
        reason: "the run has written no checkpoint, so it never reached a gate",
      });
    },
    TEST_TIMEOUT_MS,
  );
});
