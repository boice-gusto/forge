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
});
