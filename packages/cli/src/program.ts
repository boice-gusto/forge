import { runLocalComposition } from "./commands/dev.js";
import { promptsUnavailable } from "./commands/prompts.js";
import { doctorProviders } from "./commands/providers.js";
import {
  invalidManifestResult,
  validateManifest,
} from "./commands/validate.js";
import { compileWorkflowFile, runWorkflowFile } from "./commands/workflow.js";
import { CLI_EXIT_CODE, type CliResult, humanResult } from "./output.js";

function usesJson(args: readonly string[]): boolean {
  return args.includes("--json");
}

function inputPath(args: readonly string[]): string | undefined {
  const index = args.indexOf("--input");
  return index === -1 ? undefined : args[index + 1];
}

async function validateFromFile(
  args: readonly string[],
  asJson: boolean,
): Promise<CliResult> {
  const path = inputPath(args);
  if (path === undefined) return invalidManifestResult(asJson);

  try {
    return validateManifest(JSON.parse(await readFile(path, "utf8")), asJson);
  } catch {
    return invalidManifestResult(asJson);
  }
}

export async function runCli(args: readonly string[]): Promise<CliResult> {
  const asJson = usesJson(args);
  const [first, second] = args;

  if (first === "providers" && second === "doctor")
    return doctorProviders(asJson);
  if (first === "validate") return validateFromFile(args, asJson);
  if (first === "prompts" && second === "check")
    return promptsUnavailable(asJson);
  if (first === "dev" && (second === "up" || second === "down")) {
    return runLocalComposition(second, asJson);
  }
  if (first === "workflow" && second === "compile")
    return compileWorkflowFile(inputPath(args), asJson);
  if (first === "workflow" && second === "run")
    return runWorkflowFile(inputPath(args), asJson);

  return humanResult(
    [
      "Usage: forge <command> [--json]",
      "",
      "  dev up | dev down            manage the declared local stack",
      "  providers doctor             report provider availability",
      "  validate --input <file>      validate a company manifest",
      "  prompts check                verify prompt asset pins",
      "  workflow compile --input <f> compile a workflow to a sealed artifact",
      "  workflow run --input <f>     compile and execute until done or gated",
    ].join("\n"),
    CLI_EXIT_CODE.USAGE,
  );
}

import { readFile } from "node:fs/promises";
