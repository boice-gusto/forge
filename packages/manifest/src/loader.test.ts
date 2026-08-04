import { describe, expect, test } from "vitest";

import { safeLoadCompanyManifest } from "./loader.js";

describe("safeLoadCompanyManifest", () => {
  test("returns a typed manifest for valid data", () => {
    const result = safeLoadCompanyManifest({
      apiVersion: "forge.dev/v1",
      kind: "Company",
      metadata: { id: "acme", name: "Acme", version: "1.0.0" },
      spec: { domains: [] },
    });

    expect(result.ok).toBe(true);
  });

  test("returns diagnostics instead of throwing for invalid data", () => {
    const result = safeLoadCompanyManifest({
      apiVersion: "forge.dev/v1",
      kind: "Company",
      metadata: { id: "", name: "", version: "not-semver" },
      spec: { domains: [] },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "MANIFEST_INVALID" }),
        ]),
      }),
    );
  });
});
