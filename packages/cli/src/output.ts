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

export function humanResult(
  message: string,
  exitCode: CliExitCode = CLI_EXIT_CODE.SUCCESS,
): CliResult {
  return { exitCode, stdout: "", stderr: `${chalk.reset(message)}\n` };
}
