import type { Diagnostic } from "@forge/types";

import { type CompanyManifest, CompanyManifestSchema } from "./schemas.js";

export type ManifestLoadResult =
  | { readonly ok: true; readonly value: CompanyManifest }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export function safeLoadCompanyManifest(input: unknown): ManifestLoadResult {
  const result = CompanyManifestSchema.safeParse(input);

  if (result.success) {
    return { ok: true, value: result.data };
  }

  return {
    ok: false,
    diagnostics: result.error.issues.map((issue) => ({
      code: "MANIFEST_INVALID",
      message: issue.message,
      path: issue.path.map(String),
      suggestion: "Correct the manifest value and validate again.",
    })),
  };
}
