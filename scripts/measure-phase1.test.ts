import { execFileSync } from "node:child_process";

import { describe, expect, test } from "vitest";

describe("Phase 1 measurement baseline", () => {
  test("emits every required measurement with percentile samples", () => {
    const output = execFileSync("node", ["scripts/measure-phase1.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const result: unknown = JSON.parse(output);

    expect(result).toMatchObject({ schemaVersion: 1, phase: 1 });
    expect(result).toHaveProperty("measurements.cliStartup.samplesMs");
    expect(result).toHaveProperty("measurements.emptyCompile.p95Ms");
    expect(result).toHaveProperty("measurements.apiHealthSerialization.p50Ms");
    expect(result).toHaveProperty("measurements.uiFirstRenderModel.samplesMs");
  }, 30_000);
});
