import { compileToArtifact } from "@forge/composition";
import {
  createDurableStack,
  type DurableStack,
} from "@forge/composition/durable";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { call, settle, startRun } from "../src/api.js";
import {
  CONTAINER_START_TIMEOUT_MS,
  drop,
  freePort,
  type PinnedContainer,
  restore,
  sleep,
  startPostgres,
  startRedis,
  waitFor,
} from "../src/docker.js";
import { Inspector } from "../src/inspect.js";
import {
  type Api,
  type Backing,
  killAll,
  OPERATORS,
  parkInAnotherProcess,
  resumeInProcess,
  startApi,
  startHarnessWorker,
  startWorker,
} from "../src/processes.js";
import { GATED, PAYLOAD, SLOW } from "../src/workflows.js";

/**
 * Six ways to break a run in flight, and the three things that must survive
 * all of them.
 *
 * **No double dispatch.** **No lost run.** **No effect without its approval.**
 * Not "it recovered gracefully" — a graceful recovery that performed the
 * customer-visible action twice is the failure this system exists to prevent,
 * and it would read as a pass to anyone asserting on status alone.
 *
 * Every scenario below asserts, before it asserts anything else, that the
 * attack actually landed in the window it claims: the state left behind after
 * the kill is checked directly in Postgres, because "the run recovered" is
 * equally true of a kill that arrived after the work was already done. That is
 * the trap this repository has already fallen into once — a double-dispatch
 * test that drove the run terminal first, so the redelivered job short-circuited
 * and never reached the node it was guarding.
 */

const APPROVER = "marketing-lead@harness.test";

let postgres: PinnedContainer;
let redis: PinnedContainer;
let inspector: Inspector;
let queues = 0;
const stacks: DurableStack[] = [];

const backingFor = (prefix: string): Backing => {
  queues += 1;
  return {
    databaseUrl: postgres.url,
    redisUrl: redis.url,
    queueName: `forge-${prefix}-${queues}`,
  };
};

/**
 * A control plane in the test process: it writes decisions and enqueues work,
 * and it never subscribes. Whatever drives a run in these scenarios is always
 * a different process, so nothing here can be explained by state this one is
 * still holding.
 */
async function controlPlane(backing: Backing): Promise<DurableStack> {
  const stack = await createDurableStack({
    databaseUrl: backing.databaseUrl,
    redisUrl: backing.redisUrl,
    queueName: backing.queueName,
    environment: "production",
  });
  stacks.push(stack);
  return stack;
}

const artifactOf = (source: unknown) => {
  const compiled = compileToArtifact(source);
  if (!compiled.ok) {
    throw new Error(`fixture: ${JSON.stringify(compiled.diagnostics)}`);
  }
  return compiled.artifact;
};

/** Postgres accepting connections again, on the address it left. */
async function postgresBack(): Promise<void> {
  await waitFor(
    "Postgres to accept connections again",
    async () => {
      const probe = new Inspector(postgres.url);
      try {
        await probe.totalEffects();
        return true;
      } catch {
        return false;
      } finally {
        await probe.close().catch(() => {});
      }
    },
    60_000,
    200,
  );
}

beforeAll(async () => {
  const [pgPort, redisPort] = await Promise.all([freePort(), freePort()]);
  [postgres, redis] = await Promise.all([
    startPostgres(pgPort),
    startRedis(redisPort),
  ]);
  inspector = new Inspector(postgres.url);
}, CONTAINER_START_TIMEOUT_MS);

afterAll(async () => {
  killAll();
  await Promise.all(
    stacks.splice(0).map((stack) => stack.close().catch(() => {})),
  );
  await inspector?.close();
  await Promise.all([postgres?.container.stop(), redis?.container.stop()]);
});

/* ========================================================================== */

describe("a worker killed between the durable claim and the action", () => {
  /**
   * The sharpest window in the system, and the one the runtime documents a
   * deliberate choice about: the claim row is written *before* the action, so a
   * crash in between loses an effect rather than performing one twice.
   *
   * These two tests are what that choice costs, measured. The harness sink
   * announces itself before it acts and then never returns, so the process can
   * be killed at a named instant — the only way to be inside a window that is
   * otherwise microseconds wide.
   */

  async function killMidDispatch(
    workflow: "chained" | "gated",
  ): Promise<{ backing: Backing; runId: string; approvalId: string }> {
    const backing = backingFor(`claim-${workflow}`);
    const control = await controlPlane(backing);

    const parked = await parkInAnotherProcess(backing, { workflow });
    expect(parked.status).toBe("AWAITING_APPROVAL");
    const approvalId = parked.pendingApprovalId as string;

    const victim = await startHarnessWorker({
      ...backing,
      hangOnDispatch: true,
      label: "victim",
    });

    // A decision written by a control plane that is not the worker, which is
    // all a second process can do.
    await control.approvals.decide(approvalId, { kind: "approve" }, APPROVER);
    await control.queue.enqueue({
      type: "workflow.resume",
      runId: parked.runId,
      approvalId,
      attempt: 2,
    });

    const about = await victim.dispatching();
    expect(about).toMatchObject({ runId: parked.runId, nodeId: "publish" });
    await victim.kill();
    // It announced the dispatch and never performed one: the kill landed
    // between the claim and the act, not after it.
    expect(victim.performed).toEqual([]);

    return { backing, runId: parked.runId, approvalId };
  }

  test("the claim is durable and the action is not — the attack landed in the window", async () => {
    const { runId } = await killMidDispatch("chained");

    // Proof, from the database rather than from the test's own timing: the
    // claim row exists and the value row does not. Nothing else produces that
    // pair. A kill a millisecond later would have both.
    const effects = await inspector.effects(runId);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      nodeId: "publish",
      effect: "slack.post",
      input: PAYLOAD.body,
    });
    expect(
      (await inspector.values(runId)).map((row) => row.nodeId),
    ).not.toContain("publish");
    expect(await inspector.claimedButUnperformed()).toContain(runId);

    // The run is not lost: it is readable, at RUNNING, with the human's
    // decision recorded against it.
    expect(await inspector.record(runId)).toMatchObject({ status: "RUNNING" });
    expect(await inspector.approvals(runId)).toMatchObject([
      { status: "APPROVED" },
    ]);
  });

  test("a redrive does not perform the lost action a second time", async () => {
    const { backing, runId } = await killMidDispatch("chained");

    // The only redrive there is: a fresh process re-entering the run. The
    // queue cannot deliver the resume again — see the test below.
    const redrive = await resumeInProcess(backing, { runId, label: "redrive" });

    // **No double dispatch.** The ledger row the dead worker wrote is the only
    // thing standing here, and it holds.
    expect(redrive.performed).toEqual([]);
    expect(await inspector.effects(runId)).toHaveLength(1);

    // And the run fails closed rather than reporting a result nobody produced,
    // because `done` reads what `publish` was supposed to make.
    expect(redrive.status).toBe("FAILED");
    expect(String(redrive.error)).toContain("produced no value to read");
  });

  test("FINDING: a workflow that does not read the effect's output reports SUCCEEDED having performed nothing", async () => {
    /**
     * The same crash, on a workflow whose output node reads nothing. Nothing
     * downstream notices the missing value, so the run completes and its record
     * names `publish` in `performedEffects` — an action no sink was ever asked
     * to carry out.
     *
     * This assertion documents current behaviour, not desired behaviour. It is
     * written as a live assertion rather than a comment so that the day the
     * product closes the hole, this goes red and someone has to come and read
     * the reasoning.
     *
     * Half closed since it was written. The signal this asked for exists —
     * `GET /v1/effects/unsettled` — and so does the recovery, a gated redrive,
     * both exercised two tests below on this same lost effect. What is still
     * true, and is why this stays red-in-waiting, is the part above: the run
     * *reports* SUCCEEDED with `publish` in `performedEffects` while no sink
     * was ever asked to act. An operator who reads the run and not the report
     * still sees a lie.
     */
    const { backing, runId } = await killMidDispatch("gated");

    const redrive = await resumeInProcess(backing, { runId, label: "redrive" });

    expect(redrive.performed).toEqual([]);
    expect(await inspector.effects(runId)).toHaveLength(1);
    expect(redrive.status).toBe("SUCCEEDED");
    expect(await inspector.record(runId)).toMatchObject({
      status: "SUCCEEDED",
      performedEffects: ["publish"],
    });
    // The signature is still there for anyone who looks.
    expect(await inspector.claimedButUnperformed()).toContain(runId);
  });

  test("the operator's report names the run, and the redrive gate asks before acting", async () => {
    /**
     * The recovery, end to end, on an effect that was genuinely lost — not one
     * a test staged by writing a claim row. A worker was killed between the
     * durable claim and the action; nothing else knows the difference between
     * that and an action that landed and lost its acknowledgement, which is
     * exactly why performing it again is a decision rather than a retry.
     *
     * Through the real routes, in a process that never saw the loss.
     */
    const { backing, runId } = await killMidDispatch("gated");
    // Let the run finish as it would have. This is how a lost effect is
    // actually met: not mid-flight, but afterwards, on a run that reported
    // SUCCEEDED — which is exactly what makes it worth a report at all.
    await resumeInProcess(backing, { runId, label: "finish" });
    const operatorApi = await startApi(backing);

    const unsettled = await call(
      operatorApi,
      "GET",
      "/v1/effects/unsettled",
      "marketing-lead",
    );
    expect(unsettled.status).toBe(200);
    expect(
      (unsettled.body.unsettled as { runId: string; nodeId: string }[]).filter(
        (entry) => entry.runId === runId,
      ),
    ).toMatchObject([{ nodeId: "publish", effect: "slack.post" }]);

    const requested = await call(
      operatorApi,
      "POST",
      `/v1/runs/${runId}/effects/publish/redrive`,
      "marketing-lead",
    );
    expect(`${requested.status} ${JSON.stringify(requested.body)}`).toContain(
      "202",
    );
    expect(requested.body.status).toBe("AWAITING_APPROVAL");

    // Asking is not doing: the action is still unaccounted for, and the
    // ledger still holds exactly the one row the dead worker wrote.
    expect(await inspector.unsettled()).toContain(runId);
    expect(await inspector.effects(runId)).toHaveLength(1);
  });

  test("approving the redrive performs the lost action, once, and accounts for it", async () => {
    /**
     * The recovery, end to end, through the real routes, on an effect that was
     * genuinely lost — a worker killed between the durable claim and the
     * action, not a claim row a test wrote.
     *
     * The run is allowed to finish first, because that is how a lost effect is
     * actually met: not mid-flight, but afterwards, on a run that reported
     * SUCCEEDED. That is also the case the first implementation got wrong —
     * re-entering a terminal run replays its pinned output and never reaches
     * the node — so this is the shape that matters.
     */
    const { backing, runId } = await killMidDispatch("gated");
    await resumeInProcess(backing, { runId, label: "finish" });
    const operatorApi = await startApi(backing);

    const requested = await call(
      operatorApi,
      "POST",
      `/v1/runs/${runId}/effects/publish/redrive`,
      "marketing-lead",
    );
    const approvalId = requested.body.pendingApprovalId as string;

    const decided = await call(
      operatorApi,
      "POST",
      `/v1/runs/${runId}/approvals/${approvalId}/decision`,
      "marketing-lead",
      { decision: "approve" },
    );
    expect(`${decided.status} ${JSON.stringify(decided.body)}`).toContain(
      "202",
    );

    /**
     * Waited for on the thing under test.
     *
     * Not on `settle()`, which counts `AWAITING_APPROVAL` as settled and so
     * returns the instant it is called on a run already at a gate — having
     * waited for a state the run never left. This test failed on that for a
     * while, and the failure looked exactly like a product defect: the run
     * still at its gate, the claim still unsettled, the approved action
     * apparently lost. It was an assertion running before the enqueued resume
     * had done anything.
     */
    await waitFor(
      "the redriven action to be accounted for",
      async () =>
        JSON.stringify(await inspector.settlement(runId)).includes(
          '"settled_at":"20',
        ),
      60_000,
      100,
    );

    // One row, and one only. Two would mean the recovery had become the
    // failure it recovers from.
    const effects = await inspector.effects(runId);
    expect(`redriven: ${JSON.stringify(effects)}`).toContain("publish");
    expect(effects).toHaveLength(1);

    // And the run is finished rather than left at the gate it was redriven
    // through.
    expect(await inspector.record(runId)).toMatchObject({
      status: "SUCCEEDED",
    });
    expect(await inspector.unsettled()).not.toContain(runId);
  });

  test("the queue will not deliver the resume again, so nothing redrives itself", async () => {
    const { backing, runId, approvalId } = await killMidDispatch("chained");
    const control = await controlPlane(backing);

    // A second worker on the same queue, and the same resume enqueued again.
    const successor = await startHarnessWorker({
      ...backing,
      label: "successor",
    });
    await control.queue.enqueue({
      type: "workflow.resume",
      runId,
      approvalId,
      attempt: 3,
    });
    await sleep(3_000);

    // Nothing. `operationKey` is `resume:<run>:<approval>` and the claim key
    // the dead worker set in Redis has no TTL, by design — an expiring key
    // would make a late redelivery act a second time. The cost, measured here,
    // is that a worker that dies holding a claim strands the run: there is no
    // automatic redrive, and no route that performs one.
    expect(successor.performed).toEqual([]);
    expect(await inspector.effects(runId)).toHaveLength(1);
    expect(await inspector.record(runId)).toMatchObject({ status: "RUNNING" });
  });
});

/* ========================================================================== */

describe("Postgres dropped mid-walk", () => {
  test("the walk stops, nothing is dispatched, and the run is still there afterwards", async () => {
    const backing = backingFor("pg-drop");
    const control = await controlPlane(backing);
    const worker = await startHarnessWorker({
      ...backing,
      transformDelayMs: 5_000,
      label: "pg-victim",
    });

    // Created, not walked — the control plane's half of the start path.
    const created = await control.runtime.create({
      artifact: artifactOf(SLOW),
      capabilities: ["slack.write"],
      payload: PAYLOAD,
    });
    await control.queue.enqueue({
      type: "workflow.execute",
      runId: created.runId,
      workflowVersionId: created.fingerprint,
      attempt: 1,
    });

    // Wait until the walk is *inside* a node, then take the database away.
    await waitFor(
      "the walk to enter the slow transform",
      () => worker.output().includes('"kind":"transforming"'),
      60_000,
      20,
    );
    await drop(postgres);
    // Long enough for the transform to finish and for its pin to fail.
    await sleep(8_000);
    await restore(postgres);
    await postgresBack();

    // The attack landed: the transform ran — its marker is on the worker's
    // stdout — and its value was never pinned, which can only happen if the
    // store was gone at that write.
    expect(worker.output()).toContain('"kind":"transforming"');
    const values = (await inspector.values(created.runId)).map(
      (row) => row.nodeId,
    );
    expect(values).toContain("intake");
    expect(values).not.toContain("prepare");

    // **No effect without its approval.** Nothing was dispatched and no gate
    // was even opened: the walk never reached the tool node.
    expect(await inspector.effects(created.runId)).toEqual([]);
    expect(await inspector.approvals(created.runId)).toEqual([]);

    // **No lost run.** The record is readable and re-enterable.
    expect(await inspector.record(created.runId)).toMatchObject({
      runId: created.runId,
      status: "RUNNING",
    });

    // And it recovers all the way, once. A fresh process re-walks the
    // unpinned transform, reaches the gate, and dispatches exactly one effect
    // on the value that gate was opened over.
    const toGate = await resumeInProcess(backing, {
      runId: created.runId,
      label: "recover",
      transformDelayMs: 0,
    });
    expect(toGate.status).toBe("AWAITING_APPROVAL");

    const gate = (await inspector.approvals(created.runId))[0];
    expect(gate).toMatchObject({ status: "PENDING" });
    await control.approvals.decide(
      gate?.approvalId as string,
      { kind: "approve" },
      APPROVER,
    );

    const finished = await resumeInProcess(backing, {
      runId: created.runId,
      label: "finish",
    });
    expect(finished.status).toBe("SUCCEEDED");
    expect(finished.performed).toEqual([PAYLOAD.body]);
    const effects = await inspector.effects(created.runId);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      nodeId: "publish",
      input: PAYLOAD.body,
    });
  });
});

/* ========================================================================== */

describe("Redis dropped between the decision and the resume", () => {
  /**
   * `POST …/decision` records the decision in Postgres and then enqueues a
   * resume. Dropping Redis in between is therefore a real window, and the
   * ordering the route documents — decision first, job second, because "a
   * decision with no job is a run an operator can see and re-drive" — is
   * exactly what this checks.
   */
  let api: Api;
  let backing: Backing;

  beforeAll(async () => {
    backing = backingFor("redis-drop");
    // No `apps/worker` here, deliberately: the control plane consumes the queue
    // it writes to, and adding a worker would drag in the stale-cache defect
    // the fleet block below isolates — this scenario would then fail for a
    // reason that has nothing to do with Redis.
    api = await startApi(backing);
  }, CONTAINER_START_TIMEOUT_MS);

  test("the decision is durable, no effect fires, and the resume lands exactly once when Redis returns", async () => {
    const started = await startRun(api, GATED, PAYLOAD);
    const runId = started.body.runId as string;
    const parked = await settle(api, runId);
    expect(parked.status).toBe("AWAITING_APPROVAL");
    const approvalId = parked.pendingApprovalId as string;

    await drop(redis);

    // The request may or may not come back; what matters is what it left in
    // Postgres. An abort here cancels this client's wait, not the server's
    // work — the handler runs to completion whenever Redis allows it.
    const control = new AbortController();
    const decision = fetch(
      `${api.baseUrl}/v1/runs/${runId}/approvals/${approvalId}/decision`,
      {
        method: "POST",
        signal: control.signal,
        headers: {
          authorization: `Bearer ${OPERATORS["marketing-lead"]}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ decision: "approve" }),
      },
    ).then(
      (response) => ({ settled: true as const, status: response.status }),
      () => ({ settled: false as const, status: 0 }),
    );
    let settled = false;
    let last: { settled: boolean; status: number } = {
      settled: false,
      status: -1,
    };
    const outcomeOf = () => last;
    void decision.then((result) => {
      settled = true;
      last = result;
    });

    const timeout = sleep(10_000).then(() => ({
      settled: false as const,
      status: -1,
    }));
    const outcome = await Promise.race([decision, timeout]);

    /**
     * FINDING, asserted so it cannot rot: the request does not come back.
     *
     * `queue-bullmq` builds every connection with `maxRetriesPerRequest: null`
     * — required for the blocking consumer — so a command issued while Redis is
     * unreachable is buffered by ioredis rather than rejected. There is no
     * deadline anywhere on the path, so the enqueue, and with it the operator's
     * HTTP request, waits for as long as the outage lasts. The day a timeout is
     * added this goes red, which is the point.
     */
    expect(outcome.settled).toBe(false);

    // The decision is durable even though the job is not: that ordering is
    // what makes the stranded run visible and re-drivable rather than lost.
    await waitFor(
      "the decision to be recorded",
      async () =>
        (await inspector.approvals(runId)).some(
          (approval) => approval.status === "APPROVED",
        ),
      10_000,
      100,
    );
    // **No effect without its approval**, and none *on* it either while the
    // transport is down: nothing has authorised a dispatch in a live process.
    expect(await inspector.effects(runId)).toEqual([]);
    expect(await inspector.record(runId)).toMatchObject({
      status: "AWAITING_APPROVAL",
    });

    await restore(redis);

    // The buffered enqueue flushes and the request finally comes back — with
    // a 202, so the job was accepted by Redis.
    await waitFor("the decision request to return", () => settled, 60_000, 100);
    expect(outcomeOf()).toMatchObject({ settled: true });

    /**
     * And then it is taken.
     *
     * This once hung forever: BullMQ emits `ioredis:close` when it has given
     * up reconnecting, so the worker was dead and nothing recreated it. The
     * process stayed up, answered health checks and consumed nothing — a Redis
     * blip became a permanently stalled queue. `queue-bullmq` now reattaches,
     * which is what makes an outage a pause rather than an ending.
     */
    await waitFor(
      "the run to finish once Redis is back",
      async () => (await inspector.record(runId))?.status === "SUCCEEDED",
      45_000,
      100,
    ).catch(async (error: unknown) => {
      const observer = await controlPlane(backing);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `queue depth (jobs waiting, nobody consuming) = ${await observer.queue.depth()}\n` +
          `record=${JSON.stringify(await inspector.record(runId))}\n` +
          `approvals=${JSON.stringify(await inspector.approvals(runId))}\n` +
          `effects=${JSON.stringify(await inspector.effects(runId))}`,
      );
    });
    const effects = await inspector.effects(runId);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      nodeId: "publish",
      input: PAYLOAD.body,
    });

    control.abort();
  });

  test("a process that cannot reach its queue does not report itself ready", async () => {
    /**
     * The operability half. `apps/worker` said it in its own source — "a green
     * probe on a process doing no work is worse than a red one" — and then
     * hard-coded `{ queue: "healthy", persistence: "healthy" }`, as did
     * `apps/api`. `QueuePort.health()` existed and nothing called it.
     *
     * The premise is no longer "a subscriber that never comes back", because
     * it does now. What remains true, and is what an on-call rotation actually
     * needs, is that a process reports unready *while* it cannot reach its
     * queue, and ready again once it can.
     */
    await drop(redis);
    try {
      await waitFor(
        "the probe to notice the queue is gone",
        async () => (await fetch(`${api.baseUrl}/health/ready`)).status === 503,
        20_000,
        200,
      );
    } finally {
      await restore(redis);
    }

    await waitFor(
      "the probe to recover once the queue is back",
      async () => (await fetch(`${api.baseUrl}/health/ready`)).status === 200,
      45_000,
      200,
    );
  });
});

/* ========================================================================== */

describe("a resume delivered twice", () => {
  test("the second delivery dispatches nothing further", async () => {
    // A separate deployment from the Redis block, whose control plane is left
    // with a dead consumer. The run here is terminal by the time the second
    // delivery arrives, so what this proves is the terminal short-circuit
    // rather than the ledger — the ledger is proved by the claim-window tests,
    // and that distinction is the one this repository's double-dispatch trap
    // turned on.
    const backing = backingFor("redelivery");
    const api = await startApi(backing);

    const started = await startRun(api, GATED, PAYLOAD);
    const runId = started.body.runId as string;
    const parked = await settle(api, runId);
    const approvalId = parked.pendingApprovalId as string;

    await call(
      api,
      "POST",
      `/v1/runs/${runId}/approvals/${approvalId}/decision`,
      "marketing-lead",
      { decision: "approve" },
    );
    await waitFor(
      "the run to finish",
      async () => (await inspector.record(runId))?.status === "SUCCEEDED",
      60_000,
      50,
    );
    const before = await inspector.effects(runId);
    expect(before).toHaveLength(1);

    const control = await controlPlane(backing);
    await control.queue.enqueue({
      type: "workflow.resume",
      runId,
      approvalId,
      attempt: 9,
    });
    await sleep(3_000);

    expect(await inspector.effects(runId)).toEqual(before);
  });
});

/* ========================================================================== */

describe("two workers racing one decided gate", () => {
  const ROUNDS = Number.parseInt(
    process.env.FORGE_CHAOS_RACE_ROUNDS ?? "6",
    10,
  );

  test("exactly one dispatch per round, and neither process always wins", async () => {
    const backing = backingFor("race");
    const control = await controlPlane(backing);
    const winners: string[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const parked = await parkInAnotherProcess(backing, {
        workflow: "chained",
      });
      expect(parked.status).toBe("AWAITING_APPROVAL");
      await control.approvals.decide(
        parked.pendingApprovalId as string,
        { kind: "approve" },
        APPROVER,
      );

      // Two processes, released on the same wall-clock instant. Each holds
      // the action open for 250ms, so the loser is guaranteed to be inside the
      // run while the winner is still performing.
      const startAtEpochMs = Date.now() + 1_500;
      const [left, right] = await Promise.all([
        resumeInProcess(backing, {
          runId: parked.runId,
          label: "left",
          startAtEpochMs,
          dispatchDelayMs: 250,
        }),
        resumeInProcess(backing, {
          runId: parked.runId,
          label: "right",
          startAtEpochMs,
          dispatchDelayMs: 250,
        }),
      ]);

      // They were in the run at the same time. Without this the round could
      // pass by two processes running one after the other, which is not a race.
      expect(`round ${round}: ${JSON.stringify([left, right])}`).toBeTruthy();
      expect(left.startedAt).toBeLessThan(right.finishedAt);
      expect(right.startedAt).toBeLessThan(left.finishedAt);

      // **No double dispatch**, at the ledger and at the sinks.
      const effects = await inspector.effects(parked.runId);
      expect(`round ${round}: ${JSON.stringify(effects)}`).toContain("publish");
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({
        nodeId: "publish",
        input: PAYLOAD.body,
      });

      const performed = [...left.performed, ...right.performed];
      expect(`round ${round}: ${JSON.stringify(performed)}`).toBeTruthy();
      expect(performed).toEqual([PAYLOAD.body]);

      /**
       * Neither process errored, and exactly one reports the finished run.
       *
       * The two do *not* agree on the status, and should not. The loser
       * discovers mid-walk that another process has advanced the run, steps
       * aside, and reports where the run stood at that moment — usually
       * `RUNNING`, because the winner is still inside its 250ms dispatch.
       * Waiting for the winner so both could say `SUCCEEDED` would be a poll
       * loop invented to tidy an assertion.
       *
       * What is deterministic, and is what matters: a loser that errored would
       * be a redelivery that dead-letters a healthy run, and a loser that
       * acted would be a double dispatch. Neither happens.
       */
      for (const process of [left, right]) {
        expect(
          `round ${round} ${process.label}: ${JSON.stringify(process)}`,
        ).toBeTruthy();
        expect(process.error).toBeUndefined();
      }
      expect([left.status, right.status]).toContain("SUCCEEDED");

      winners.push(left.performed.length === 1 ? "left" : "right");

      // The record must not contradict the ledger. Both processes write the
      // whole record with no version check, so a loser that finishes last can
      // overwrite the winner's outcome; if that happens this is where it shows.
      expect(
        `round ${round}: ${JSON.stringify(await inspector.record(parked.runId))}`,
      ).toContain('"status":"SUCCEEDED"');
    }

    /**
     * Which process wins is *not* asserted, and used to be.
     *
     * The old check required both labels to appear across six rounds, as
     * evidence the contention was real rather than two sequential resumes
     * wearing a race's clothes. That evidence is already here and is
     * deterministic: each round asserts the two processes' intervals overlap,
     * so both were demonstrably inside the run at once.
     *
     * Requiring both to win as well is a statistical claim about scheduling
     * that nothing promises and a fair coin fails one time in thirty-two. It
     * went red once the effect claim became the only thing deciding the
     * winner, because whichever process reaches Postgres first reaches it
     * first consistently. A test that fails on a property the system does not
     * offer teaches its readers to rerun it, which is the habit that hides the
     * next real failure.
     */
    expect(winners).toHaveLength(ROUNDS);
  });
});

/* ========================================================================== */

describe("a control plane and a worker fleet on one queue", () => {
  /**
   * Not a kill and not an outage — just two processes doing their jobs, which
   * is the ordinary production topology and the one nothing in this repository
   * exercises. `apps/worker` exists precisely so that the control plane does
   * not walk runs; every durability proof so far has one process create a run
   * and a *different* one advance it, never the same process doing both at
   * different times.
   *
   * Both tests below are red. The cause is in the report.
   */
  let api: Api;
  let backing: Backing;
  const RUNS = Number.parseInt(process.env.FORGE_CHAOS_FLEET_RUNS ?? "8", 10);

  beforeAll(async () => {
    backing = backingFor("fleet");
    api = await startApi(backing);
    // Enough workers that the control plane rarely wins the execute job.
    await Promise.all(Array.from({ length: 4 }, () => startWorker(backing)));
  }, CONTAINER_START_TIMEOUT_MS);

  async function toGate(): Promise<readonly string[]> {
    const ids: string[] = [];
    for (let index = 0; index < RUNS; index += 1) {
      ids.push((await startRun(api, GATED, PAYLOAD)).body.runId as string);
    }
    for (const runId of ids) {
      await waitFor(
        `the store to show ${runId} at its gate`,
        async () =>
          (await inspector.record(runId))?.status === "AWAITING_APPROVAL",
        60_000,
        25,
      );
    }
    return ids;
  }

  test("the run a control plane serves is the run the store holds", async () => {
    const ids = await toGate();

    const disagreeing: string[] = [];
    for (const runId of ids) {
      const served = await call(
        api,
        "GET",
        `/v1/runs/${runId}`,
        "marketing-lead",
      );
      if (served.body.status !== "AWAITING_APPROVAL") {
        disagreeing.push(
          `${runId} store=AWAITING_APPROVAL api=${String(served.body.status)}`,
        );
      }
    }

    // `Runtime.hydrate()` caches a `RunState` per process and never re-reads
    // the store for a run it already knows, so a control plane that *created*
    // a run keeps serving the record it created — PENDING — for as long as the
    // process lives, however far a worker has since taken it.
    expect(disagreeing).toEqual([]);
  });

  test("a decision on a run another process advanced is not voided into a second gate", async () => {
    const ids = await toGate();

    for (const runId of ids) {
      const record = (await inspector.record(runId)) as {
        pendingApprovalId: string;
      };
      const decided = await call(
        api,
        "POST",
        `/v1/runs/${runId}/approvals/${record.pendingApprovalId}/decision`,
        "marketing-lead",
        { decision: "approve" },
      );
      expect(`${runId} ${decided.status}`).toMatch(/ (200|202)$/);
    }

    // Generous: every one of these finishes in milliseconds when it finishes
    // at all, and the ones that do not never will.
    await sleep(10_000);

    const broken: string[] = [];
    for (const runId of ids) {
      const gates = await inspector.approvals(runId);
      const effects = await inspector.effects(runId);
      const record = await inspector.record(runId);
      if (gates.length !== 1 || effects.length !== 1) {
        broken.push(
          `${runId} status=${String(record?.status)} gates=${JSON.stringify(gates)} effects=${effects.length}`,
        );
      }
    }

    /**
     * What goes wrong, when it goes wrong: approval #1 is `APPROVED`, approval
     * #2 is `PENDING`, and no effect was ever dispatched. A human decided, the
     * decision was recorded and durable, and the run then re-walked from a
     * stale in-memory `PENDING` and opened a *new* gate over the same action —
     * spending the decision and asking for another one, with nothing anywhere
     * saying that is what happened.
     *
     * The invariants hold: nothing dispatched twice, nothing dispatched
     * unapproved. What fails is the one the whole system is for — that a
     * human's decision authorises the action it was taken on.
     */
    expect(broken).toEqual([]);
  });
});

/* ========================================================================== */

describe("the queue is unreachable when a run is started", () => {
  test("the run is persisted and visible at PENDING even though no job was enqueued", async () => {
    const backing = backingFor("start-no-queue");
    const api = await startApi(backing);
    await drop(redis);

    const control = new AbortController();
    const started = fetch(`${api.baseUrl}/v1/runs`, {
      method: "POST",
      signal: control.signal,
      headers: {
        authorization: `Bearer ${OPERATORS["marketing-lead"]}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workflow: GATED,
        capabilities: ["slack.write"],
        payload: PAYLOAD,
      }),
    }).then(
      () => true,
      () => false,
    );
    const outcome = await Promise.race([
      started,
      sleep(8_000).then(() => "timeout"),
    ]);

    // Same finding as the decision route, on the start path: no deadline on the
    // enqueue, so the request waits out the outage.
    expect(outcome).toBe("timeout");

    // But the claim the route makes in its own comments holds: the record is
    // there, at PENDING, for an operator to see and re-drive.
    const pending = await inspector.pending();
    expect(pending.length).toBeGreaterThan(0);
    expect(await inspector.effectsFor(pending)).toBe(0);

    await restore(redis);
    control.abort();
    await started;
  });
});
