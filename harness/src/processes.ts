import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { freePort, sleep, waitFor } from "./docker.js";

/**
 * Real processes, started the way a deployment starts them.
 *
 * Every scenario here drives `apps/api/src/server.ts` and
 * `apps/worker/src/server.ts` as child processes rather than constructing a
 * stack in this one. The point is not fidelity for its own sake: a chaos test
 * that kills an in-process object proves nothing about a run whose *process*
 * went away, and the ledgers this harness is attacking only become interesting
 * once they are the only thing left.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "../..");
export const API_DIR = resolve(REPO, "apps/api");
export const WORKER_DIR = resolve(REPO, "apps/worker");
export const ACME = resolve(REPO, "examples/acme");
export const HOST_CAPABILITIES = "repo.read,docs.write,slack.write";

const READY_TIMEOUT_MS = 90_000;

/** One operator per role, so "who may decide this" is a real question. */
export const OPERATORS = {
  "marketing-lead": randomBytes(16).toString("hex"),
  "finance-lead": randomBytes(16).toString("hex"),
} as const;

export type Role = keyof typeof OPERATORS;

export const operatorDirectory = (): string =>
  Object.entries(OPERATORS)
    .map(([role, secret]) => `${role}@harness.test:${secret}:${role}`)
    .join(";");

export interface Backing {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly queueName: string;
}

export interface Process {
  readonly output: () => string;
  readonly exited: () => boolean;
  /** SIGKILL. Nothing is flushed; what survives is what is already durable. */
  kill(): Promise<void>;
  /** SIGTERM, so a drain that exists is given the chance to run. */
  drain(): Promise<void>;
}

interface Spawned extends Process {
  readonly child: ChildProcess;
}

function track(child: ChildProcess): Spawned {
  let output = "";
  let exited = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.once("exit", () => {
    exited = true;
  });

  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (child.exitCode !== null || exited) return;
    const gone = new Promise<void>((settle) =>
      child.once("exit", () => settle()),
    );
    child.kill(signal);
    await gone;
  };

  return {
    child,
    output: () => output,
    exited: () => exited,
    kill: () => stop("SIGKILL"),
    drain: () => stop("SIGTERM"),
  };
}

export interface Api extends Process {
  readonly baseUrl: string;
}

const running: ChildProcess[] = [];

/** Kills everything this module started. Call from `afterAll`. */
export function killAll(): void {
  for (const child of running.splice(0)) child.kill("SIGKILL");
}

export async function startApi(backing: Backing): Promise<Api> {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve(API_DIR, "src/server.ts")],
    {
      cwd: API_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: String(port),
        FORGE_PERSISTENCE: "postgres",
        FORGE_DATABASE_URL: backing.databaseUrl,
        FORGE_REDIS_URL: backing.redisUrl,
        FORGE_QUEUE_NAME: backing.queueName,
        FORGE_COMPANY: ACME,
        FORGE_HOST_CAPABILITIES: HOST_CAPABILITIES,
        FORGE_OPERATORS: operatorDirectory(),
      },
    },
  );
  running.push(child);
  const tracked = track(child);
  const baseUrl = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (tracked.exited()) {
      throw new Error(
        `The API exited before it was ready:\n${tracked.output()}`,
      );
    }
    try {
      if ((await fetch(`${baseUrl}/health/live`)).ok) {
        return { ...tracked, baseUrl };
      }
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }
  throw new Error(`The API never became ready:\n${tracked.output()}`);
}

/** The shipped worker binary, whose effect sink performs nothing. */
export async function startWorker(backing: Backing): Promise<Process> {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve(WORKER_DIR, "src/server.ts")],
    {
      cwd: WORKER_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: String(port),
        FORGE_DATABASE_URL: backing.databaseUrl,
        FORGE_REDIS_URL: backing.redisUrl,
        FORGE_QUEUE_NAME: backing.queueName,
        FORGE_COMPANY: ACME,
        FORGE_HOST_CAPABILITIES: HOST_CAPABILITIES,
        /**
         * Said out loud, because the worker now refuses to start otherwise.
         *
         * These scenarios kill Postgres and Redis to see what a run survives;
         * what a model would have answered is not the subject and a real one
         * would make the outcomes non-deterministic. The refusal exists so
         * that a *deployment* cannot use a stand-in without meaning to — and
         * it caught this harness doing exactly that, silently, which is the
         * point of it. Meaning it and saying so is the difference.
         */
        FORGE_WORKER_MOCK_PROVIDER: "1",
      },
    },
  );
  running.push(child);
  const tracked = track(child);
  await waitFor(
    "the worker to serve /health/ready",
    async () => {
      if (tracked.exited()) {
        throw new Error(
          `The worker exited before it was ready:\n${tracked.output()}`,
        );
      }
      try {
        return (await fetch(`http://127.0.0.1:${port}/health/ready`)).ok;
      } catch {
        return false;
      }
    },
    READY_TIMEOUT_MS,
    100,
  );
  return tracked;
}

/**
 * A worker the harness composes itself.
 *
 * `apps/worker/src/server.ts` builds a durable stack with the default effect
 * sink, which performs nothing and returns nothing instantly. That is correct
 * for the binary and useless for chaos: there is no window between claiming a
 * dispatch and performing it to kill a process inside, and no way to tell how
 * many times an action was really carried out.
 *
 * So this entry point binds the same composition root — `createDurableStack`,
 * `createRunConsumer`, `runtimeHost` — and differs only in the sink and the
 * transform table. Everything the invariants live in is unchanged. See
 * `worker-entry.ts`, and the report's list of product changes that would make
 * this unnecessary.
 */
export interface HarnessWorkerOptions extends Backing {
  /** Milliseconds the effect sink blocks before returning. */
  readonly dispatchDelayMs?: number;
  /** Milliseconds the `harness.slow` transform blocks for. */
  readonly transformDelayMs?: number;
  /** Never return from the sink; the process must be killed to stop it. */
  readonly hangOnDispatch?: boolean;
  readonly label?: string;
}

export interface HarnessWorker extends Process {
  /** Resolves when the sink has announced it is about to perform an action. */
  dispatching(): Promise<{ runId: string; nodeId: string }>;
  /** Every action this process actually performed. */
  readonly performed: readonly { runId: string; nodeId: string }[];
}

export function startHarnessWorker(
  options: HarnessWorkerOptions,
): Promise<HarnessWorker> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve(HERE, "worker-entry.ts")],
    {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FORGE_DATABASE_URL: options.databaseUrl,
        FORGE_REDIS_URL: options.redisUrl,
        FORGE_QUEUE_NAME: options.queueName,
        FORGE_COMPANY: ACME,
        FORGE_HOST_CAPABILITIES: HOST_CAPABILITIES,
        HARNESS_LABEL: options.label ?? "worker",
        ...(options.dispatchDelayMs === undefined
          ? {}
          : { HARNESS_DISPATCH_DELAY_MS: String(options.dispatchDelayMs) }),
        ...(options.transformDelayMs === undefined
          ? {}
          : { HARNESS_TRANSFORM_DELAY_MS: String(options.transformDelayMs) }),
        ...(options.hangOnDispatch === true ? { HARNESS_HANG: "1" } : {}),
      },
    },
  );
  running.push(child);
  const tracked = track(child);

  const performed: { runId: string; nodeId: string }[] = [];
  const claiming: { runId: string; nodeId: string }[] = [];
  let buffered = "";
  const consume = (chunk: Buffer): void => {
    buffered += chunk.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("HARNESS ")) {
        const event = JSON.parse(line.slice("HARNESS ".length)) as {
          readonly kind: string;
          readonly runId: string;
          readonly nodeId: string;
        };
        if (event.kind === "dispatching")
          claiming.push({ runId: event.runId, nodeId: event.nodeId });
        if (event.kind === "performed")
          performed.push({ runId: event.runId, nodeId: event.nodeId });
      }
    }
  };
  child.stdout?.on("data", consume);

  const worker: HarnessWorker = {
    ...tracked,
    performed,
    async dispatching() {
      await waitFor(
        "the sink to announce a dispatch",
        () => claiming.length > 0,
        60_000,
        5,
      );
      return claiming[0] as { runId: string; nodeId: string };
    },
  };

  return waitFor(
    "the harness worker to subscribe",
    () => {
      if (tracked.exited()) {
        throw new Error(
          `The harness worker exited early:\n${tracked.output()}`,
        );
      }
      return tracked.output().includes("HARNESS-READY");
    },
    READY_TIMEOUT_MS,
    50,
  ).then(() => worker);
}

export interface ParkReport {
  readonly runId: string;
  readonly fingerprint: string;
  readonly status: string;
  readonly error?: string;
  readonly pendingApprovalId?: string;
}

/** Creates a run and walks it to its gate in a process that then exits. */
export async function parkInAnotherProcess(
  backing: Backing,
  options: {
    readonly workflow?: "gated" | "chained" | "slow";
    readonly transformDelayMs?: number;
    readonly stopAtPending?: boolean;
  } = {},
): Promise<ParkReport> {
  const report = await oneShot(resolve(HERE, "park-entry.ts"), backing, {
    ...(options.workflow === undefined
      ? {}
      : { HARNESS_WORKFLOW: options.workflow }),
    ...(options.transformDelayMs === undefined
      ? {}
      : { HARNESS_TRANSFORM_DELAY_MS: String(options.transformDelayMs) }),
    ...(options.stopAtPending === true ? { HARNESS_STOP_AT_PENDING: "1" } : {}),
  });
  return JSON.parse(report("HARNESS-PARKED")) as ParkReport;
}

/**
 * Runs one of the harness entry points to completion and hands back a reader
 * for the single line it printed. Anything else on stdout or stderr comes back
 * in the failure, because a child that died has already said why.
 */
async function oneShot(
  script: string,
  backing: Backing,
  env: Readonly<Record<string, string>>,
): Promise<(prefix: string) => string> {
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FORGE_DATABASE_URL: backing.databaseUrl,
      FORGE_REDIS_URL: backing.redisUrl,
      FORGE_QUEUE_NAME: backing.queueName,
      FORGE_COMPANY: ACME,
      FORGE_HOST_CAPABILITIES: HOST_CAPABILITIES,
      ...env,
    },
  });
  running.push(child);
  const tracked = track(child);
  await new Promise<void>((settle) => child.once("exit", () => settle()));
  return (prefix: string) => {
    const line = tracked
      .output()
      .split("\n")
      .find((entry) => entry.startsWith(`${prefix} `));
    if (line === undefined) {
      throw new Error(
        `No "${prefix}" line from ${script}:\n${tracked.output()}`,
      );
    }
    return line.slice(prefix.length + 1);
  };
}

export interface ResumeReport {
  readonly label: string;
  readonly status: string;
  readonly error?: string;
  /** What this process's sink was actually asked to act on, in order. */
  readonly performed: readonly unknown[];
  readonly startedAt: number;
  readonly finishedAt: number;
}

/**
 * One `runtime.resume(runId)` in a process of its own, then exit.
 *
 * This is the operator redrive that the product does not yet expose as a route,
 * and it is also how two workers are made to race: several of these, released
 * together by a wall-clock barrier they all wait on.
 */
export async function resumeInProcess(
  backing: Backing,
  options: {
    readonly runId: string;
    readonly label?: string;
    readonly startAtEpochMs?: number;
    readonly dispatchDelayMs?: number;
    readonly transformDelayMs?: number;
  },
): Promise<ResumeReport> {
  const report = await oneShot(resolve(HERE, "resume-entry.ts"), backing, {
    HARNESS_RUN_ID: options.runId,
    HARNESS_LABEL: options.label ?? "resume",
    ...(options.startAtEpochMs === undefined
      ? {}
      : { HARNESS_START_AT: String(options.startAtEpochMs) }),
    ...(options.dispatchDelayMs === undefined
      ? {}
      : { HARNESS_DISPATCH_DELAY_MS: String(options.dispatchDelayMs) }),
    ...(options.transformDelayMs === undefined
      ? {}
      : { HARNESS_TRANSFORM_DELAY_MS: String(options.transformDelayMs) }),
  });
  return JSON.parse(report("HARNESS-REPORT")) as ResumeReport;
}
