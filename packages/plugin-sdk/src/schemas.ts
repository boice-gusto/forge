import { z } from "zod";

/**
 * Authoring schemas for company contributions (009 §5, §8).
 *
 * Everything a plugin contributes is parsed before it is registered. A plugin
 * is third-party code from core's point of view — including our own company
 * package — so the boundary validates rather than trusts.
 */

const Semver = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "Version must be an exact semver, e.g. 1.0.0.");

const Identifier = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/,
    "Ids are lowercase, dot- or dash-separated, e.g. gusto.benefits.kb-retrieve.",
  );

/** A capability is a dotted action name; `*` is never a valid capability. */
const Capability = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/,
    "Capabilities are dotted action names, e.g. benefits.kb.read. Wildcards are not capabilities.",
  );

export const SkillDefinitionSchema = z
  .object({
    id: Identifier,
    version: Semver,
    /** Schema refs, not schemas — the compiler resolves them (007). */
    inputRef: z.string().trim().min(1),
    outputRef: z.string().trim().min(1),
    requiredCapabilities: z.array(Capability).default([]),
    requiresSandbox: z.boolean().default(false),
  })
  .strict();

export const PromptAssetSchema = z
  .object({
    id: Identifier,
    version: Semver,
    /**
     * A prompt is referenced by id and version, never inlined into a workflow
     * (009 §10). The text lives here so it is versioned and reviewable.
     */
    text: z.string().min(1),
  })
  .strict();

export const PolicyPackSchema = z
  .object({
    id: Identifier,
    version: Semver,
    /**
     * Capabilities this pack grants. Grants are the only way a capability is
     * satisfied; a skill requesting one it is not granted fails closed at
     * compile with WF_CAPABILITY_UNBOUND.
     */
    grants: z.array(Capability).default([]),
    rules: z
      .array(
        z
          .object({
            id: Identifier,
            action: z.string().trim().min(1),
            environment: z.string().trim().min(1).optional(),
            decision: z.enum(["allow", "deny", "require-approval"]),
            reason: z.string().trim().min(1),
            approvers: z.array(z.string().trim().min(1)).default([]),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

/**
 * A workflow contribution is carried as an opaque source object. The plugin SDK
 * checks that it is identifiable and versioned; the compiler owns its shape.
 * Duplicating the IR taxonomy here would put two definitions of a workflow in
 * the repository, and they would drift.
 */
export const WorkflowContributionSchema = z
  .looseObject({
    id: z.string().trim().min(1),
    version: Semver,
  })
  .describe("Workflow source, validated in full by the compiler.");

export const AdapterBindingSchema = z
  .object({
    /** The port this binding satisfies, e.g. `notification`. One per port. */
    id: Identifier,
    /** Module specifier resolved at company boot, not by the SDK. */
    binding: z.string().trim().min(1),
    /** Config reference — never an inline channel id or secret (009 §9). */
    configRef: z.string().trim().min(1).optional(),
  })
  .strict();

export const PluginManifestSchema = z
  .object({
    id: Identifier,
    version: Semver,
    /** Range the plugin claims compatibility with, checked by the loader. */
    forgeVersion: z.string().trim().min(1),
    requiredCapabilities: z.array(Capability).default([]),
    providedCapabilities: z.array(Capability).default([]),
  })
  .strict();

export type SkillDefinition = z.infer<typeof SkillDefinitionSchema>;
export type PromptAsset = z.infer<typeof PromptAssetSchema>;
export type PolicyPack = z.infer<typeof PolicyPackSchema>;
export type WorkflowContribution = z.infer<typeof WorkflowContributionSchema>;
export type AdapterBinding = z.infer<typeof AdapterBindingSchema>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
