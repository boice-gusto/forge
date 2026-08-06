import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * What a worker refuses to start without.
 *
 * `server.ts` is a process entry point, so it is excluded from the coverage
 * floors and cannot be imported: it connects to Postgres and Redis and then
 * blocks. The only honest test of a boot refusal is to boot it and watch it
 * refuse, which is what this does — and which is also the reason these checks
 * are worth having as *refusals* rather than warnings. A warning in a
 * container's logs is a warning nobody reads.
 */

const SERVER = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const NO_EFFECTS = fileURLToPath(
  new URL("./fixtures/no-effects", import.meta.url),
);

/** Present and unreachable. The refusals under test all precede any connect. */
const UNREACHABLE = {
  FORGE_DATABASE_URL: "postgres://127.0.0.1:1/forge",
  FORGE_REDIS_URL: "redis://127.0.0.1:1",
};

async function boot(
  env: Readonly<Record<string, string>>,
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
    // A worker that gets past every refusal starts listening and never exits,
    // which is a failure of this test rather than a hang of the suite.
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

describe("a worker refuses to start rather than run without something", () => {
  test("no queue and no database is a refusal, not a health endpoint", async () => {
    const { code, output } = await boot({ FORGE_COMPANY: NO_EFFECTS });

    expect(code).toBe(1);
    expect(output).toContain("FORGE_DATABASE_URL and FORGE_REDIS_URL");
  }, 40_000);

  test("no company is a refusal, because policy must not depend on the process", async () => {
    const { code, output } = await boot(UNREACHABLE);

    expect(code).toBe(1);
    expect(output).toContain("FORGE_COMPANY is required");
  }, 40_000);

  test("no effects adapter is a refusal, because dispatching nowhere is silent", async () => {
    /**
     * The one that matters most, and the one that was missing.
     *
     * The default sink returns `undefined` and does nothing. In a control
     * plane that is reasonable — it is not the thing that acts. In a worker it
     * is the entire job missing: every run walked, every gate passed, every
     * effect recorded as dispatched, and nothing performed anywhere. A human
     * approves, the audit says the action went out, and it did not.
     *
     * Silent is the problem. A worker that cannot act should say so at boot,
     * where somebody is looking, not at the first approved action.
     */
    const { code, output } = await boot({
      ...UNREACHABLE,
      FORGE_COMPANY: NO_EFFECTS,
    });

    expect(code).toBe(1);
    expect(output).toContain('binds no "effects" adapter');
  }, 40_000);

  test("declaring sandbox profiles with nothing to provision them is a refusal", async () => {
    /**
     * The isolation half, and the same failure wearing different clothes.
     *
     * `createDurableStack` defaults to the in-memory sandbox, which simulates
     * a filesystem and an exec. A step that declared `forge.node-ts` declared,
     * in the compiled artifact, that it runs somewhere it cannot reach the
     * host — and it was running against a Map, in the worker's own process,
     * with the worker's filesystem and the worker's network. That declaration
     * is the entire basis on which a workflow may handle untrusted content,
     * and nothing said it was not being honoured.
     */
    const { code, output } = await boot({
      ...UNREACHABLE,
      FORGE_COMPANY: NO_EFFECTS,
      FORGE_WORKER_NO_EFFECTS: "1",
      FORGE_SANDBOX_PROFILES: "forge.node-ts",
    });

    expect(code).toBe(1);
    expect(output).toContain("FORGE_SANDBOX_IMAGE");
  }, 40_000);

  test("a nonsense memory ceiling is a refusal rather than a NaN", async () => {
    // It reaches Docker as a byte count. `Number.parseInt("plenty")` is NaN,
    // and a NaN memory limit is a container the daemon rejects at the first
    // sandboxed step rather than a worker that refuses at boot.
    const { code, output } = await boot({
      ...UNREACHABLE,
      FORGE_COMPANY: NO_EFFECTS,
      FORGE_WORKER_NO_EFFECTS: "1",
      FORGE_SANDBOX_PROFILES: "forge.node-ts",
      FORGE_SANDBOX_IMAGE: "alpine:3",
      FORGE_SANDBOX_MEMORY_MB: "plenty",
    });

    expect(code).toBe(1);
    expect(output).toContain("FORGE_SANDBOX_MEMORY_MB");
  }, 40_000);

  test("simulated isolation is available to a deployment that asks for it by name", async () => {
    // Guards the two above. A refusal with no way past it makes every harness
    // unstartable, and the pressure then goes on deleting the check.
    const { code, output } = await boot({
      ...UNREACHABLE,
      FORGE_COMPANY: NO_EFFECTS,
      FORGE_WORKER_NO_EFFECTS: "1",
      FORGE_SANDBOX_PROFILES: "forge.node-ts",
      FORGE_WORKER_MOCK_SANDBOX: "1",
    });

    expect(output).not.toContain("FORGE_SANDBOX_IMAGE");
    expect(code).not.toBe(0);
  }, 40_000);

  test("a deployment that really is not meant to act can say so", async () => {
    // Guards the test above: a refusal with no way past it would make every
    // worker in every test harness unstartable, and the pressure would be to
    // delete the check rather than to bind a sink.
    const { code, output } = await boot({
      ...UNREACHABLE,
      FORGE_COMPANY: NO_EFFECTS,
      FORGE_WORKER_NO_EFFECTS: "1",
    });

    // It gets past the refusal and dies on the unreachable database instead,
    // which is the next thing it would legitimately complain about.
    expect(output).not.toContain('binds no "effects" adapter');
    expect(code).not.toBe(0);
  }, 40_000);
});
