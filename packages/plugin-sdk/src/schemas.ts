import {
  CapabilitySchema,
  IdentifierSchema,
  SemverSchema,
} from "@forge/manifest";
import { z } from "zod";

/**
 * Plugin host schemas (009 §5, §9) — the plugin's own paperwork: the manifest
 * it presents to the host, and the adapter bindings it asks the host to wire.
 *
 * What it *contributes* (skills, prompts, policy packs) is the authoring
 * surface and lives in `@forge/manifest` (004), re-exported below so a company
 * package can keep importing the SDK alone.
 */

export {
  type PolicyPack,
  type PolicyPackInput,
  PolicyPackSchema,
  type PromptAsset,
  type PromptAssetInput,
  PromptAssetSchema,
  type SkillDefinition,
  type SkillDefinitionInput,
  SkillDefinitionSchema,
} from "@forge/manifest";

/**
 * Opaque on purpose: the SDK checks only that a contribution is identifiable
 * and versioned, because duplicating the IR taxonomy here would put two
 * definitions of a workflow in the repository and they would drift.
 */
export const WorkflowContributionSchema = z
  .looseObject({
    id: z.string().trim().min(1),
    version: SemverSchema,
  })
  .describe("Workflow source, validated in full by the compiler.");

export const AdapterBindingSchema = z
  .object({
    /** The port this binding satisfies, e.g. `notification`. One per port. */
    id: IdentifierSchema,
    /** Module specifier resolved at company boot, not by the SDK. */
    binding: z.string().trim().min(1),
    /** Config reference — never an inline channel id or secret (009 §9). */
    configRef: z.string().trim().min(1).optional(),
  })
  .strict();

export const PluginManifestSchema = z
  .object({
    id: IdentifierSchema,
    version: SemverSchema,
    /** Range the plugin claims compatibility with, checked by the loader. */
    forgeVersion: z.string().trim().min(1),
    requiredCapabilities: z.array(CapabilitySchema).default([]),
    providedCapabilities: z.array(CapabilitySchema).default([]),
  })
  .strict();

export type WorkflowContribution = z.infer<typeof WorkflowContributionSchema>;
export type AdapterBinding = z.infer<typeof AdapterBindingSchema>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** The authoring view — see the same note in `@forge/manifest`'s `authoring`. */
export type WorkflowContributionInput = z.input<
  typeof WorkflowContributionSchema
>;
export type AdapterBindingInput = z.input<typeof AdapterBindingSchema>;
export type PluginManifestInput = z.input<typeof PluginManifestSchema>;
