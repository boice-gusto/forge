import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { redact } from "@forge/observability";

import {
  CLI_EXIT_CODE,
  type CliResult,
  humanResult,
  jsonResult,
} from "../output.js";

const LOCAL_COMPOSE_FILE = "forge/infra/local/compose.yaml";
const LOCAL_SERVICES = ["redis", "postgres", "otel"] as const;
const executeFile = promisify(execFile);

export interface CommandExecution {
  readonly exitCode: number;
  readonly stderr: string;
}

export type CommandRunner = (
  args: readonly string[],
) => Promise<CommandExecution>;

async function dockerRunner(
  args: readonly string[],
): Promise<CommandExecution> {
  try {
    const { stderr } = await executeFile("docker", [...args]);
    return { exitCode: 0, stderr };
  } catch (error: unknown) {
    return {
      exitCode: 1,
      stderr: error instanceof Error ? error.message : "Docker command failed.",
    };
  }
}

export async function runLocalComposition(
  action: "up" | "down",
  asJson: boolean,
  runner: CommandRunner = dockerRunner,
): Promise<CliResult> {
  const args =
    action === "up"
      ? [
          "compose",
          "-f",
          LOCAL_COMPOSE_FILE,
          "up",
          "--detach",
          ...LOCAL_SERVICES,
        ]
      : ["compose", "-f", LOCAL_COMPOSE_FILE, "down"];
  const execution = await runner(args);

  if (execution.exitCode !== 0) {
    const payload = {
      status: "unavailable",
      code: "LOCAL_COMPOSITION_UNAVAILABLE",
      message: `forge dev ${action} could not manage named local resources.`,
      diagnostic: String(redact(execution.stderr)),
    };
    return asJson
      ? jsonResult(payload, CLI_EXIT_CODE.UNAVAILABLE)
      : humanResult(payload.message, CLI_EXIT_CODE.UNAVAILABLE);
  }

  const payload = { status: "ready", action, resources: LOCAL_SERVICES };
  return asJson
    ? jsonResult(payload)
    : humanResult(
        `Local Forge infrastructure ${action}: ${LOCAL_SERVICES.join(", ")}`,
      );
}
