import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForgePlugin } from "@forge/plugin-sdk";
import { describe, expect, test } from "vitest";

import { loadCompany } from "./loader.js";

const HOST = ["repo.read", "docs.write", "slack.write"];
const OPTIONS = { hostCapabilities: HOST, forgeVersion: "0.1.0" };

const MANIFEST = {
  apiVersion: "forge.dev/v1",
  kind: "Company",
  metadata: { id: "test", name: "Test", version: "0.1.0" },
  spec: { domains: ["domains/x"] },
};

function companyDir(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-company-"));
  if (manifest !== undefined) {
    writeFileSync(
      join(dir, "forge.company.json"),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    );
  }
  return dir;
}

const noopPlugin: ForgePlugin = {
  manifest: {
    id: "test.plugin",
    version: "1.0.0",
    forgeVersion: "^0.1.0",
    requiredCapabilities: [],
    providedCapabilities: [],
  },
  register: () => undefined,
};

const withPlugin = (extra: Record<string, unknown> = {}) => ({
  ...MANIFEST,
  spec: {
    ...MANIFEST.spec,
    plugins: [{ package: "./plugins/p.js", version: "^0.1.0" }],
    ...extra,
  },
});

const codes = (result: Awaited<ReturnType<typeof loadCompany>>) =>
  result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code);

describe("loading a company package", () => {
  test("a manifest with no plugins loads and grants the host ceiling", async () => {
    const result = await loadCompany({
      ...OPTIONS,
      root: companyDir(MANIFEST),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.company.manifest.metadata.id).toBe("test");
    expect(result.company.grantedCapabilities).toEqual(HOST);
  });

  test("a plugin exported as default is registered", async () => {
    const result = await loadCompany({
      ...OPTIONS,
      root: companyDir(withPlugin()),
      importModule: async () => ({ default: noopPlugin }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.company.registry.plugins.map((m) => m.id)).toEqual([
      "test.plugin",
    ]);
  });

  test("a plugin exported as `plugin` is also accepted", async () => {
    const result = await loadCompany({
      ...OPTIONS,
      root: companyDir(withPlugin()),
      importModule: async () => ({ plugin: noopPlugin }),
    });

    expect(result.ok).toBe(true);
  });

  test("a relative specifier resolves against the company root, not the cwd", async () => {
    const root = companyDir(withPlugin());
    let requested = "";
    await loadCompany({
      ...OPTIONS,
      root,
      importModule: async (specifier) => {
        requested = specifier;
        return { default: noopPlugin };
      },
    });

    expect(requested).toContain(root.replace(/^\/private/, ""));
    expect(requested.startsWith("file://")).toBe(true);
  });

  test("a bare specifier is passed through untouched", async () => {
    let requested = "";
    await loadCompany({
      ...OPTIONS,
      root: companyDir({
        ...MANIFEST,
        spec: {
          ...MANIFEST.spec,
          plugins: [{ package: "@acme/plugin-marketing", version: "^0.1.0" }],
        },
      }),
      importModule: async (specifier) => {
        requested = specifier;
        return { default: noopPlugin };
      },
    });

    expect(requested).toBe("@acme/plugin-marketing");
  });
});

describe("the manifest requests capabilities, it does not grant them", () => {
  test("a request is intersected with the host ceiling", async () => {
    const result = await loadCompany({
      ...OPTIONS,
      root: companyDir({
        ...MANIFEST,
        spec: { ...MANIFEST.spec, capabilities: ["docs.write"] },
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.company.grantedCapabilities).toEqual(["docs.write"]);
  });

  test("asking for more than the host offers does not produce more", async () => {
    // The load-bearing case: a company package edits its own manifest to ask
    // for `prod.delete`. It gets nothing extra, because the manifest is a
    // request and the host is the authority.
    const result = await loadCompany({
      ...OPTIONS,
      root: companyDir({
        ...MANIFEST,
        spec: {
          ...MANIFEST.spec,
          capabilities: ["docs.write", "prod.delete", "payments.initiate"],
        },
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.company.grantedCapabilities).toEqual(["docs.write"]);
  });

  test("a plugin cannot claim past the intersected grant", async () => {
    const greedy: ForgePlugin = {
      manifest: {
        ...noopPlugin.manifest,
        requiredCapabilities: ["slack.write"],
      },
      register: () => undefined,
    };

    // The host grants slack.write, but this company narrowed itself to
    // docs.write. The narrower of the two wins.
    const result = await loadCompany({
      ...OPTIONS,
      root: companyDir(withPlugin({ capabilities: ["docs.write"] })),
      importModule: async () => ({ default: greedy }),
    });

    expect(codes(result)).toEqual(["PLUGIN_CAPABILITY_ESCALATION"]);
  });
});

describe("loading fails closed", () => {
  test("a missing manifest is a diagnostic, not a throw", async () => {
    const result = await loadCompany({
      ...OPTIONS,
      root: companyDir(undefined),
    });

    expect(codes(result)).toEqual(["COMPANY_MANIFEST_UNREADABLE"]);
  });

  test("a manifest that is not JSON is reported", async () => {
    const result = await loadCompany({
      ...OPTIONS,
      root: companyDir("{ not json"),
    });

    expect(codes(result)).toEqual(["COMPANY_MANIFEST_UNREADABLE"]);
  });

  test("an invalid manifest reports the manifest diagnostics", async () => {
    const result = await loadCompany({
      ...OPTIONS,
      root: companyDir({
        ...MANIFEST,
        metadata: { id: "", name: "", version: "x" },
      }),
    });

    expect(codes(result)).toContain("MANIFEST_INVALID");
  });

  test("a plugin module that fails to import is reported by specifier", async () => {
    const result = await loadCompany({
      ...OPTIONS,
      root: companyDir(withPlugin()),
      importModule: async () => {
        throw new Error("ENOENT");
      },
    });

    expect(codes(result)).toEqual(["COMPANY_PLUGIN_UNRESOLVED"]);
    if (result.ok) throw new Error("unreachable");
    expect(result.diagnostics[0]?.message).toContain("./plugins/p.js");
  });

  test("a module exporting no plugin is refused rather than guessed at", async () => {
    const result = await loadCompany({
      ...OPTIONS,
      root: companyDir(withPlugin()),
      importModule: async () => ({ somethingElse: { register: 1 } }),
    });

    expect(codes(result)).toEqual(["COMPANY_PLUGIN_INVALID"]);
  });

  test("an object that only looks plugin-shaped is refused", async () => {
    const result = await loadCompany({
      ...OPTIONS,
      root: companyDir(withPlugin()),
      // Has `manifest` and `register`, but register is not callable.
      importModule: async () => ({
        default: { manifest: noopPlugin.manifest, register: "not a function" },
      }),
    });

    expect(codes(result)).toEqual(["COMPANY_PLUGIN_INVALID"]);
  });

  test("registration diagnostics surface through the loader", async () => {
    const broken: ForgePlugin = {
      manifest: noopPlugin.manifest,
      register: (context) => {
        context.skills.add({ id: "bad", version: "nope" });
      },
    };

    const result = await loadCompany({
      ...OPTIONS,
      root: companyDir(withPlugin()),
      importModule: async () => ({ default: broken }),
    });

    // Every fault, not just the first: bad version plus the two missing refs.
    expect(codes(result)).toEqual([
      "PLUGIN_INVALID",
      "PLUGIN_INVALID",
      "PLUGIN_INVALID",
    ]);
  });
});
