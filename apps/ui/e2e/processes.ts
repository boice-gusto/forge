import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A real control plane and a real UI server, as subprocesses.
 *
 * The browser suite drives a *running* Forge over HTTP, exactly as an operator
 * would: the API is started from `apps/api/src/server.ts`, the UI from the Vite
 * dev server that proxies `/v1` to it. Nothing is mocked, so a decision made in
 * the browser reaches the same runtime, the same policy pack and the same
 * effect ledger a deployment has. This follows the shape of
 * `forge.gusto/acceptance/api-process.ts`, which had already paid for the
 * lessons below.
 *
 * **Ports are always ephemeral.** Never 3100 or 3101: a suite that assumes a
 * port will happily adopt whatever is already listening there, which once cost
 * a company acceptance run twenty assertions against another process's
 * half-built server.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** `apps/ui/e2e` → the workspace root. */
const ROOT = resolve(HERE, "..", "..", "..");

const READY_TIMEOUT_MS = 90_000;

/**
 * The company package this deployment serves, and the ceiling it serves it
 * under. Acme's pack requires a human for `slack.post`, which is the gate the
 * whole suite exists to decide.
 */
const COMPANY = resolve(ROOT, "examples/acme");
const HOST_CAPABILITIES = "repo.read,docs.write,slack.write";

/** The role Acme's policy pack names as the approver of `slack.post`. */
export const OPERATOR_ROLE = "marketing-lead";
export const OPERATOR_SUBJECT = "lead@e2e.test";

export interface RunningProcess {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

export interface RunningApi extends RunningProcess {
  /** Never a literal: a committed token is a committed credential. */
  readonly credential: string;
}

/** An ephemeral port the OS has just confirmed is free. */
async function freePort(): Promise<number> {
  return new Promise((settle, fail) => {
    const probe = createServer();
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => fail(new Error("No ephemeral port was assigned.")));
        return;
      }
      const { port } = address;
      probe.close(() => settle(port));
    });
  });
}

const localUrl = (port: number): string => `http://127.0.0.1:${port}`;

const sleep = (ms: number): Promise<void> =>
  new Promise((settle) => setTimeout(settle, ms));

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

/**
 * Terminate the whole process group. `pnpm --filter … exec tsx …` is three
 * processes deep, so killing the pid we were handed leaves the listener holding
 * the port and the next run fails on something unrelated.
 */
async function stopGroup(child: ChildProcess): Promise<void> {
  const { pid } = child;
  if (pid === undefined || child.exitCode !== null) return;

  const exited = new Promise<void>((settle) =>
    child.once("exit", () => settle()),
  );
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }

  const forced = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 5_000);
  await exited;
  clearTimeout(forced);
}

interface SpawnOptions {
  readonly what: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly readyUrl: string;
  readonly baseUrl: string;
}

/** Spawn, wait for it to answer, or fail with everything it said. */
async function start(options: SpawnOptions): Promise<RunningProcess> {
  const child = spawn("pnpm", [...options.args], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...options.env },
  });

  let output = "";
  const collect = (chunk: Buffer): void => {
    output += chunk.toString();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `The ${options.what} exited before it was ready:\n${output}`,
      );
    }
    if (await answers(options.readyUrl)) {
      return { baseUrl: options.baseUrl, stop: () => stopGroup(child) };
    }
    await sleep(150);
  }

  await stopGroup(child);
  throw new Error(
    `The ${options.what} did not become ready within ${READY_TIMEOUT_MS}ms:\n${output}`,
  );
}

/**
 * The control plane. One operator, holding the one role Acme's pack names, so
 * the inbox this suite reads is a real role-scoped inbox rather than a caller
 * who happens to hold everything.
 */
export async function startApi(): Promise<RunningApi> {
  const credential = randomBytes(24).toString("hex");
  const port = await freePort();

  const running = await start({
    what: "Forge API",
    args: ["--filter", "@forge/api", "exec", "tsx", "src/server.ts"],
    env: {
      PORT: String(port),
      FORGE_OPERATORS: `${OPERATOR_SUBJECT}:${credential}:${OPERATOR_ROLE}`,
      FORGE_COMPANY: COMPANY,
      FORGE_HOST_CAPABILITIES: HOST_CAPABILITIES,
    },
    readyUrl: `${localUrl(port)}/health/live`,
    baseUrl: localUrl(port),
  });

  return { ...running, credential };
}

/**
 * The UI, served the way it is developed and deployed: same origin as the API.
 *
 * `vite.config.ts` proxies `/v1` to `FORGE_API_URL`, which is what lets the
 * session cookie be `HttpOnly; SameSite=Strict` — the browser sends it without
 * any cross-origin credential sharing. Serving the built bundle from somewhere
 * else would test a deployment shape Forge does not have.
 */
export async function startUi(apiUrl: string): Promise<RunningProcess> {
  const port = await freePort();
  return start({
    what: "Forge UI dev server",
    args: [
      "--filter",
      "@forge/ui",
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    env: { FORGE_API_URL: apiUrl },
    readyUrl: localUrl(port),
    baseUrl: localUrl(port),
  });
}
