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

describe("company manifest — 009 §9 fields", () => {
  const base = {
    apiVersion: "forge.dev/v1" as const,
    kind: "Company" as const,
    metadata: { id: "acme", name: "Acme", version: "1.0.0" },
  };

  test("optional sections default rather than being required", () => {
    const result = safeLoadCompanyManifest({
      ...base,
      spec: { domains: ["domains/marketing"] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.spec.plugins).toEqual([]);
    expect(result.value.spec.policyPacks).toEqual([]);
    expect(result.value.spec.adapters).toEqual({});
    expect(result.value.spec.capabilities).toEqual([]);
    expect(result.value.spec.defaults.approvalRequiredFor).toEqual([]);
  });

  test("a fully populated manifest round-trips", () => {
    const result = safeLoadCompanyManifest({
      ...base,
      spec: {
        domains: ["domains/marketing"],
        plugins: [{ package: "./plugins/marketing.js", version: "^0.1.0" }],
        policyPacks: ["policies/publish"],
        adapters: {
          notification: {
            binding: "@acme/adapter-slack",
            configRef: "config/slack",
          },
        },
        capabilities: ["docs.write"],
        defaults: { approvalRequiredFor: ["external.publish"] },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.spec.plugins[0]?.package).toBe(
      "./plugins/marketing.js",
    );
    expect(result.value.spec.adapters.notification?.configRef).toBe(
      "config/slack",
    );
  });

  test("an unknown key is refused rather than ignored", () => {
    const result = safeLoadCompanyManifest({
      ...base,
      spec: { domains: [], secrets: { slackToken: "xoxb-nope" } },
    });

    // A manifest is not a place to smuggle configuration the loader would
    // silently drop — or a secret it would silently keep.
    expect(result.ok).toBe(false);
  });

  test("a plugin reference without a version is refused", () => {
    const result = safeLoadCompanyManifest({
      ...base,
      spec: { domains: [], plugins: [{ package: "./p.js" }] },
    });

    expect(result.ok).toBe(false);
  });
});
