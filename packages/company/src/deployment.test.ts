import { relative as relativePath } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  CompanyLoadError,
  loadDeploymentPolicy,
  NO_COMPANY_POLICY,
} from "./deployment.js";

const ACME = fileURLToPath(new URL("../../../examples/acme", import.meta.url));

describe("the control plane's policy comes from the company package", () => {
  test("the packs a company registered become the deployment's rule set", async () => {
    const policy = await loadDeploymentPolicy({
      root: ACME,
      hostCapabilities: ["repo.read", "docs.write", "slack.write"],
      forgeVersion: "0.1.0",
    });

    expect(policy.rules.map((rule) => rule.id)).toEqual([
      "acme.marketing.external-publish",
    ]);
    expect(policy.rules[0]?.approvers).toEqual(["marketing-lead"]);
    expect(policy.rules[0]?.decision).toBe("require-approval");
  });

  test("the grants are the host ceiling, not what the manifest asked for", async () => {
    // Acme's manifest requests repo.read, docs.write and slack.write. A host
    // offering only one of them grants only that one — a package that could
    // widen its own ceiling by editing its own manifest would not have one.
    const policy = await loadDeploymentPolicy({
      root: ACME,
      hostCapabilities: ["repo.read", "docs.write", "slack.write"],
      forgeVersion: "0.1.0",
    });

    expect([...policy.grants].sort()).toEqual([
      "docs.write",
      "repo.read",
      "slack.write",
    ]);
  });

  test("the adapters a company binds are imported at boot, not at first use", async () => {
    /**
     * A manifest naming a module is a promise until something imports it. Acme
     * named `@forge/provider-mock`, which Acme does not depend on — so the
     * binding had never once resolved, and nothing noticed, because nothing
     * ever tried. A deployment that discovers its notification adapter does
     * not exist at the first gated action has discovered it in the worst
     * possible place: after a human approved something.
     */
    const policy = await loadDeploymentPolicy({
      root: ACME,
      hostCapabilities: ["repo.read", "docs.write", "slack.write"],
      forgeVersion: "0.1.0",
    });

    expect(Object.keys(policy.adapters).sort()).toEqual([
      "effects",
      "notification",
    ]);
    // Resolved to the module itself, not to its name.
    expect(
      typeof (policy.adapters.effects as { default: { perform: unknown } })
        .default.perform,
    ).toBe("function");
  });

  test("an adapter named by package resolves the way the company would resolve it", async () => {
    // Not the way Forge would. Imported from `@forge/company`, a bare
    // specifier finds `@forge/company`'s dependencies, so a company could only
    // ever bind packages Forge already depends on. Acme's binding named one it
    // did not depend on and had therefore never once loaded.
    // Given relative, which is what a CLI invocation hands in — and which is
    // the case that has to be made absolute before anything resolves against
    // it, or it resolves against whatever directory the process started in.
    const policy = await loadDeploymentPolicy({
      root: relativePath(
        process.cwd(),
        fileURLToPath(new URL("./fixtures/bare-adapter", import.meta.url)),
      ),
      hostCapabilities: [],
      forgeVersion: "0.1.0",
    });

    expect(Object.keys(policy.adapters)).toEqual(["effects"]);
    expect(policy.adapters.effects).toBeDefined();
  });

  test("an adapter naming a module that will not import stops the boot", async () => {
    // Fail closed and at the same moment as an unloadable policy pack, for the
    // same reason: a deployment that came up with half its adapters would
    // perform some gated actions and silently drop the rest, and the dropped
    // ones would read as workflow problems.
    const failed = await loadDeploymentPolicy({
      root: fileURLToPath(
        new URL("./fixtures/broken-adapter", import.meta.url),
      ),
      hostCapabilities: [],
      forgeVersion: "0.1.0",
    }).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(CompanyLoadError);
    expect((failed as CompanyLoadError).diagnostics[0]?.code).toBe(
      "CO_ADAPTER_UNRESOLVED",
    );
  });

  test("a company that cannot load stops the boot and names every fault", async () => {
    // Fail closed and loud. A control plane that started anyway would have no
    // policy packs, so every gated effect would be denied by default and the
    // failure would read as a workflow problem rather than a boot problem.
    const failed = await loadDeploymentPolicy({
      root: fileURLToPath(new URL("../../../examples", import.meta.url)),
      hostCapabilities: [],
      forgeVersion: "0.1.0",
    }).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(CompanyLoadError);
    const error = failed as CompanyLoadError;
    expect(error.diagnostics[0]?.code).toBe("COMPANY_MANIFEST_UNREADABLE");
    expect(error.message).toContain(
      "the control plane has no policy without it",
    );
  });

  test("a host that names no ceiling refuses the package rather than shrinking it", async () => {
    // The pack's `grants` are checked against the ceiling like any other
    // claim, so an empty ceiling is a load failure, not a quiet downgrade to a
    // company that can do nothing.
    const failed = await loadDeploymentPolicy({
      root: ACME,
      hostCapabilities: [],
      forgeVersion: "0.1.0",
    }).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(CompanyLoadError);
    expect((failed as CompanyLoadError).diagnostics[0]?.code).toBe(
      "PLUGIN_CAPABILITY_ESCALATION",
    );
  });

  test("no company package means no grants and no rules", () => {
    expect(NO_COMPANY_POLICY).toEqual({ rules: [], grants: [], adapters: {} });
  });
});
