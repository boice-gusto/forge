import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, test } from "vitest";

import { call, startRun } from "../src/api.js";
import {
  CONTAINER_START_TIMEOUT_MS,
  freePort,
  type PinnedContainer,
  startPostgres,
  startRedis,
  waitFor,
} from "../src/docker.js";
import { Inspector } from "../src/inspect.js";
import { type Summary, summarise, table } from "../src/metrics.js";
import {
  type Api,
  type Backing,
  killAll,
  startApi,
  startWorker,
} from "../src/processes.js";
import { StatusWatch } from "../src/watch.js";
import { GATED, PAYLOAD } from "../src/workflows.js";

/**
 * Sustained load against a real control plane and a real worker fleet.
 *
 * **There is no latency assertion in this file, on purpose.** Nobody has chosen
 * a budget for Forge, and a number invented here would be a number invented by
 * the same person who decides whether it passed. What is asserted is
 * correctness under load — every run reaches its gate, every decision produces
 * exactly one durable dispatch on the value the approver saw, and the total
 * across the fleet equals the number of runs. What is *reported* is the
 * distribution. `LOAD.md` is where a number becomes a claim, and it says what
 * the number is worth.
 */

const RUNS = Number.parseInt(process.env.FORGE_LOAD_RUNS ?? "100", 10);
const CONCURRENCY = Number.parseInt(
  process.env.FORGE_LOAD_CONCURRENCY ?? "10",
  10,
);
/**
 * **Zero by default, and that is a finding rather than a preference.**
 *
 * The control plane consumes the queue it writes to, so a fleet of zero is a
 * supported topology and the one this measures. Setting this above zero adds
 * `apps/worker` processes and the scenario then fails — not on latency, but on
 * correctness: a control plane that created a run serves a stale record of it
 * once another process advances it, and a decision taken against that stale
 * record is discarded into a second gate. That defect is isolated and named in
 * `chaos.scenario.ts` ("a control plane and a worker fleet on one queue"), and
 * the numbers in `LOAD.md` say which topology produced them.
 */
const WORKERS = Number.parseInt(process.env.FORGE_LOAD_WORKERS ?? "0", 10);
const POLL_MS = Number.parseInt(process.env.FORGE_LOAD_POLL_MS ?? "20", 10);

let postgres: PinnedContainer;
let redis: PinnedContainer;
let backing: Backing;
let api: Api;
let inspector: Inspector;

beforeAll(async () => {
  const [pgPort, redisPort] = await Promise.all([freePort(), freePort()]);
  [postgres, redis] = await Promise.all([
    startPostgres(pgPort),
    startRedis(redisPort),
  ]);
  backing = {
    databaseUrl: postgres.url,
    redisUrl: redis.url,
    queueName: `forge-load-${Date.now()}`,
  };
  api = await startApi(backing);
  // The control plane consumes the queue it writes to, so a worker fleet is
  // additional capacity rather than a prerequisite. Both are here because both
  // are what a deployment runs.
  await Promise.all(
    Array.from({ length: WORKERS }, () => startWorker(backing)),
  );
  inspector = new Inspector(postgres.url);
}, CONTAINER_START_TIMEOUT_MS);

afterAll(async () => {
  killAll();
  await inspector?.close();
  await Promise.all([postgres?.container.stop(), redis?.container.stop()]);
});

test("a fleet drives runs to their gates and dispatches each exactly once", async () => {
  const watch = new StatusWatch(api, POLL_MS);
  const acceptedAt = new Map<string, number>();
  const startMs: number[] = [];
  const decisionSentAt = new Map<string, number>();
  const decisionAcceptedMs: number[] = [];

  const beganAt = performance.now();

  /* -- start ------------------------------------------------------------- */

  const remaining = Array.from({ length: RUNS }, (_, index) => index);
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (remaining.pop() !== undefined) {
        const at = performance.now();
        const reply = await startRun(api, GATED, PAYLOAD);
        startMs.push(performance.now() - at);
        expect(reply.status).toBe(202);
        expect(reply.body.status).toBe("PENDING");
        // Accepted, not executed. A 202 already carrying a dispatched effect
        // would mean the route walked the run inside the request.
        expect(reply.body.performedEffects).toEqual([]);
        acceptedAt.set(reply.body.runId as string, at);
      }
    }),
  );
  expect(acceptedAt.size).toBe(RUNS);
  const started = new Set(acceptedAt.keys());
  const allAccepted = performance.now();

  /* -- to the gate ------------------------------------------------------- */

  await waitFor(
    "every run to reach its gate",
    () => watch.countIn("AWAITING_APPROVAL", started) === RUNS,
    120_000,
    POLL_MS,
  );
  const allParked = performance.now();

  const gates = await call(api, "GET", "/v1/approvals", "marketing-lead");
  const pending = new Map(
    (gates.body.pending as { runId: string; approvalId: string }[]).map(
      (gate) => [gate.runId, gate.approvalId],
    ),
  );
  expect(pending.size).toBe(RUNS);

  /* -- the decision ------------------------------------------------------ */

  const toDecide = [...pending.entries()];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const next = toDecide.pop();
        if (next === undefined) return;
        const [runId, approvalId] = next;
        const at = performance.now();
        decisionSentAt.set(runId, at);
        const decided = await call(
          api,
          "POST",
          `/v1/runs/${runId}/approvals/${approvalId}/decision`,
          "marketing-lead",
          { decision: "approve" },
        );
        decisionAcceptedMs.push(performance.now() - at);
        // 200 when the route walks the run inside the request, 202 when it
        // records the decision and enqueues the resume. Both are shapes this
        // repository has shipped; neither changes what has to be true, which
        // is that exactly one dispatch happened and it happened after the
        // decision. Asserting a specific code here would make this scenario a
        // test of the route rather than of the fleet.
        expect(
          `${runId} ${decided.status} ${JSON.stringify(decided.body)}`,
        ).toMatch(/ (200|202) /);
      }
    }),
  );

  await waitFor(
    "every run to finish",
    async () => {
      if (watch.countIn("SUCCEEDED", started) === RUNS) return true;
      // Fail on the first run that ends any other way rather than waiting out
      // the timeout: "timed out" says nothing about which invariant broke.
      const stuck = await call(api, "GET", "/v1/runs", "marketing-lead");
      const bad = (
        stuck.body.runs as { runId: string; status: string; error?: string }[]
      )
        .filter((run) => started.has(run.runId))
        .filter((run) => run.status === "FAILED" || run.status === "CANCELLED");
      if (bad.length > 0) {
        throw new Error(`Runs ended badly under load: ${JSON.stringify(bad)}`);
      }
      return false;
    },
    180_000,
    POLL_MS,
  ).catch(async (error: unknown) => {
    const listed = await call(api, "GET", "/v1/runs", "marketing-lead");
    const statuses = (listed.body.runs as { runId: string; status: string }[])
      .filter((run) => started.has(run.runId))
      .map((run) => `${run.runId} ${run.status}`);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${statuses.join("\n")}`,
    );
  });
  const finishedAt = performance.now();
  await watch.stop();

  /* -- what actually happened -------------------------------------------- */

  for (const runId of started) {
    const effects = await inspector.effects(runId);
    // Named in the failure so a single bad run is identifiable in a fleet of
    // a hundred, rather than reported as `expected 2 to be 1`.
    expect(`${runId}: ${JSON.stringify(effects)}`).toContain(
      '"nodeId":"publish"',
    );
    expect(effects).toHaveLength(1);
    // The action was performed on the value the approver saw, not on one
    // recomputed by whichever worker took the resume.
    expect(effects[0]?.input).toEqual(PAYLOAD.body);
  }
  expect(await inspector.totalEffects()).toBe(RUNS);
  // Nothing claimed a dispatch and then failed to carry it out.
  expect(await inspector.claimedButUnperformed()).toEqual([]);

  /* -- the numbers ------------------------------------------------------- */

  const gateVisibleMs: number[] = [];
  const decideToDispatchMs: number[] = [];
  for (const runId of started) {
    const accepted = acceptedAt.get(runId) as number;
    const parked = watch.at(runId, "AWAITING_APPROVAL");
    const sent = decisionSentAt.get(runId) as number;
    const done = watch.at(runId, "SUCCEEDED");
    if (parked === undefined || done === undefined) {
      throw new Error(`The watcher never observed ${runId} in both states.`);
    }
    gateVisibleMs.push(parked - accepted);
    decideToDispatchMs.push(done - sent);
  }

  const rows: readonly (readonly [string, Summary])[] = [
    ["start — POST /v1/runs accepted", summarise(startMs)],
    [
      "gate visible — accepted → readable at its gate",
      summarise(gateVisibleMs),
    ],
    [
      "decide accepted — POST …/decision returns",
      summarise(decisionAcceptedMs),
    ],
    [
      "decide → dispatch — decision sent → run SUCCEEDED",
      summarise(decideToDispatchMs),
    ],
  ];

  const report = {
    at: new Date().toISOString(),
    node: process.version,
    runs: RUNS,
    concurrency: CONCURRENCY,
    workers: WORKERS,
    pollIntervalMs: POLL_MS,
    wallMs: {
      start: allAccepted - beganAt,
      toGate: allParked - allAccepted,
      decideToFinish: finishedAt - allParked,
      total: finishedAt - beganAt,
    },
    throughput: {
      acceptedPerSecond: (RUNS / (allAccepted - beganAt)) * 1000,
      toGatePerSecond: (RUNS / (allParked - beganAt)) * 1000,
      endToEndPerSecond: (RUNS / (finishedAt - beganAt)) * 1000,
    },
    summaries: Object.fromEntries(rows),
  };

  const where =
    // Beside this package, not beside whatever directory the runner was
    // invoked from — the config is passed by path, so `cwd` is usually the
    // repository root and the report would land there untracked and unnoticed.
    process.env.FORGE_LOAD_REPORT ??
    fileURLToPath(new URL("../load-report.json", import.meta.url));
  writeFileSync(where, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `\n${table(rows)}\n\n` +
      `runs=${RUNS} concurrency=${CONCURRENCY} workers=${WORKERS} poll=${POLL_MS}ms\n` +
      `accepted ${report.throughput.acceptedPerSecond.toFixed(1)}/s · ` +
      `to gate ${report.throughput.toGatePerSecond.toFixed(1)}/s · ` +
      `end to end ${report.throughput.endToEndPerSecond.toFixed(1)}/s ` +
      `(${report.wallMs.total.toFixed(0)}ms wall)\n` +
      `report: ${where}\n\n`,
  );
});
