import {
  CLI_EXIT_CODE,
  type CliResult,
  humanResult,
  jsonResult,
} from "../output.js";

export function localDevUnavailable(
  action: "up" | "down",
  asJson: boolean,
): CliResult {
  const payload = {
    status: "unavailable",
    code: "LOCAL_COMPOSITION_UNAVAILABLE",
    message: `forge dev ${action} requires the Phase 1 local composition roots.`,
  };
  return asJson
    ? jsonResult(payload, CLI_EXIT_CODE.UNAVAILABLE)
    : humanResult(payload.message, CLI_EXIT_CODE.UNAVAILABLE);
}
