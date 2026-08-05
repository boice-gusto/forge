import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { containerRuntimeAvailable } from "@forge/store-conformance";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedRedisContainer } from "@testcontainers/redis";
import { RedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * The proof that binding the durable stack was real.
 *
 * A run is started against a control plane in one `node` process. That process
 * is then **killed** — its runtime, its three ledgers, its approval store and
 * its connection pool go with it. A second control plane, sharing nothing but
 * Postgres and Redis, has to list that run, serve its record, show its gate in
 * the right operator's inbox, refuse the wrong operator, and carry the decision
 * out.
 *
 * It drives `apps/api/src/server.ts` itself rather than constructing a stack
 * in-process, because the thing under test is the *boot wiring*:
 * `FORGE_PERSISTENCE`, `FORGE_COMPANY`, and the fact that there is one stack
 * for the process rather than one per request. A test that built the stack
 * itself would prove the composition root and skip everything the binary does.
 */

const POSTGRES_IMAGE = "postgres:16-alpine";
const REDIS_IMAGE = "redis:7-alpine";
const CONTAINER_START_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 60_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const API = resolve(HERE, "..");
const SERVER = resolve(API, "src/server.ts");
const ACME = resolve(API, "../../examples/acme");

/** Acme's manifest asks for these three; the deployment is what grants them. */
const HOST_CAPABILITIES = "repo.read,docs.write,slack.write";

/**
 * A gated workflow with no branch and no judge.
 *
 * The deployment binds no branch source and no review adapter — the API used
 * to take both from the request body, and does not any more, because a caller
 * naming its own verdict would be steering the decision it is asking a human
 * to make. So the workflow used here declares neither.
 */
const WORKFLOW = {
  id: "acme.marketing.restart",
  version: "1.0.0",
  sideEffects: ["slack.post"],
  nodes: [
    { id: "intake", kind: "input", schemaRef: "s@1" },
    { id: "gate", kind: "approval", gateSchemaRef: "g@1", gates: ["send"] },
    {
      id: "send",
      kind: "tool",
      skillRef: "t@1",
      effect: "slack.post",
      reads: { node: "intake", path: ["body"] },
    },
    { id: "done", kind: "output", schemaRef: "s@1" },
  ],
  edges: [
    { from: "intake", to: "gate" },
    { from: "gate", to: "send" },
    { from: "send", to: "done" },
  ],
};

const dockerAvailable = await containerRuntimeAvailable("api-durable-restart");

async function freePort(): Promise<number> {
  return new Promise((settle, fail) => {
    const probe = createServer();
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => fail(new Error("No ephemeral port was assigned.")));
        return;
      }
      const { port } = address;
      probe.close(() => settle(port));
    });
  });
}

const sleep = (ms: number) => new Promise((settle) => setTimeout(settle, ms));

interface Api {
  readonly baseUrl: string;
  readonly output: () => string;
  kill(): Promise<void>;
}

describe.skipIf(!dockerAvailable)(
  "a run outlives the control plane that started it",
  () => {
    let postgres: StartedPostgreSqlContainer;
    let redis: StartedRedisContainer;
    let databaseUrl: string;
    let redisUrl: string;
    let queues = 0;
    const running: ChildProcess[] = [];

    /** One operator per role, so "who may decide" is a real question. */
    const SECRETS = {
      "marketing-lead": randomBytes(16).toString("hex"),
      "finance-lead": randomBytes(16).toString("hex"),
    };
    const as = (role: keyof typeof SECRETS) => ({
      authorization: `Bearer ${SECRETS[role]}`,
      "content-type": "application/json",
    });

    beforeAll(async () => {
      [postgres, redis] = await Promise.all([
        new PostgreSqlContainer(POSTGRES_IMAGE).start(),
        new RedisContainer(REDIS_IMAGE).start(),
      ]);
      databaseUrl = postgres.getConnectionUri();
      redisUrl = redis.getConnectionUrl();
    }, CONTAINER_START_TIMEOUT_MS);

    afterAll(async () => {
      for (const child of running.splice(0)) child.kill("SIGKILL");
      await Promise.all([postgres?.stop(), redis?.stop()]);
    });

    /**
     * A whole control plane, in its own process, reading the same database.
     * Nothing of one is available to the next but Postgres and Redis.
     */
    async function startApi(): Promise<Api> {
      queues += 1;
      const port = await freePort();
      const child = spawn(process.execPath, ["--import", "tsx", SERVER], {
        cwd: API,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PORT: String(port),
          FORGE_PERSISTENCE: "postgres",
          FORGE_DATABASE_URL: databaseUrl,
          FORGE_REDIS_URL: redisUrl,
          FORGE_QUEUE_NAME: `forge-api-${queues}`,
          FORGE_COMPANY: ACME,
          FORGE_HOST_CAPABILITIES: HOST_CAPABILITIES,
          FORGE_OPERATORS: Object.entries(SECRETS)
            .map(([role, secret]) => `${role}@restart.test:${secret}:${role}`)
            .join(";"),
        },
      });
      running.push(child);

      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      let exited = false;
      child.once("exit", () => {
        exited = true;
      });

      const baseUrl = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (exited) {
          throw new Error(`The API exited before it was ready:\n${output}`);
        }
        try {
          if ((await fetch(`${baseUrl}/health/live`)).ok) {
            return {
              baseUrl,
              output: () => output,
              async kill() {
                if (child.exitCode !== null) return;
                const gone = new Promise<void>((settle) =>
                  child.once("exit", () => settle()),
                );
                // SIGKILL, not SIGTERM: nothing may be flushed on the way out.
                // What the second process reads has to already be in Postgres.
                child.kill("SIGKILL");
                await gone;
              },
            };
          }
        } catch {
          // Not listening yet.
        }
        await sleep(100);
      }
      throw new Error(`The API never became ready:\n${output}`);
    }

    /**
     * The statuses at which the queue owes the run nothing. Not "terminal":
     * every assertion below is about a run parked at its *gate*, and a helper
     * that waited for a finished run would drive it past the thing under test.
     */
    const SETTLED = new Set([
      "AWAITING_APPROVAL",
      "SUCCEEDED",
      "FAILED",
      "CANCELLED",
    ]);

    const call = async (
      api: Api,
      method: string,
      path: string,
      role: keyof typeof SECRETS,
      body?: unknown,
    ) => {
      const response = await fetch(`${api.baseUrl}${path}`, {
        method,
        headers: as(role),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };

    /**
     * `POST /v1/runs` accepts and enqueues, so the reply is a run at PENDING.
     * This is the loop a client writes, against the same process — which also
     * proves the control plane consumes the queue it writes to.
     */
    async function settle(api: Api, runId: string) {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const run = await call(
          api,
          "GET",
          `/v1/runs/${runId}`,
          "marketing-lead",
        );
        if (SETTLED.has(run.body.status as string)) return run.body;
        if (Date.now() > deadline) {
          throw new Error(
            `Run ${runId} was still ${String(run.body.status)} after 30s:\n${api.output()}`,
          );
        }
        await sleep(50);
      }
    }

    test(
      "a run parked in one process is listed, readable and decidable in the next",
      async () => {
        const first = await startApi();
        const started = await call(
          first,
          "POST",
          "/v1/runs",
          "marketing-lead",
          {
            workflow: WORKFLOW,
            capabilities: ["slack.write"],
            payload: { body: "the copy" },
          },
        );

        // Accepted, not executed: the request is not held across the walk.
        expect(`${started.status} ${JSON.stringify(started.body)}`).toContain(
          "202",
        );
        expect(started.body.status).toBe("PENDING");
        expect(started.body.performedEffects).toEqual([]);
        const runId = started.body.runId as string;

        const parked = await settle(first, runId);
        expect(parked.status).toBe("AWAITING_APPROVAL");
        expect(parked.performedEffects).toEqual([]);
        const approvalId = parked.pendingApprovalId as string;

        // The process that started it is gone, unflushed.
        await first.kill();

        const second = await startApi();

        // 1. The list. This is what used to be empty after a restart: the
        //    route enumerated a Map this process never wrote to.
        const listed = await call(second, "GET", "/v1/runs", "marketing-lead");
        expect(listed.status).toBe(200);
        expect(
          (listed.body.runs as { runId: string }[]).map((run) => run.runId),
        ).toContain(runId);

        // 2. The record. A run alive in Postgres is not a 404 from a process
        //    that did not start it.
        const record = await call(
          second,
          "GET",
          `/v1/runs/${runId}`,
          "marketing-lead",
        );
        expect(record.status).toBe(200);
        expect(record.body.status).toBe("AWAITING_APPROVAL");

        // 3. The gate is in the inbox of the role the company's pack names.
        const inbox = await call(
          second,
          "GET",
          "/v1/approvals",
          "marketing-lead",
        );
        expect(
          (inbox.body.pending as { runId: string; policyId: string }[]).find(
            (gate) => gate.runId === runId,
          )?.policyId,
        ).toBe("acme.marketing.external-publish");

        // 4. The run's timeline survived too. This assertion used to read
        //    `toEqual([])` and was labelled "what did *not* survive" — events
        //    were the last thing in a run that a restart still lost. A second
        //    process now serves what the first recorded, ordered by the
        //    store's sequence rather than by whichever clock wrote it.
        const before = await call(
          second,
          "GET",
          `/v1/runs/${runId}/events`,
          "marketing-lead",
        );
        expect(before.status).toBe(200);
        const names = (before.body.events as { name: string }[]).map(
          (event) => event.name,
        );
        expect(names).toContain("forge.run.start");
        expect(names).toContain("forge.approval.requested");
        // Recorded by a process that no longer exists, and read here.
        expect(names).not.toContain("forge.effect.dispatched");
        const seqs = (before.body.events as { seq: number }[]).map(
          (event) => event.seq,
        );
        expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

        // 5. Authority is checked on the decision itself, across the restart.
        const refused = await call(
          second,
          "POST",
          `/v1/runs/${runId}/approvals/${approvalId}/decision`,
          "finance-lead",
          { decision: "approve" },
        );
        expect(refused.status).toBe(403);
        expect(refused.body.code).toBe("DECISION_FORBIDDEN");

        // 6. And the operator the gate names carries it out.
        const decided = await call(
          second,
          "POST",
          `/v1/runs/${runId}/approvals/${approvalId}/decision`,
          "marketing-lead",
          { decision: "approve" },
        );
        expect(decided.status).toBe(200);
        expect(decided.body.status).toBe("SUCCEEDED");
        expect(decided.body.performedEffects).toEqual(["send"]);

        // What this process did *is* in its stream, so the empty reply above
        // was an honest absence rather than a route that never works.
        const after = await call(
          second,
          "GET",
          `/v1/runs/${runId}/events`,
          "marketing-lead",
        );
        expect(
          (after.body.events as { name: string }[]).map((event) => event.name),
        ).toContain("forge.effect.dispatched");

        // 7. A third process reads the finished run, and the status filter
        //    finds it where a listing of live runs would not.
        const third = await startApi();
        const succeeded = await call(
          third,
          "GET",
          "/v1/runs?status=SUCCEEDED",
          "marketing-lead",
        );
        expect(
          (succeeded.body.runs as { runId: string }[]).map((run) => run.runId),
        ).toEqual([runId]);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the deployment's policy is the company's, and a body cannot replace it",
      async () => {
        // The reason the per-request stack had to go. A caller supplying rules
        // that allow the action outright must change nothing: the pack loaded
        // at boot is the only rule set there is.
        const api = await startApi();
        const run = await call(api, "POST", "/v1/runs", "marketing-lead", {
          workflow: WORKFLOW,
          capabilities: ["slack.write"],
          payload: { body: "the copy" },
          policy: {
            grants: ["slack.write"],
            rules: [
              {
                id: "attacker.allow-everything",
                action: "slack.post",
                environment: "production",
                decision: "allow",
                reason: "Supplied by the caller.",
              },
            ],
          },
        });

        expect(`${run.status} ${JSON.stringify(run.body)}`).toContain("202");
        const parked = await settle(api, run.body.runId as string);
        expect(parked.status).toBe("AWAITING_APPROVAL");
        expect(parked.performedEffects).toEqual([]);

        // Not merely "a gate opened" — the gate the *company's* pack asked
        // for. A rule the caller invented would either open a different gate
        // or none, and both would read as a pass on status alone.
        const gates = await call(
          api,
          "GET",
          `/v1/runs/${run.body.runId as string}/approvals`,
          "marketing-lead",
        );
        expect(
          (
            gates.body.pending as { policyId: string; approvers: string[] }[]
          )[0],
        ).toMatchObject({
          policyId: "acme.marketing.external-publish",
          approvers: ["marketing-lead"],
        });
      },
      TEST_TIMEOUT_MS,
    );
  },
);
