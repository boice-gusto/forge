import { z } from "zod";

/**
 * Company manifest (009 §9) — the root of a company package.
 *
 * Config is referenced, never inlined: an org's Slack channel id belongs in its
 * config and a secret belongs in a secret manager, so nothing here may name
 * either.
 */

const Reference = z.string().trim().min(1);

const PluginReferenceSchema = z
  .object({
    /** Module specifier the loader resolves, e.g. `./plugins/marketing.js`. */
    package: Reference,
    /** Range checked against the host Forge version at register time. */
    version: Reference,
  })
  .strict();

const AdapterEntrySchema = z
  .object({
    binding: Reference,
    configRef: Reference.optional(),
  })
  .strict();

export const CompanyManifestSchema = z
  .object({
    apiVersion: z.literal("forge.dev/v1"),
    kind: z.literal("Company"),
    metadata: z
      .object({
        id: z.string().trim().min(1),
        name: z.string().trim().min(1),
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
      })
      .strict(),
    spec: z
      .object({
        domains: z.array(Reference),
        plugins: z.array(PluginReferenceSchema).default([]),
        policyPacks: z.array(Reference).default([]),
        adapters: z.record(Reference, AdapterEntrySchema).default({}),
        /**
         * Capabilities the company asks the host to grant. The host is free to
         * grant fewer; this is a request, not a self-issued permission.
         */
        capabilities: z.array(Reference).default([]),
        defaults: z
          .object({
            approvalRequiredFor: z.array(Reference).default([]),
          })
          .strict()
          .default({ approvalRequiredFor: [] }),
      })
      .strict(),
  })
  .strict();

export type CompanyManifest = z.infer<typeof CompanyManifestSchema>;
export type PluginReference = z.infer<typeof PluginReferenceSchema>;
