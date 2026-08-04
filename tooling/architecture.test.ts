import { describe, expect, test } from "vitest";

import { assertArchitecture } from "./assert-architecture.js";

describe("architecture rules", () => {
  test("rejects a public package importing a private adapter", () => {
    expect(() =>
      assertArchitecture({
        sourcePath: "packages/sdk/src/index.ts",
        importedPath: "@forge/adapters-provider-acp",
      }),
    ).toThrow("FORGE_PRIVATE_ADAPTER_IMPORT");
  });

  test("rejects core importing a company extension", () => {
    expect(() =>
      assertArchitecture({
        sourcePath: "packages/runtime/src/index.ts",
        importedPath: "forge.gusto",
      }),
    ).toThrow("FORGE_EXTENSION_IMPORT");
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
