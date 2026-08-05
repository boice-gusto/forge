import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCompany } from "@forge/company";
import { describe, expect, test } from "vitest";

import { compileToArtifact, createLocalStack } from "./local.js";

/**
 * Acceptance: a real company package on disk, loaded and run (009 §17).
 *
 * This is the test that makes the plugin SDK load-bearing rather than a package
 * that merely exists. It reads `examples/acme/forge.company.json`, imports the
 * plugin the manifest names, compiles the workflow that plugin contributed, and
 * runs it — with no core file knowing anything about Acme.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ACME = resolve(REPO_ROOT, "examples/acme");
const HOST_CAPABILITIES = ["repo.read", "docs.write", "slack.write"];

async function loadAcme(hostCapabilities = HOST_CAPABILITIES) {
  const result = await loadCompany({
    root: ACME,
    hostCapabilities,
    forgeVersion: "0.1.0",
  });
  if (!result.ok) {
    throw new Error(
      `acme failed to load: ${result.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`,
    );
  }
  return result.company;
}

describe("acceptance: the acme company package loads", () => {
  test("the manifest and its plugin register without core knowing acme", async () => {
    const company = await loadAcme();

    expect(company.manifest.metadata.id).toBe("acme");
    expect(company.registry.plugins.map((manifest) => manifest.id)).toEqual([
      "acme.plugin-marketing",
    ]);
  });

  test("contributions arrive in every registry the plugin used", async () => {
    const { registry } = await loadAcme();

    expect(
      registry.workflows.get("acme.marketing.brief-approval"),
    ).toBeDefined();
    expect(
      registry.skills.get("acme.slack-post")?.requiredCapabilities,
    ).toEqual(["slack.write"]);
    expect(registry.prompts.get("acme.marketing.draft")).toBeDefined();
    expect(registry.adapters.get("notification")?.configRef).toBe(
      "config/notification",
    );
    expect(registry.grantedCapabilities).toEqual([
      "docs.write",
      "repo.read",
      "slack.write",
    ]);
  });

  test("the manifest names no secret and no org-specific id", async () => {
    const company = await loadAcme();
    const serialised = JSON.stringify(company.manifest);

    // Config is referenced, never inlined (009 §9). A channel id or token here
    // would be a secret in version control.
    expect(serialised).not.toMatch(/xoxb-|Bearer |-----BEGIN/);
    expect(company.manifest.spec.adapters.notification?.configRef).toBe(
      "config/notification",
    );
  });
});

describe("acceptance: a contributed workflow compiles and runs", () => {
  test("the workflow the plugin contributed compiles to a sealed artifact", async () => {
    const { registry } = await loadAcme();
    const contributed = registry.workflows.get("acme.marketing.brief-approval");

    const outcome = compileToArtifact(contributed);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(outcome.diagnostics.map((d) => d.code).join(", "));
    }
    expect(outcome.artifact.workflowId).toBe("acme.marketing.brief-approval");
    expect(outcome.artifact.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test("it parks at the gate and dispatches nothing", async () => {
    const company = await loadAcme();
    const contributed = company.registry.workflows.get(
      "acme.marketing.brief-approval",
    );
    const outcome = compileToArtifact(contributed);
    if (!outcome.ok) throw new Error("must compile");

    // The policy the company contributed is what makes this gate, not a rule
    // written in core.
    const pack = company.registry.policies.get("acme.marketing.publish");
    const stack = createLocalStack({
      rules: pack?.rules ?? [],
      grants: [...company.registry.grantedCapabilities],
      environment: "production",
    });

    const run = await stack.runtime.start({
      artifact: outcome.artifact,
      capabilities: [...company.grantedCapabilities],
    });

    expect(run.status).toBe("AWAITING_APPROVAL");
    expect(stack.dispatched).toEqual([]);

    const pending = await stack.runtime.getApproval(
      run.pendingApprovalId as string,
    );
    expect(pending?.nodeId).toBe("publish");
    expect(pending?.effect).toBe("slack.post");
    expect(pending?.approvers).toEqual(["marketing-lead"]);
  });

  test("a human decision releases exactly the gated effect", async () => {
    const company = await loadAcme();
    const contributed = company.registry.workflows.get(
      "acme.marketing.brief-approval",
    );
    const outcome = compileToArtifact(contributed);
    if (!outcome.ok) throw new Error("must compile");

    const pack = company.registry.policies.get("acme.marketing.publish");
    const stack = createLocalStack({
      rules: pack?.rules ?? [],
      grants: [...company.registry.grantedCapabilities],
      environment: "production",
    });

    const run = await stack.runtime.start({
      artifact: outcome.artifact,
      capabilities: [...company.grantedCapabilities],
    });
    const decided = await stack.runtime.decide(
      run.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(decided.status).toBe("SUCCEEDED");
    expect(stack.dispatched).toEqual(["slack.post"]);
  });
});

describe("acceptance: the host, not the company, sets the ceiling", () => {
  test("withholding a capability the plugin needs refuses the load", async () => {
    // Acme's manifest asks for slack.write and its plugin requires it. A host
    // that declines to grant it gets a refusal, not a quiet downgrade.
    const result = await loadCompany({
      root: ACME,
      hostCapabilities: ["repo.read", "docs.write"],
      forgeVersion: "0.1.0",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "PLUGIN_CAPABILITY_ESCALATION",
    );
  });

  test("a host on an incompatible version refuses the plugin", async () => {
    const result = await loadCompany({
      root: ACME,
      hostCapabilities: HOST_CAPABILITIES,
      forgeVersion: "2.0.0",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "PLUGIN_VERSION_INCOMPATIBLE",
    ]);
  });
});
