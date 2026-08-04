#!/usr/bin/env node
import { Command } from "commander";

import { runCli } from "./program.js";

const program = new Command()
  .name("forge")
  .description("Forge workflow platform CLI")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .argument("[command...]", "Forge command")
  .action(async () => {
    const result = await runCli(process.argv.slice(2));
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  });

await program.parseAsync();
