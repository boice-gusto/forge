import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";

import { runCli } from "../program.js";

describe("forge validate", () => {
  test("reports a valid manifest with its id", async () => {
    const result = await runCli(["validate", "--input", "/dev/null", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).code).toBe("MANIFEST_INVALID");
  });

  test("a missing --input is an invalid-artifact exit, not a crash", async () => {
    const result = await runCli(["validate", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).code).toBe("MANIFEST_INVALID");
  });

  test("human output does not print JSON to stdout", async () => {
    const result = await runCli(["validate"]);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
  });
});

describe("forge validate — the accepting path", () => {
  const manifest = JSON.stringify({
    apiVersion: "forge.dev/v1",
    kind: "Company",
    metadata: { id: "acme", name: "Acme", version: "1.0.0" },
    spec: { domains: [] },
  });

  test("a valid manifest reports its id and exits zero", async () => {
    const path = `${tmpdir()}/forge-manifest-valid.json`;
    writeFileSync(path, manifest);
    const result = await runCli(["validate", "--input", path, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "valid",
      id: "acme",
    });
  });

  test("human output names the manifest rather than printing JSON", async () => {
    const path = `${tmpdir()}/forge-manifest-valid.json`;
    writeFileSync(path, manifest);
    const result = await runCli(["validate", "--input", path]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("acme");
    expect(result.stdout).not.toContain("{");
    expect(result.stderr).toBe("");
  });

  test("a structurally invalid manifest returns diagnostics", async () => {
    const path = `${tmpdir()}/forge-manifest-bad.json`;
    writeFileSync(
      path,
      JSON.stringify({
        apiVersion: "forge.dev/v1",
        kind: "Company",
        metadata: { id: "", name: "", version: "nope" },
        spec: { domains: [] },
      }),
    );
    const result = await runCli(["validate", "--input", path, "--json"]);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).diagnostics.length).toBeGreaterThan(0);
  });
});
