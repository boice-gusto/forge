import {
  CLI_EXIT_CODE,
  type CliResult,
  humanResult,
  jsonResult,
} from "../output.js";

export function runtimeUnavailable(asJson: boolean): CliResult {
  const payload = {
    status: "unavailable",
    code: "WORKFLOW_RUNTIME_UNAVAILABLE",
    message:
      "Workflow execution starts in Phase 2. Use forge validate in Phase 1.",
  };
  return asJson
    ? jsonResult(payload, CLI_EXIT_CODE.UNAVAILABLE)
    : humanResult(payload.message, CLI_EXIT_CODE.UNAVAILABLE);
}
