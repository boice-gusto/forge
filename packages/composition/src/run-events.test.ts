import { containerRuntimeAvailable } from "@forge/store-conformance";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedRedisContainer } from "@testcontainers/redis";
import { RedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createDurableStack } from "./durable.js";
import { compileToArtifact, createLocalStack } from "./local.js";

/**
 * The binding, from the outside.
 *
 * `@forge/observability` proves the recorder scrubs before it writes and
 * `@forge/event-store-*` prove the stores keep and order what they are handed.
 * This is the part neither can see: that a *run* records its events as it goes,
 * through whichever stack the deployment bound.
 */

const CONTAINER_START_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 120_000;

/**
 * A gated workflow whose payload is the sort of thing a payroll run actually
 * carries. The gate is what lets the run be parked and picked up elsewhere.
 */
const WORKFLOW = {
  id: "acme.publish.events",
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
      reads: { node: "intake", path: ["memberEmail"] },
    },
    { id: "done", kind: "output", schemaRef: "s@1" },
  ],
  edges: [
    { from: "intake", to: "gate" },
    { from: "gate", to: "send" },
    { from: "send", to: "done" },
  ],
};

const PAYLOAD = { memberEmail: "ada.lovelace@example.test" };

const RULES = [
  {
    id: "acme.publish.external",
    action: "slack.post",
    environment: "production",
    decision: "require-approval" as const,
    reason: "It leaves the building.",
    approvers: ["marketing-lead"],
  },
];

function artifact() {
  const compiled = compileToArtifact(WORKFLOW);
  if (!compiled.ok) {
    throw new Error(
      `The fixture stopped compiling: ${JSON.stringify(compiled.diagnostics)}`,
    );
  }
  return compiled.artifact;
}

/** Drains the recorder's write queue, which no run ever waits on. */
const drain = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("the local stack records a run's events as they happen", () => {
  test("the run's own walk is in its timeline, in order", async () => {
    const stack = createLocalStack({
      rules: RULES,
      grants: ["slack.write"],
      environment: "production",
    });

    const run = await stack.runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
      changedPaths: [],
      payload: PAYLOAD,
    });
    await drain();

    const events = await stack.runEvents.list(run.runId);
    expect(events.map((event) => event.name)).toEqual(
      expect.arrayContaining([
        "forge.run.start",
        "forge.policy.decide",
        "forge.approval.requested",
      ]),
    );
    expect(events.map((event) => event.seq)).toEqual(
      [...events.map((event) => event.seq)].sort((a, b) => a - b),
    );
  });

  test("one run's events never include another's", async () => {
    const stack = createLocalStack({
      rules: RULES,
      grants: ["slack.write"],
      environment: "production",
    });
    const first = await stack.runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
      changedPaths: [],
      payload: PAYLOAD,
    });
    const second = await stack.runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
      changedPaths: [],
      payload: PAYLOAD,
    });
    await drain();

    const events = await stack.runEvents.list(second.runId);
    expect(events).not.toHaveLength(0);
    expect(events.every((event) => event.runId === second.runId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(first.runId);
  });
});

/**
 * There is deliberately no "PII does not reach the store" test here, and the
 * absence is the point.
 *
 * One was written, and it passed with redaction switched off — the runtime
 * emits no attribute the scrubber would touch, so nothing at this level can
 * fail. A check that cannot fail is worse than no check, because it reads as
 * cover. The proof lives in `@forge/observability`'s `run-events.test.ts`,
 * aimed at a capture store that redacts nothing, where switching redaction off
 * turns it red immediately.
 */

const dockerAvailable = await containerRuntimeAvailable("composition-events");

describe.skipIf(!dockerAvailable)(
  "a run's timeline outlives the process that recorded it",
  () => {
    let postgres: StartedPostgreSqlContainer;
    let redis: StartedRedisContainer;
    let databaseUrl: string;
    let redisUrl: string;
    let queues = 0;

    beforeAll(async () => {
      [postgres, redis] = await Promise.all([
        new PostgreSqlContainer("postgres:16-alpine").start(),
        new RedisContainer("redis:7-alpine").start(),
      ]);
      databaseUrl = postgres.getConnectionUri();
      redisUrl = redis.getConnectionUrl();
    }, CONTAINER_START_TIMEOUT_MS);

    afterAll(async () => {
      await Promise.all([postgres?.stop(), redis?.stop()]);
    });

    const stack = () => {
      queues += 1;
      return createDurableStack({
        databaseUrl,
        redisUrl,
        queueName: `forge-events-${queues}`,
        rules: RULES,
        grants: ["slack.write"],
        environment: "production",
      });
    };

    test(
      "a second control plane reads the timeline of a run it never started",
      async () => {
        const first = await stack();
        const run = await first.runtime.start({
          artifact: artifact(),
          capabilities: ["slack.write"],
          changedPaths: [],
          payload: PAYLOAD,
        });
        expect(run.status).toBe("AWAITING_APPROVAL");
        // Everything of the first process goes: its runtime, its recorder, its
        // pool. What the second reads has to already be in Postgres.
        await first.close();

        const second = await stack();
        try {
          const events = await second.runEvents.list(run.runId);
          expect(events.map((event) => event.name)).toEqual(
            expect.arrayContaining([
              "forge.run.start",
              "forge.policy.decide",
              "forge.approval.requested",
            ]),
          );
          // This is the line the durable-restart test recorded as not yet
          // crossed: the run was readable, its gate was decidable, and its
          // events were empty.
          expect(events.length).toBeGreaterThan(2);
        } finally {
          await second.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the second process appends onto the same timeline, after it",
      async () => {
        const first = await stack();
        const run = await first.runtime.start({
          artifact: artifact(),
          capabilities: ["slack.write"],
          changedPaths: [],
          payload: PAYLOAD,
        });
        const approvalId = run.pendingApprovalId;
        if (approvalId === undefined) {
          throw new Error("The run did not park at a gate.");
        }
        const before = (await first.runEvents.list(run.runId)).length;
        await first.close();

        const second = await stack();
        try {
          const decided = await second.runtime.decide(
            approvalId,
            { kind: "approve" },
            "marketing-lead@acme.test",
          );
          expect(decided?.status).toBe("SUCCEEDED");
          await second.close();

          const third = await stack();
          try {
            const events = await third.runEvents.list(run.runId);
            expect(events.map((event) => event.name)).toEqual(
              expect.arrayContaining([
                "forge.run.start",
                "forge.approval.decided",
                "forge.effect.dispatched",
              ]),
            );
            // One timeline, not two: the second process's records sit after the
            // first's rather than restarting the sequence.
            expect(events.length).toBeGreaterThan(before);
            expect(events.map((event) => event.seq)).toEqual(
              [...events.map((event) => event.seq)].sort((a, b) => a - b),
            );
            // A principal never reaches a span, and now never reaches a row.
            // Green today for two independent reasons — the runtime hashes
            // before it emits, and the recorder scrubs identity keys — so this
            // is a regression guard rather than a proof. What it would catch is
            // the plausible third case: a future call site attaching the
            // decider under a key the scrubber does not know, such as
            // `decidedBy`, which is now one durable row rather than a span
            // nobody kept.
            expect(JSON.stringify(events)).not.toContain(
              "marketing-lead@acme.test",
            );
          } finally {
            await third.close();
          }
        } catch (failure) {
          await second.close().catch(() => {});
          throw failure;
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
