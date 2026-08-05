import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  test("the human view of a gated run says what it is waiting on", async () => {
    const result = await runCli(["workflow", "run", "--input", FIXTURE]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("AWAITING_APPROVAL");
    expect(result.stdout).toContain("none dispatched");
    // A gate the reader cannot act on is not much better than a silent stop,
    // so the node, the deciding policy, and the expiry all appear.
    expect(result.stdout).toContain("awaiting");
    expect(result.stdout).toContain("publish");
    expect(result.stdout).toContain("acme.marketing.external-publish");
    expect(result.stdout).toContain("expires");
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

describe("forge workflow — failure reporting", () => {
  test("a compile failure prints each diagnostic with its code", async () => {
    const path = `${tmpdir()}/forge-broken-workflow.json`;
    writeFileSync(
      path,
      JSON.stringify({
        workflow: {
          id: "broken",
          version: "1.0.0",
          nodes: [
            { id: "a", kind: "input", schemaRef: "s@1" },
            { id: "b", kind: "output", schemaRef: "s@1" },
          ],
          edges: [
            { from: "a", to: "b" },
            { from: "b", to: "a" },
          ],
        },
      }),
    );

    const asJson = await runCli([
      "workflow",
      "compile",
      "--input",
      path,
      "--json",
    ]);
    expect(asJson.exitCode).toBe(2);
    expect(JSON.parse(asJson.stdout).diagnostics[0].code).toBe("WF_CYCLE");

    const human = await runCli(["workflow", "compile", "--input", path]);
    expect(human.stderr).toContain("WF_CYCLE");
    expect(human.stderr).toContain("0 artifacts produced");
  });

  test("run reports a compile failure rather than starting", async () => {
    const path = `${tmpdir()}/forge-broken-workflow.json`;
    const result = await runCli(["workflow", "run", "--input", path, "--json"]);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).code).toBe("WORKFLOW_COMPILE_FAILED");
  });

  test("a file that is not JSON is reported, not thrown", async () => {
    const path = `${tmpdir()}/forge-not-json.json`;
    writeFileSync(path, "this is not json");
    const result = await runCli([
      "workflow",
      "compile",
      "--input",
      path,
      "--json",
    ]);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).code).toBe("WORKFLOW_INPUT_UNREADABLE");
  });
});
