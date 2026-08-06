import { containerRuntimeAvailable } from "@forge/store-conformance";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedRedisContainer } from "@testcontainers/redis";
import { RedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createDurableStack, type DurableStack } from "./durable.js";
import { compileToArtifact } from "./local.js";

/**
 * The part of the durable root that must hold with no container anywhere: it
 * refuses to invent a connection. A default would be a credential living in
 * the repository, and `security:secrets` is right to treat that as a leak.
 *
 * The behaviour that needs Postgres and Redis is proven end to end in
 * `apps/worker/test/durable-restart.test.ts`.
 */
describe("the durable stack reads its connection details from the environment", () => {
  const withoutEnvironment = async (
    present: Record<string, string>,
  ): Promise<unknown> => {
    const saved = {
      FORGE_DATABASE_URL: process.env.FORGE_DATABASE_URL,
      FORGE_REDIS_URL: process.env.FORGE_REDIS_URL,
    } as Record<string, string | undefined>;
    // Deleting, not assigning `undefined`: Node stringifies the assignment,
    // and "undefined" is a perfectly non-empty value that would sail past the
    // check this test exists to exercise.
    for (const name of ["FORGE_DATABASE_URL", "FORGE_REDIS_URL"] as const) {
      const value = present[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      return await createDurableStack().catch((error: unknown) => error);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };

  test("no database URL stops it starting, and says which variable", async () => {
    const error = await withoutEnvironment({});

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("FORGE_DATABASE_URL");
    expect((error as Error).message).toContain("no built-in default");
  });

  test("no Redis URL stops it starting too", async () => {
    // A stack with stores but no transport would look healthy and quietly
    // never deliver a resume.
    const error = await withoutEnvironment({
      FORGE_DATABASE_URL: "set-but-never-connected-to",
    });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("FORGE_REDIS_URL");
  });

  test("an empty string is absent, not a value", async () => {
    const error = await withoutEnvironment({ FORGE_DATABASE_URL: "" });

    expect((error as Error).message).toContain("FORGE_DATABASE_URL");
  });
});

/**
 * What the control plane reads off a durable stack.
 *
 * `apps/api` binds one of these at boot and serves runs from it, so the two
 * things it asks for beyond the runtime — the recorded timeline, and the
 * isolation this deployment can actually provide — have to be true of the
 * durable root and not only of the local one. A run must not become less
 * isolated, or less inspectable than it says it is, by being made durable.
 */
const dockerAvailable = await containerRuntimeAvailable("composition-durable");

const GATED = {
  id: "durable.control-plane",
  version: "1.0.0",
  sideEffects: ["prod.write"],
  nodes: [
    { id: "intake", kind: "input", schemaRef: "s@1" },
    { id: "isolate", kind: "sandbox", profile: "gusto-research" },
    { id: "gate", kind: "approval", gateSchemaRef: "g@1", gates: ["act"] },
    {
      id: "act",
      kind: "tool",
      skillRef: "t@1",
      effect: "prod.write",
      reads: { node: "intake", path: ["body"] },
    },
    { id: "done", kind: "output", schemaRef: "s@1" },
  ],
  edges: [
    { from: "intake", to: "isolate" },
    { from: "isolate", to: "gate" },
    { from: "gate", to: "act" },
    { from: "act", to: "done" },
  ],
};

const RULES = [
  {
    id: "durable.gate",
    action: "prod.write",
    environment: "production",
    decision: "require-approval" as const,
    reason: "A human decides this.",
    approvers: ["operator"],
  },
];

describe.skipIf(!dockerAvailable)(
  "the durable stack is a control plane, not only a runtime",
  () => {
    let postgres: StartedPostgreSqlContainer;
    let redis: StartedRedisContainer;
    let namespaces = 0;
    const stacks: DurableStack[] = [];

    beforeAll(async () => {
      [postgres, redis] = await Promise.all([
        new PostgreSqlContainer("postgres:16-alpine").start(),
        new RedisContainer("redis:7-alpine").start(),
      ]);
    }, 240_000);

    afterAll(async () => {
      await Promise.all(stacks.splice(0).map((stack) => stack.close()));
      await Promise.all([postgres?.stop(), redis?.stop()]);
    });

    async function durable(
      overrides: Parameters<typeof createDurableStack>[0] = {},
    ): Promise<DurableStack> {
      namespaces += 1;
      const stack = await createDurableStack({
        databaseUrl: postgres.getConnectionUri(),
        redisUrl: redis.getConnectionUrl(),
        queueName: `forge-control-${namespaces}`,
        rules: RULES,
        ...overrides,
      });
      stacks.push(stack);
      return stack;
    }

    const artifactOf = (source: unknown) => {
      const compiled = compileToArtifact(source);
      if (!compiled.ok) throw new Error("the fixture must compile");
      return compiled.artifact;
    };

    test("a profile the deployment did not declare stops the run rather than dropping isolation", async () => {
      // The default is `docker` alone. A workflow asking for a profile this
      // host cannot provision must not quietly run with less isolation than
      // it declared — the same rule the local stack applies.
      const stack = await durable();

      const run = await stack.runtime.start({
        artifact: artifactOf(GATED),
        payload: { body: "the copy" },
      });

      expect(run.status).toBe("FAILED");
      expect(await stack.dispatched(run.runId)).toEqual([]);
    }, 60_000);

    test("a declared profile is provisioned, and the run reaches its gate", async () => {
      const stack = await durable({
        sandboxProfiles: ["docker", "gusto-research"],
      });

      const run = await stack.runtime.start({
        artifact: artifactOf(GATED),
        payload: { body: "the copy" },
      });

      expect(run.status).toBe("AWAITING_APPROVAL");
    }, 60_000);

    test("an injected sandbox is the one a run gets, not the simulated default", async () => {
      /**
       * This stack defaulted to `createMemorySandbox` with no way past it, and
       * `apps/worker` used this stack. So a step that declared
       * `forge.node-ts` — declared, in the compiled artifact, that it runs
       * somewhere it cannot reach the host — ran against a Map, in the
       * worker's own process, with the worker's filesystem and network. That
       * declaration is the whole basis on which a workflow may handle
       * untrusted content, and nothing anywhere said it was not honoured.
       *
       * Proven by injecting one that refuses. With the default still in place
       * the run reaches its gate, as the test above shows; the only way to see
       * this failure is for the injected adapter to be the one asked.
       */
      const asked: string[] = [];
      const stack = await durable({
        sandboxProfiles: ["docker", "gusto-research"],
        sandbox: {
          profiles: ["docker", "gusto-research"],
          async health() {
            return { available: true };
          },
          async withSandbox(request) {
            asked.push(request.profile);
            throw new Error(
              "FORGE_TEST_SANDBOX: this adapter provisions nothing.",
            );
          },
        },
      });

      const run = await stack.runtime.start({
        artifact: artifactOf(GATED),
        payload: { body: "the copy" },
      });

      expect(asked).toEqual(["gusto-research"]);
      expect(run.status).toBe("FAILED");
      expect(await stack.dispatched(run.runId)).toEqual([]);
    }, 60_000);

    test("a run's events are written to the store, not only to a trace", async () => {
      const stack = await durable({
        sandboxProfiles: ["docker", "gusto-research"],
      });

      const run = await stack.runtime.start({
        artifact: artifactOf(GATED),
        payload: { body: "the copy" },
      });

      // Read from the durable store, which is what an operator queries and
      // what survives this process. A per-process recorder could show these
      // and still leave the next process with nothing.
      await stack.settled();
      const names = (await stack.runEvents.list(run.runId)).map(
        (entry) => entry.name,
      );
      expect(names).toContain("forge.policy.decide");
      expect(names).toContain("forge.approval.requested");
    }, 60_000);
  },
);
