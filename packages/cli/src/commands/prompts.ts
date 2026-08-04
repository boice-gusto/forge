import {
  CLI_EXIT_CODE,
  type CliResult,
  humanResult,
  jsonResult,
} from "../output.js";

export function promptsUnavailable(asJson: boolean): CliResult {
  const payload = {
    status: "unavailable",
    code: "PROMPT_REGISTRY_UNAVAILABLE",
    message: "Prompt registry validation is introduced with the runtime.",
  };
  return asJson
    ? jsonResult(payload, CLI_EXIT_CODE.UNAVAILABLE)
    : humanResult(payload.message, CLI_EXIT_CODE.UNAVAILABLE);
}
