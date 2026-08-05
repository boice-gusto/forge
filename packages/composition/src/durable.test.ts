import { describe, expect, test } from "vitest";

import { createDurableStack } from "./durable.js";

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
