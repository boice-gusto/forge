import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * What this control plane refuses to be.
 *
 * `server.ts` is a process entry point — excluded from the coverage floors and
 * unimportable, since it binds a stack and then listens — so the only honest
 * test of a boot refusal is to boot it and watch it refuse.
 */

const SERVER = fileURLToPath(new URL("../src/server.ts", import.meta.url));

async function boot(
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", SERVER], {
    env: { ...process.env, PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  return new Promise((settle) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ code: null, output: `${output}\n[did not exit]` });
    }, 30_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      settle({ code, output });
    });
  });
}

describe("a development control plane refuses to be mistaken for one", () => {
  test("an unset NODE_ENV is a refusal, not a default", async () => {
    /**
     * The guard was `NODE_ENV === "production"` — the wrong way round. It
     * fired only when somebody remembered to say the dangerous thing, so a
     * container that nobody configured started a control plane whose
     * authentication is a list of preshared strings in an environment
     * variable, whose sandbox simulates, and whose model is a stand-in. A
     * guard that depends on being told it is needed is absent exactly when it
     * matters.
     */
    const { code, output } = await boot({ NODE_ENV: undefined });

    expect(code).not.toBe(0);
    expect(output).toContain("development or test");
    expect(output).toContain("unset");
  }, 40_000);

  test("NODE_ENV=production is still a refusal, and says what it is currently", async () => {
    const { code, output } = await boot({ NODE_ENV: "production" });

    expect(code).not.toBe(0);
    expect(output).toContain('"production"');
  }, 40_000);

  test("a development boot says what is simulated rather than leaving it to be found", async () => {
    // Guards the two above: a binary that refused everything would pass them
    // and never start. This one starts, and announces what it is.
    const { output } = await boot({ NODE_ENV: "development" });

    expect(output).toContain("simulated sandbox");
    expect(output).toContain("stand-in model");
  }, 40_000);
});
