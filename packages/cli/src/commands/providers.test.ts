import { describe, expect, test } from "vitest";

import { runCli } from "../program.js";

describe("forge providers", () => {
  test("doctor reports provider availability as one JSON object", async () => {
    const result = await runCli(["providers", "doctor", "--json"]);
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toHaveProperty("status");
  });
});

describe("forge usage", () => {
  test("an unknown command exits with the usage code", async () => {
    const result = await runCli(["nope"]);
    expect(result.exitCode).toBe(3);
  });

  test("no arguments at all still produces usage rather than throwing", async () => {
    const result = await runCli([]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("Usage: forge");
  });
});
