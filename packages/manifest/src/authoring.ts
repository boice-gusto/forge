import { z } from "zod";

/**
 * Authoring schemas for company contributions (009 §5, §8).
 *
 * Everything a plugin contributes is parsed before it is registered. A plugin
 * is third-party code from core's point of view — including our own company
 * package — so the boundary validates rather than trusts.
 *
 * These live in `@forge/manifest` because 004 names it the owner of the
 * authoring surface. `@forge/plugin-sdk` re-exports them, so a company package
 * that imports the SDK alone is unaffected.
 */

export const SemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "Version must be an exact semver, e.g. 1.0.0.");

export const IdentifierSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/,
    "Ids are lowercase, dot- or dash-separated, e.g. gusto.benefits.kb-retrieve.",
  );

/** A capability is a dotted action name; `*` is never a valid capability. */
export const CapabilitySchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/,
    "Capabilities are dotted action names, e.g. benefits.kb.read. Wildcards are not capabilities.",
  );

export const SkillDefinitionSchema = z
  .object({
    id: IdentifierSchema,
    version: SemverSchema,
    /** Schema refs, not schemas — the compiler resolves them (007). */
    inputRef: z.string().trim().min(1),
    outputRef: z.string().trim().min(1),
    requiredCapabilities: z.array(CapabilitySchema).default([]),
    requiresSandbox: z.boolean().default(false),
  })
  .strict();

export const PromptAssetSchema = z
  .object({
    id: IdentifierSchema,
    version: SemverSchema,
    /**
     * A prompt is referenced by id and version, never inlined into a workflow
     * (009 §10). The text lives here so it is versioned and reviewable.
     */
    text: z.string().min(1),
  })
  .strict();

export const PolicyPackSchema = z
  .object({
    id: IdentifierSchema,
    version: SemverSchema,
    /**
     * Capabilities this pack grants. Grants are the only way a capability is
     * satisfied; a skill requesting one it is not granted fails closed at
     * compile with WF_CAPABILITY_UNBOUND.
     */
    grants: z.array(CapabilitySchema).default([]),
    rules: z
      .array(
        z
          .object({
            id: IdentifierSchema,
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

export type SkillDefinition = z.infer<typeof SkillDefinitionSchema>;
export type PromptAsset = z.infer<typeof PromptAssetSchema>;
export type PolicyPack = z.infer<typeof PolicyPackSchema>;

/**
 * The authoring view of each artifact.
 *
 * A `.default()` makes a field *required* on the inferred output type, so
 * annotating a literal with `PolicyPack` forces `approvers: []` onto every rule
 * that has no approvers — writing out the default in order to say nothing.
 * `z.input` is the shape an author may write; the `z.infer` type above is what
 * comes back once parsing has applied the defaults.
 */
export type SkillDefinitionInput = z.input<typeof SkillDefinitionSchema>;
export type PromptAssetInput = z.input<typeof PromptAssetSchema>;
export type PolicyPackInput = z.input<typeof PolicyPackSchema>;
