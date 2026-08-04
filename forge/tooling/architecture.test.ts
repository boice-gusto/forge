import { describe, expect, test } from "vitest";

import { assertArchitecture } from "./assert-architecture.js";

describe("architecture rules", () => {
  test("rejects a public package importing a private adapter", () => {
    expect(() =>
      assertArchitecture({
        sourcePath: "forge/packages/sdk/src/index.ts",
        importedPath: "@forge/adapters-provider-acp",
      }),
    ).toThrow("FORGE_PRIVATE_ADAPTER_IMPORT");
  });

  test("rejects core importing a company extension", () => {
    expect(() =>
      assertArchitecture({
        sourcePath: "forge/packages/runtime/src/index.ts",
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
});
