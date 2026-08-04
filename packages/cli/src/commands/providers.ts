import {
  CLI_EXIT_CODE,
  type CliResult,
  humanResult,
  jsonResult,
} from "../output.js";

const PROVIDERS = [
  { id: "mock", status: "ready" },
  { id: "claude-cli", status: "not-configured" },
  { id: "codex-cli", status: "not-configured" },
  { id: "direct-api", status: "not-configured" },
] as const;

export function doctorProviders(asJson: boolean): CliResult {
  const payload = { status: "ready", providers: PROVIDERS };
  if (asJson) return jsonResult(payload);

  return humanResult(
    [
      "mock: ready",
      "claude-cli: not configured (install Claude CLI and configure a profile)",
      "codex-cli: not configured (install Codex CLI and configure a profile)",
      "direct-api: not configured (configure a provider profile)",
    ].join("\n"),
    CLI_EXIT_CODE.SUCCESS,
  );
}
