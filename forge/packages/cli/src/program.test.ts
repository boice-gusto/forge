import { describe, expect, test } from "vitest";

import { runCli } from "./program.js";

describe("runCli", () => {
  test("preserves --json when the executable is invoked through Commander", () => {
    const output = execFileSync(
      "pnpm",
      [
        "--filter",
        "@forge/cli",
        "exec",
        "tsx",
        "src/main.ts",
        "providers",
        "doctor",
        "--json",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(JSON.parse(output)).toMatchObject({ status: "ready" });
  });

  test("writes exactly one JSON result to stdout for provider diagnostics", async () => {
    const result = await runCli(["providers", "doctor", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual(
      `${JSON.stringify({
        status: "ready",
        providers: [
          { id: "mock", status: "ready" },
          { id: "claude-cli", status: "not-configured" },
          { id: "codex-cli", status: "not-configured" },
          { id: "direct-api", status: "not-configured" },
        ],
      })}\n`,
    );
    expect(result.stderr).toBe("");
  });

  test("keeps human output off stdout", async () => {
    const result = await runCli(["providers", "doctor"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("mock: ready");
  });

  test("returns the invalid-artifact exit code for an invalid manifest", async () => {
    const result = await runCli(["validate", "--json"]);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "invalid",
      code: "MANIFEST_INVALID",
    });
  });
});

import { execFileSync } from "node:child_process";
