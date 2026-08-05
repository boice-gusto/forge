import { safeLoadCompanyManifest } from "@forge/manifest";

import {
  CLI_EXIT_CODE,
  type CliResult,
  humanResult,
  jsonResult,
} from "../output.js";

export function invalidManifestResult(asJson: boolean): CliResult {
  const payload = {
    status: "invalid",
    code: "MANIFEST_INVALID",
    message: "A company manifest input is required in Phase 1.",
  };
  return asJson
    ? jsonResult(payload, CLI_EXIT_CODE.INVALID_ARTIFACT)
    : humanResult(payload.message, CLI_EXIT_CODE.INVALID_ARTIFACT);
}

export function validateManifest(input: unknown, asJson: boolean): CliResult {
  const result = safeLoadCompanyManifest(input);
  if (!result.ok) {
    const payload = {
      status: "invalid",
      code: "MANIFEST_INVALID",
      diagnostics: result.diagnostics,
    };
    return asJson
      ? jsonResult(payload, CLI_EXIT_CODE.INVALID_ARTIFACT)
      : humanResult("Manifest is invalid.", CLI_EXIT_CODE.INVALID_ARTIFACT);
  }

  const payload = {
    status: "valid",
    kind: result.value.kind,
    id: result.value.metadata.id,
  };
  return asJson
    ? jsonResult(payload)
    : humanResult(`Manifest is valid: ${payload.id}`);
}
