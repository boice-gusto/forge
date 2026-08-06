import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { call, settle, startRun } from "../src/api.js";
import {
  CONTAINER_START_TIMEOUT_MS,
  docker,
  freePort,
  PG,
  type PinnedContainer,
  postgresUrl,
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
  parkInAnotherProcess,
  startApi,
  startWorker,
} from "../src/processes.js";
import { GATED, PAYLOAD } from "../src/workflows.js";

/**
 * The drill: a run parked at a gate survives losing its process *and* being
 * restored into a database that is not the one it was written to.
 *
 * Not a restart. The Postgres container is destroyed — image, filesystem and
 * all — and a new one is started from a `pg_dump` taken while the run was
 * parked. Redis is destroyed and **not** restored, because nobody backs up a
 * queue; what that costs is measured here rather than assumed.
 *
 * The claim under test is the commercial one: after a total loss, an operator
 * can decide a gate and the action that fires is the action they were shown.
 */

const DUMP_IN_CONTAINER = "/tmp/forge-dr.dump";

let postgres: PinnedContainer;
let redis: PinnedContainer;
let pgPort: number;
let redisPort: number;
let scratch: string;

/** Captured before the disaster, asserted against after it. */
let gatedRunId: string;
let gatedApprovalId: string;
let gatedEffectHash: string;
/** Created and never walked: no job for it exists anywhere, before or after. */
let strandedRunId: string;

let after: Backing;
let second: Api;
let restored: Inspector;

/**
 * A logical dump, taken inside the container and copied out.
 *
 * Custom format rather than plain SQL, because that is what an operator's
 * backup is, and because it round-trips `jsonb` and the sequences the run
 * store orders by without depending on a text encoding surviving a shell.
 */
async function dumpTo(hostPath: string): Promise<void> {
  const result = await postgres.container.exec([
    "pg_dump",
    "-U",
    PG.user,
    "-d",
    PG.database,
    "-Fc",
    "-f",
    DUMP_IN_CONTAINER,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`pg_dump failed (${result.exitCode}): ${result.output}`);
  }
  await docker(
    "cp",
    `${postgres.container.getId()}:${DUMP_IN_CONTAINER}`,
    hostPath,
  );
}

async function restoreFrom(
  into: PinnedContainer,
  hostPath: string,
): Promise<void> {
  await docker(
    "cp",
    hostPath,
    `${into.container.getId()}:${DUMP_IN_CONTAINER}`,
  );
  const result = await into.container.exec([
    "pg_restore",
    "-U",
    PG.user,
    "-d",
    PG.database,
    DUMP_IN_CONTAINER,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`pg_restore failed (${result.exitCode}): ${result.output}`);
  }
}

beforeAll(async () => {
  [pgPort, redisPort] = await Promise.all([freePort(), freePort()]);
  [postgres, redis] = await Promise.all([
    startPostgres(pgPort),
    startRedis(redisPort),
  ]);
  scratch = mkdtempSync(join(tmpdir(), "forge-dr-"));

  const before: Backing = {
    databaseUrl: postgres.url,
    redisUrl: redis.url,
    queueName: "forge-dr-before",
  };
  const first = await startApi(before);

  /* -- two runs, in two different states ---------------------------------- */

  const started = await startRun(first, GATED, PAYLOAD);
  if (started.status !== 202) {
    throw new Error(`start: ${started.status} ${JSON.stringify(started.body)}`);
  }
  gatedRunId = started.body.runId as string;
  const parked = await settle(first, gatedRunId);
  if (parked.status !== "AWAITING_APPROVAL") {
    throw new Error(`the run did not park: ${JSON.stringify(parked)}`);
  }
  gatedApprovalId = parked.pendingApprovalId as string;

  // What the operator is shown, captured before anything is destroyed so it
  // can be compared with what actually fires afterwards.
  const shown = (
    (
      await call(
        first,
        "GET",
        `/v1/runs/${gatedRunId}/approvals`,
        "marketing-lead",
      )
    ).body.pending as Record<string, unknown>[]
  )[0];
  gatedEffectHash = shown?.effectHash as string;

  // The second run exists and has never been walked — a `PENDING` record whose
  // job is somewhere in a queue nobody is going to back up.
  strandedRunId = (
    await parkInAnotherProcess(before, {
      workflow: "gated",
      stopAtPending: true,
    })
  ).runId;

  const dump = join(scratch, "forge.dump");
  await dumpTo(dump);

  /* -- the disaster ------------------------------------------------------- */

  // The process first, unflushed: nothing may be written on the way out.
  await first.kill();
  // Then the database and the queue, containers and filesystems together.
  await postgres.container.stop().catch(() => {});
  await redis.container.stop().catch(() => {});
  await docker("rm", "-f", postgres.container.getId()).catch(() => {});
  await docker("rm", "-f", redis.container.getId()).catch(() => {});

  /* -- the recovery ------------------------------------------------------- */

  // New containers on the same addresses, so nothing in the restore depends on
  // rewriting a connection string a real deployment holds in its config.
  postgres = await startPostgres(pgPort);
  redis = await startRedis(redisPort);
  if (postgres.url !== postgresUrl(pgPort)) {
    throw new Error(
      "the replacement database did not come back on its address",
    );
  }

  restored = new Inspector(postgres.url);
  // Provably empty first — not "no such run" but "no such table". Without
  // this, every assertion below could be satisfied by a database that was
  // never actually destroyed.
  if (await restored.schemaExists()) {
    throw new Error("the replacement database was not empty; nothing was lost");
  }

  await restoreFrom(postgres, dump);

  after = {
    databaseUrl: postgres.url,
    redisUrl: redis.url,
    // A fresh queue name as well as a fresh Redis: nothing of the old
    // transport is available to help.
    queueName: "forge-dr-after",
  };
  second = await startApi(after);
  await startWorker(after);
}, CONTAINER_START_TIMEOUT_MS * 2);

afterAll(async () => {
  killAll();
  await restored?.close().catch(() => {});
  await postgres?.container.stop().catch(() => {});
  await redis?.container.stop().catch(() => {});
});

describe("a run parked at a gate survives the deployment being destroyed", () => {
  test("the run, its gate and its pinned value come back", async () => {
    expect(await restored.record(gatedRunId)).toMatchObject({
      runId: gatedRunId,
      status: "AWAITING_APPROVAL",
      pendingApprovalId: gatedApprovalId,
      performedEffects: [],
    });
    expect(await restored.approvals(gatedRunId)).toMatchObject([
      { approvalId: gatedApprovalId, status: "PENDING" },
    ]);
    expect(await restored.effects(gatedRunId)).toEqual([]);
    // The value the gate was opened over, which is what the dispatch must be
    // performed on however long the recovery took.
    expect(
      (await restored.values(gatedRunId)).find((row) => row.nodeId === "intake")
        ?.value,
    ).toEqual(PAYLOAD);
  });

  test("the gate is in the right inbox, refuses the wrong operator, and still binds", async () => {
    const inbox = await call(second, "GET", "/v1/approvals", "marketing-lead");
    expect(
      (inbox.body.pending as { approvalId: string; effectHash: string }[]).find(
        (gate) => gate.approvalId === gatedApprovalId,
      )?.effectHash,
      // The same binding the destroyed deployment computed. A restore that
      // changed it would authorise a different action.
    ).toBe(gatedEffectHash);

    const wrong = await call(second, "GET", "/v1/approvals", "finance-lead");
    expect(
      (wrong.body.pending as { approvalId: string }[]).map(
        (gate) => gate.approvalId,
      ),
    ).not.toContain(gatedApprovalId);

    const refused = await call(
      second,
      "POST",
      `/v1/runs/${gatedRunId}/approvals/${gatedApprovalId}/decision`,
      "finance-lead",
      { decision: "approve" },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("DECISION_FORBIDDEN");
  });

  test("deciding it in the new deployment dispatches exactly once, on the restored value", async () => {
    const decided = await call(
      second,
      "POST",
      `/v1/runs/${gatedRunId}/approvals/${gatedApprovalId}/decision`,
      "marketing-lead",
      { decision: "approve" },
    );
    expect(`${decided.status} ${JSON.stringify(decided.body)}`).toMatch(
      /^(200|202) /,
    );

    await waitFor(
      "the restored run to finish",
      async () => (await restored.record(gatedRunId))?.status === "SUCCEEDED",
      60_000,
      100,
    );

    const effects = await restored.effects(gatedRunId);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      nodeId: "publish",
      effect: "slack.post",
      input: PAYLOAD.body,
    });

    // The timeline the destroyed deployment wrote came back with everything
    // else, and the new one appended to it rather than starting over.
    const events = await call(
      second,
      "GET",
      `/v1/runs/${gatedRunId}/events`,
      "marketing-lead",
    );
    const names = (events.body.events as { name: string }[]).map((e) => e.name);
    expect(names[0]).toBe("forge.run.start");
    expect(names).toContain("forge.approval.requested");
    expect(names).toContain("forge.effect.dispatched");
    const seqs = (events.body.events as { seq: number }[]).map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });
});

describe("what a restore does not bring back", () => {
  /**
   * The honest half of the drill. Postgres is the system of record and it comes
   * back whole. Redis is not backed up, so a run whose `workflow.execute` job
   * had not been consumed is restored as a `PENDING` row with nothing anywhere
   * that will ever pick it up.
   *
   * That is not a defect in the restore — it is what "the queue is not durable
   * state" means. The consequence is a recovery runbook item: every `PENDING`
   * run has to be re-driven by hand, and no route offers it.
   */
  test("a run that was never walked is restored, and stays exactly where it was", async () => {
    expect(await restored.record(strandedRunId)).toMatchObject({
      runId: strandedRunId,
      status: "PENDING",
    });

    // Long enough for the new deployment's consumer and worker to have done
    // anything they were going to do.
    await sleep(10_000);

    expect(await restored.record(strandedRunId)).toMatchObject({
      status: "PENDING",
    });
    expect(await restored.effects(strandedRunId)).toEqual([]);
    expect(await restored.pending()).toContain(strandedRunId);
  });

  test("and it is recoverable, but only by an explicit redrive", async () => {
    const record = (await restored.record(strandedRunId)) as {
      fingerprint: string;
      attempt: number;
    };

    // What a runbook would have an operator do. There is no route for it, so
    // the harness does it the way an operator would have to: by putting the
    // job the lost Redis was holding back onto the new one.
    const { createDurableStack } = await import("@forge/composition/durable");
    const control = await createDurableStack({
      databaseUrl: after.databaseUrl,
      redisUrl: after.redisUrl,
      queueName: after.queueName,
      environment: "production",
    });
    try {
      await control.queue.enqueue({
        type: "workflow.execute",
        runId: strandedRunId,
        workflowVersionId: record.fingerprint,
        attempt: record.attempt,
      });

      await waitFor(
        "the redriven run to reach its gate",
        async () =>
          (await restored.record(strandedRunId))?.status ===
          "AWAITING_APPROVAL",
        60_000,
        100,
      );
      expect(await restored.approvals(strandedRunId)).toMatchObject([
        { status: "PENDING" },
      ]);
      expect(await restored.effects(strandedRunId)).toEqual([]);
    } finally {
      await control.close();
    }
  });
});
