import { describe, expect, test } from "vitest";

import { runCli } from "../program.js";

describe("forge prompts", () => {
  test("reports unavailable rather than pretending to check", async () => {
    const result = await runCli(["prompts", "check", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).status).toBe("unavailable");
  });

  test("human form carries the same message on stderr", async () => {
    const result = await runCli(["prompts", "check"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
