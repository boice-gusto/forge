import { describe, expect, test } from "vitest";

import { createMemorySandbox } from "./memory.js";

const encoder = new TextEncoder();

describe("the mock refuses work it did not do", () => {
  test("a command it cannot run reports not found rather than success", async () => {
    // A mock that returned exit 0 for everything would let a step that never
    // ran read as a step that passed.
    const port = createMemorySandbox();

    const result = await port.withSandbox(
      { profile: "forge.mock", correlationId: "unit" },
      async (sandbox) => sandbox.exec(["pnpm", "install"]),
    );

    expect(result).toEqual({
      exitCode: 127,
      stdout: "",
      stderr: "pnpm: not found",
    });
  });

  test("cat reads every path it was given, in order", async () => {
    const port = createMemorySandbox();

    const result = await port.withSandbox(
      { profile: "forge.mock", correlationId: "unit" },
      async (sandbox) => {
        await sandbox.writeFile("/workspace/a", encoder.encode("first "));
        await sandbox.writeFile("/workspace/b", encoder.encode("second"));
        return sandbox.exec(["cat", "/workspace/a", "/workspace/b"]);
      },
    );

    expect(result.stdout).toBe("first second");
    expect(result.exitCode).toBe(0);
  });
});
