import { describe, expect, test } from "vitest";

import { runLocalComposition } from "./dev.js";

describe("runLocalComposition", () => {
  test("starts only named Forge local infrastructure services", async () => {
    const calls: (readonly string[])[] = [];
    const result = await runLocalComposition("up", true, async (args) => {
      calls.push(args);
      return { exitCode: 0, stderr: "" };
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      [
        "compose",
        "-f",
        "forge/infra/local/compose.yaml",
        "up",
        "--detach",
        "redis",
        "postgres",
        "otel",
      ],
    ]);
  });

  test("redacts failed local-composition diagnostics", async () => {
    const result = await runLocalComposition("up", true, async () => ({
      exitCode: 1,
      stderr: "registry authentication failed: token=do-not-disclose",
    }));

    expect(JSON.parse(result.stdout)).toMatchObject({
      diagnostic: "registry authentication failed: token=[REDACTED]",
    });
  });
});
