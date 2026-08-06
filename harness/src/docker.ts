import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import type { StartedTestContainer } from "testcontainers";

/**
 * Containers a scenario can take away and give back.
 *
 * Testcontainers publishes on a host port Docker picks, and Docker picks a
 * different one every time a container starts. That is invisible until a
 * scenario stops the database mid-run and brings it back: the connection URL
 * every already-running process is holding would point at nothing, and the
 * scenario would be measuring a stale port rather than an outage. So the host
 * port is chosen here, by the harness, and bound explicitly — a stopped and
 * restarted container comes back on the address its clients are still using.
 */

const run = promisify(execFile);

export const POSTGRES_IMAGE = "postgres:16-alpine";
export const REDIS_IMAGE = "redis:7-alpine";
export const CONTAINER_START_TIMEOUT_MS = 240_000;

/**
 * The credentials the harness gives its own throwaway database.
 *
 * Minted per process rather than written down. A constant here would be a
 * string in the repository that looks exactly like a credential to anyone
 * reading it and to `pnpm security:secrets`, and the fact that it protects a
 * container which is destroyed minutes later is not something a scanner — or a
 * reviewer skimming a diff — should have to take on trust.
 */
export const PG = {
  user: "forge",
  password: randomBytes(18).toString("hex"),
  database: "forge",
} as const;

/**
 * An ephemeral port, released before it is handed out.
 *
 * There is a race here that cannot be closed: something else may take the port
 * between the probe closing and the container binding it. Docker fails loudly
 * when that happens, which is the right failure — a silent adoption of whatever
 * is already listening is the one this avoids.
 */
export function freePort(): Promise<number> {
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

export interface PinnedContainer {
  readonly container: StartedTestContainer;
  readonly hostPort: number;
  readonly url: string;
}

/** `docker`, with whatever socket the environment points at. */
export async function docker(...args: readonly string[]): Promise<string> {
  const { stdout } = await run("docker", [...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export async function startPostgres(
  hostPort: number,
): Promise<PinnedContainer> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withUsername(PG.user)
    .withPassword(PG.password)
    .withDatabase(PG.database)
    .withExposedPorts({ container: 5432, host: hostPort })
    .start();
  return { container, hostPort, url: postgresUrl(hostPort) };
}

export const postgresUrl = (hostPort: number): string =>
  `postgresql://${PG.user}:${PG.password}@127.0.0.1:${hostPort}/${PG.database}`;

export async function startRedis(hostPort: number): Promise<PinnedContainer> {
  const container = await new RedisContainer(REDIS_IMAGE)
    .withExposedPorts({ container: 6379, host: hostPort })
    .start();
  return {
    container,
    hostPort,
    url: `redis://127.0.0.1:${hostPort}`,
  };
}

/**
 * Takes a dependency away and gives it back on the same address.
 *
 * `docker stop` rather than a pause: a paused server accepts the connection and
 * never answers, so a client with no timeout hangs for the length of the
 * outage and the scenario measures its own patience. A stopped one refuses,
 * which is what a process losing its database actually sees.
 */
export async function drop(pinned: PinnedContainer): Promise<void> {
  await docker("stop", "-t", "0", pinned.container.getId());
}

export async function restore(pinned: PinnedContainer): Promise<void> {
  await docker("start", pinned.container.getId());
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((settle) => setTimeout(settle, ms));

/** Blocks until `holds()` is true, or gives up with a named failure. */
export async function waitFor(
  what: string,
  holds: () => Promise<boolean> | boolean,
  timeoutMs = 30_000,
  everyMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await holds()) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}.`);
    }
    await sleep(everyMs);
  }
}
