import type { Diagnostic } from "@forge/types";

import { deepFreeze } from "./freeze.js";
import { createRegistry, type Registry } from "./registry.js";
import {
  type AdapterBinding,
  AdapterBindingSchema,
  type PluginManifest,
  type PluginManifestInput,
  PluginManifestSchema,
  type PolicyPack,
  PolicyPackSchema,
  type PromptAsset,
  PromptAssetSchema,
  type SkillDefinition,
  SkillDefinitionSchema,
  type WorkflowContribution,
  WorkflowContributionSchema,
} from "./schemas.js";
import { satisfiesRange } from "./version.js";

/**
 * Plugin host — the Register phase of Discover → Validate → Register → Compile
 * → Execute (009 §4).
 *
 * Fail closed: if any contribution is invalid, duplicated, or asks for more
 * than the host granted, the whole pass fails and the caller receives
 * diagnostics instead of a registry. There is no partial registration, because
 * a half-registered company is a company whose policy packs may not have loaded.
 */

export interface PluginContext {
  readonly companyId: string;
  /** The ceiling. A plugin cannot grant itself anything outside this set. */
  readonly hostCapabilities: readonly string[];
  readonly workflows: Registry<WorkflowContribution>;
  readonly skills: Registry<SkillDefinition>;
  readonly policies: Registry<PolicyPack>;
  readonly prompts: Registry<PromptAsset>;
  readonly adapters: Registry<AdapterBinding>;
  // Deliberately absent: GraphEnginePort, QueuePort, EnginePlan, provider
  // handles, IR mutators. A plugin describes contributions; it does not drive
  // the engine (009 §2, §12).
}

export interface ForgePlugin {
  /**
   * The authoring shape: a plugin that claims no capabilities says so by
   * omission rather than by writing `providedCapabilities: []`. The host reads
   * the parsed manifest, never this one.
   */
  readonly manifest: PluginManifestInput;
  register(context: PluginContext): void | Promise<void>;
}

export interface RegisterOptions {
  readonly companyId: string;
  readonly hostCapabilities: readonly string[];
  /** Host version that plugin `forgeVersion` ranges are checked against. */
  readonly forgeVersion: string;
}

export interface CompanyRegistry {
  readonly companyId: string;
  readonly plugins: readonly PluginManifest[];
  readonly workflows: Registry<WorkflowContribution>;
  readonly skills: Registry<SkillDefinition>;
  readonly policies: Registry<PolicyPack>;
  readonly prompts: Registry<PromptAsset>;
  readonly adapters: Registry<AdapterBinding>;
  /** Every capability granted by a registered policy pack. */
  readonly grantedCapabilities: readonly string[];
}

export type RegisterResult =
  | { readonly ok: true; readonly registry: CompanyRegistry }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function registerPlugins(
  plugins: readonly ForgePlugin[],
  options: RegisterOptions,
): Promise<RegisterResult> {
  const diagnostics: Diagnostic[] = [];

  // Two arrays, deliberately. `ceiling` is private to this function and is what
  // every check reads; `published` is the frozen copy plugins see. A red-team
  // pass raised the ceiling for later plugins with a single
  // `(context.hostCapabilities as string[]).push(...)` when both were one
  // array. Freezing alone would be enough today, but a limit that is only as
  // strong as one `Object.freeze` call is a limit worth holding twice.
  const ceiling = [...options.hostCapabilities];
  const published = deepFreeze([...options.hostCapabilities]);
  const shared = { diagnostics, hostCapabilities: ceiling };

  const workflows = createRegistry<WorkflowContribution>({
    ...shared,
    kind: "workflow",
    schema: WorkflowContributionSchema,
  });
  const skills = createRegistry<SkillDefinition>({
    ...shared,
    kind: "skill",
    schema: SkillDefinitionSchema,
    capabilitiesOf: (skill) => skill.requiredCapabilities,
  });
  // A pack that could grant a capability the host withheld would make the
  // ceiling advisory, so grants are checked against it like any other claim.
  const policies = createRegistry<PolicyPack>({
    ...shared,
    kind: "policy pack",
    schema: PolicyPackSchema,
    capabilitiesOf: (pack) => pack.grants,
  });
  const prompts = createRegistry<PromptAsset>({
    ...shared,
    kind: "prompt",
    schema: PromptAssetSchema,
  });
  const adapters = createRegistry<AdapterBinding>({
    ...shared,
    kind: "adapter binding",
    schema: AdapterBindingSchema,
  });

  const context: PluginContext = {
    companyId: options.companyId,
    hostCapabilities: published,
    workflows,
    skills,
    policies,
    prompts,
    adapters,
  };

  const accepted: PluginManifest[] = [];
  const seen = new Set<string>();

  for (const plugin of plugins) {
    const parsed = PluginManifestSchema.safeParse(plugin.manifest);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        diagnostics.push({
          code: "PLUGIN_INVALID",
          message: issue.message,
          path: ["plugin", ...issue.path.map(String)],
          suggestion: "Correct the plugin manifest.",
        });
      }
      continue;
    }
    const manifest = parsed.data;

    if (seen.has(manifest.id)) {
      diagnostics.push({
        code: "PLUGIN_DUPLICATE_ID",
        message: `Plugin "${manifest.id}" is loaded more than once.`,
        path: ["plugin", manifest.id],
        suggestion:
          "Load each plugin once; check for a duplicated manifest entry.",
      });
      continue;
    }
    seen.add(manifest.id);

    if (!satisfiesRange(options.forgeVersion, manifest.forgeVersion)) {
      diagnostics.push({
        code: "PLUGIN_VERSION_INCOMPATIBLE",
        message: `Plugin "${manifest.id}" requires Forge ${manifest.forgeVersion}, host is ${options.forgeVersion}.`,
        path: ["plugin", manifest.id, "forgeVersion"],
        suggestion:
          "Bump the plugin's compatibility range, or run a host version it supports.",
      });
      continue;
    }

    const claimed = [
      ...manifest.requiredCapabilities,
      ...manifest.providedCapabilities,
    ].filter((capability) => !ceiling.includes(capability));
    if (claimed.length > 0) {
      diagnostics.push({
        code: "PLUGIN_CAPABILITY_ESCALATION",
        message: `Plugin "${manifest.id}" claims ${claimed.map((c) => `"${c}"`).join(", ")}, which the host did not grant.`,
        path: ["plugin", manifest.id, "capabilities"],
        suggestion:
          "Grant the capability at the host, or remove the claim. A plugin cannot widen its own ceiling.",
      });
      continue;
    }

    // Attribution is set before `register` so a duplicate names the plugin that
    // caused it rather than the one that got there first.
    for (const registry of [workflows, skills, policies, prompts, adapters]) {
      registry.attribute(manifest.id);
    }

    try {
      await plugin.register(context);
    } catch (error) {
      diagnostics.push({
        code: "PLUGIN_REGISTER_FAILED",
        message: `Plugin "${manifest.id}" threw during register: ${messageOf(error)}`,
        path: ["plugin", manifest.id],
        suggestion:
          "Registration must be declarative; do not perform work in register().",
      });
      continue;
    }

    accepted.push(manifest);
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };

  return {
    ok: true,
    registry: {
      companyId: options.companyId,
      plugins: accepted,
      workflows,
      skills,
      policies,
      prompts,
      adapters,
      grantedCapabilities: [
        ...new Set(policies.all().flatMap((entry) => entry.value.grants)),
      ].sort(),
    },
  };
}
