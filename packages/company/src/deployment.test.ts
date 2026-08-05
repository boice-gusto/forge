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
    expect(NO_COMPANY_POLICY).toEqual({ rules: [], grants: [] });
  });
});
