import { describe, expect, test } from "vitest";

import { runCli } from "../program.js";

const FIXTURE = "examples/acme/workflows/campaign-brief.json";

describe("forge workflow", () => {
  test("compile reports the public surface as one JSON object", async () => {
    const result = await runCli([
      "workflow",
      "compile",
      "--input",
      FIXTURE,
      "--json",
    ]);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.status).toBe("compiled");
    expect(payload.workflowId).toBe("acme.marketing.campaign-brief");
    expect(payload.approvalGates).toEqual(["gate"]);
    expect(payload.roles).toEqual(["brand-reviewer", "marketing-writer"]);
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  });

  test("run parks at the gate and dispatches nothing", async () => {
    const result = await runCli([
      "workflow",
      "run",
      "--input",
      FIXTURE,
      "--json",
    ]);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.status).toBe("AWAITING_APPROVAL");
    expect(payload.dispatchedEffects).toEqual([]);
    expect(payload.awaiting.nodeId).toBe("publish");
    expect(payload.awaiting.policyId).toBe("acme.marketing.external-publish");
  });

  test("a missing --input is a usage-shaped failure, not a crash", async () => {
    const result = await runCli(["workflow", "compile", "--json"]);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).code).toBe("WORKFLOW_INPUT_UNREADABLE");
  });

  test("an unreadable path reports which path failed", async () => {
    const result = await runCli([
      "workflow",
      "run",
      "--input",
      "does/not/exist.json",
      "--json",
    ]);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).message).toContain("does/not/exist.json");
  });

  test("usage lists the workflow commands", async () => {
    const result = await runCli(["nonsense"]);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("workflow compile");
    expect(result.stderr).toContain("workflow run");
  });
});
