import chalk from "chalk";

export const CLI_EXIT_CODE = {
  SUCCESS: 0,
  UNAVAILABLE: 1,
  INVALID_ARTIFACT: 2,
  USAGE: 3,
  INTERNAL: 4,
} as const;

export type CliExitCode = (typeof CLI_EXIT_CODE)[keyof typeof CLI_EXIT_CODE];

export interface CliResult {
  readonly exitCode: CliExitCode;
  readonly stdout: string;
  readonly stderr: string;
}

export function jsonResult(
  payload: object,
  exitCode: CliExitCode = CLI_EXIT_CODE.SUCCESS,
): CliResult {
  return { exitCode, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
}

/**
 * Human-readable output goes to stdout when the command succeeded and to
 * stderr when it did not. Sending a successful result to stderr would mean
 * `forge workflow run > run.txt` captured nothing, and that a caller checking
 * stderr for problems found the happy path there too.
 */
export function humanResult(
  message: string,
  exitCode: CliExitCode = CLI_EXIT_CODE.SUCCESS,
): CliResult {
  const rendered = `${chalk.reset(message)}\n`;
  return exitCode === CLI_EXIT_CODE.SUCCESS
    ? { exitCode, stdout: rendered, stderr: "" }
    : { exitCode, stdout: "", stderr: rendered };
}
