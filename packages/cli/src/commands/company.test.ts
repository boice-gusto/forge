import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { runCli } from "../program.js";

const ACME = "examples/acme";

describe("forge company inspect", () => {
  test("lists what the company package contributes", async () => {
    const result = await runCli([
      "company",
      "inspect",
      "--company",
      ACME,
      "--json",
    ]);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.status).toBe("loaded");
    expect(payload.companyId).toBe("acme");
    expect(payload.plugins).toEqual(["acme.plugin-marketing"]);
    expect(payload.workflows).toEqual(["acme.marketing.brief-approval"]);
    expect(payload.policyPacks).toEqual(["acme.marketing.publish"]);
    // Acme binds both because a worker refuses to start without somewhere for
    // a gated action to land, and Acme is the example a worker is run against.
    expect(payload.adapters).toEqual(["notification", "effects"]);
  });

  test("grants only what the host offers and the company asked for", async () => {
    const result = await runCli([
      "company",
      "inspect",
      "--company",
      ACME,
      "--json",
    ]);

    // The CLI host offers docs.read and kb.read too; acme did not ask for them.
    expect(JSON.parse(result.stdout).grantedCapabilities).toEqual([
      "repo.read",
      "docs.write",
      "slack.write",
    ]);
  });

  test("the human view names the company and its contributions", async () => {
    const result = await runCli(["company", "inspect", "--company", ACME]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Loaded acme 0.1.0");
    expect(result.stdout).toContain("acme.marketing.brief-approval");
  });

  test("a missing --company is reported, not crashed on", async () => {
    const result = await runCli(["company", "inspect", "--json"]);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).diagnostics[0].code).toBe(
      "COMPANY_ROOT_MISSING",
    );
  });

  test("a directory with no manifest reports which file was missing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "forge-empty-"));
    const result = await runCli([
      "company",
      "inspect",
      "--company",
      empty,
      "--json",
    ]);

    expect(result.exitCode).toBe(2);
    const [diagnostic] = JSON.parse(result.stdout).diagnostics;
    expect(diagnostic.code).toBe("COMPANY_MANIFEST_UNREADABLE");
    expect(diagnostic.message).toContain("forge.company.json");
  });
});

describe("forge workflow run --company", () => {
  test("runs a workflow the company contributed and parks at its gate", async () => {
    const result = await runCli([
      "workflow",
      "run",
      "--company",
      ACME,
      "--workflow",
      "acme.marketing.brief-approval",
      "--json",
    ]);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.status).toBe("AWAITING_APPROVAL");
    expect(payload.companyId).toBe("acme");
    expect(payload.dispatchedEffects).toEqual([]);
    // The gate exists because acme's own policy pack asked for it.
    expect(payload.awaiting.policyId).toBe("acme.marketing.external-publish");
    expect(payload.awaiting.effect).toBe("slack.post");
  });

  test("an unknown workflow id lists what is available", async () => {
    const result = await runCli([
      "workflow",
      "run",
      "--company",
      ACME,
      "--workflow",
      "acme.marketing.nope",
      "--json",
    ]);

    expect(result.exitCode).toBe(2);
    const [diagnostic] = JSON.parse(result.stdout).diagnostics;
    expect(diagnostic.code).toBe("COMPANY_WORKFLOW_UNKNOWN");
    expect(diagnostic.message).toContain("acme.marketing.brief-approval");
  });

  test("--company without --workflow is a usage failure", async () => {
    const result = await runCli([
      "workflow",
      "run",
      "--company",
      ACME,
      "--json",
    ]);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).diagnostics[0].code).toBe("COMPANY_USAGE");
  });

  test("without --company the --input path still works", async () => {
    // The two modes coexist: point at a file, or name a company's workflow.
    const result = await runCli([
      "workflow",
      "run",
      "--input",
      "examples/acme/workflows/campaign-brief.json",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("AWAITING_APPROVAL");
  });

  test("a company whose plugin fails to load reports diagnostics", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-badplugin-"));
    writeFileSync(
      join(root, "forge.company.json"),
      JSON.stringify({
        apiVersion: "forge.dev/v1",
        kind: "Company",
        metadata: { id: "broken", name: "Broken", version: "0.1.0" },
        spec: {
          domains: [],
          plugins: [{ package: "./missing.js", version: "^0.1.0" }],
        },
      }),
    );

    const result = await runCli([
      "workflow",
      "run",
      "--company",
      root,
      "--workflow",
      "anything",
      "--json",
    ]);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).diagnostics[0].code).toBe(
      "COMPANY_PLUGIN_UNRESOLVED",
    );
  });
});

describe("the human view of a company run", () => {
  test("names the company, the gate, and who can decide it", async () => {
    const result = await runCli([
      "workflow",
      "run",
      "--company",
      ACME,
      "--workflow",
      "acme.marketing.brief-approval",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("AWAITING_APPROVAL");
    expect(result.stdout).toContain("company   acme");
    expect(result.stdout).toContain("none dispatched");
    expect(result.stdout).toContain("awaiting");
    expect(result.stdout).toContain("marketing-lead");
    expect(result.stderr).toBe("");
  });

  test("a load failure prints each diagnostic with its code and path", async () => {
    const empty = mkdtempSync(join(tmpdir(), "forge-empty-human-"));
    const result = await runCli(["company", "inspect", "--company", empty]);

    expect(result.exitCode).toBe(2);
    // Failures go to stderr, and say which file and why.
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("COMPANY_MANIFEST_UNREADABLE");
    expect(result.stderr).toContain("forge.company.json");
    expect(result.stderr).toContain("1 problem(s)");
  });
});

describe("usage lists the company commands", () => {
  test("both company entry points are discoverable", async () => {
    const result = await runCli(["nonsense"]);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("company inspect");
    expect(result.stderr).toContain("--workflow <id>");
  });
});
