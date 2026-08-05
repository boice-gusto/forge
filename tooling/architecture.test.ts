import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { assertArchitecture } from "./assert-architecture.js";
import { collectImports, packageOf } from "./scan-imports.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED_ROOTS = ["packages", "apps", "examples", "tooling", "scripts"];

describe("architecture rules", () => {
  test("rejects a public package importing a private adapter", () => {
    expect(() =>
      assertArchitecture({
        sourcePath: "packages/sdk/src/index.ts",
        importedPath: "@forge/adapters-provider-acp",
      }),
    ).toThrow("FORGE_PRIVATE_ADAPTER_IMPORT");
  });

  test("rejects a public package importing any internal package", () => {
    for (const internal of [
      "@forge/runtime",
      "@forge/compiler",
      "@forge/ir",
      "@forge/ports",
      "@forge/engine-memory",
      "@forge/composition",
    ]) {
      expect(() =>
        assertArchitecture({
          sourcePath: "packages/sdk/src/client.ts",
          importedPath: internal,
        }),
      ).toThrow("FORGE_INTERNAL_IMPORT");
    }
  });

  test("permits a public package importing another public package", () => {
    for (const publicPackage of [
      "@forge/types",
      "@forge/manifest",
      "@forge/plugin-sdk",
    ]) {
      expect(() =>
        assertArchitecture({
          sourcePath: "packages/sdk/src/client.ts",
          importedPath: publicPackage,
        }),
      ).not.toThrow();
    }
  });

  test("rejects core importing a company extension", () => {
    expect(() =>
      assertArchitecture({
        sourcePath: "packages/runtime/src/index.ts",
        importedPath: "forge.gusto",
      }),
    ).toThrow("FORGE_EXTENSION_IMPORT");
  });

  test("rejects company code importing an internal package", () => {
    for (const source of [
      "examples/acme/workflows/brief.ts",
      "forge.gusto/domains/benefits/inquiry.ts",
    ]) {
      expect(() =>
        assertArchitecture({
          sourcePath: source,
          importedPath: "@forge/runtime",
        }),
      ).toThrow("FORGE_INTERNAL_IMPORT");
    }
  });

  test("rejects an engine, transport or provider leak into company code", () => {
    const leaks: readonly [string, string][] = [
      ["@langchain/langgraph", "engine"],
      ["bullmq", "transport"],
      ["@anthropic-ai/sdk", "provider"],
      ["dockerode", "sandbox"],
    ];
    for (const [vendor] of leaks) {
      expect(() =>
        assertArchitecture({
          sourcePath: "examples/acme/skills/draft.ts",
          importedPath: vendor,
        }),
      ).toThrow("FORGE_VENDOR_LEAK");
    }
  });

  test("permits an adapter importing its own vendor", () => {
    expect(() =>
      assertArchitecture({
        sourcePath: "packages/adapters-langgraph/src/engine.ts",
        importedPath: "@langchain/langgraph",
      }),
    ).not.toThrow();
  });

  test("permits an extension importing a public SDK", () => {
    expect(() =>
      assertArchitecture({
        sourcePath: "forge.gusto/workflows/benefits.ts",
        importedPath: "@forge/sdk",
      }),
    ).not.toThrow();
  });

  test("boundaries hold for both flat and nested layouts", () => {
    for (const source of [
      "packages/sdk/src/index.ts",
      "forge/packages/sdk/src/index.ts",
      "/abs/path/packages/sdk/src/index.ts",
    ]) {
      expect(() =>
        assertArchitecture({
          sourcePath: source,
          importedPath: "@forge/adapters-provider-acp",
        }),
      ).toThrow("FORGE_PRIVATE_ADAPTER_IMPORT");
    }
  });

  test("a path outside packages/ is not treated as core", () => {
    expect(() =>
      assertArchitecture({
        sourcePath: "docs/research/notes.ts",
        importedPath: "forge.gusto",
      }),
    ).not.toThrow();
  });
});

describe("import scanner", () => {
  test("normalises a relative import that leaves its package", () => {
    const imports = collectImports(REPO_ROOT, ["packages/composition"]);
    expect(imports.length).toBeGreaterThan(0);
    // Every specifier resolves to something a rule can be written against.
    expect(imports.every((entry) => !entry.importedPath.startsWith("."))).toBe(
      true,
    );
  });

  test("attributes files to their workspace package", () => {
    expect(packageOf("packages/runtime/src/runtime.ts")).toBe(
      "packages/runtime",
    );
    expect(packageOf("apps/api/src/runs.ts")).toBe("apps/api");
    expect(packageOf("docs/README.md")).toBeUndefined();
  });
});

describe("the repository obeys its own rules", () => {
  const imports = collectImports(REPO_ROOT, SCANNED_ROOTS);

  test("the scan reaches real source", () => {
    // Guards against the failure this suite was written to fix: rules that
    // pass because nothing was ever examined.
    expect(imports.length).toBeGreaterThan(100);
    expect(
      imports.some((entry) => entry.sourcePath.startsWith("packages/runtime/")),
    ).toBe(true);
  });

  test("no import violates a layer boundary", () => {
    const violations: string[] = [];

    for (const entry of imports) {
      try {
        assertArchitecture(entry);
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        violations.push(
          `${code}  ${entry.sourcePath}:${entry.line}  →  ${entry.specifier}`,
        );
      }
    }

    expect(violations).toEqual([]);
  });
});
