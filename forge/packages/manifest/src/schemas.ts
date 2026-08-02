import { z } from "zod";

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
        domains: z.array(z.string().trim().min(1)),
      })
      .strict(),
  })
  .strict();

export type CompanyManifest = z.infer<typeof CompanyManifestSchema>;
