import type { SandboxPort } from "@forge/ports";
import {
  assertNotCancelled,
  raceCancellation,
  unsupportedProfile,
} from "@forge/sandbox";

import {
  createEngineClient,
  type EngineClient,
  resolveSocketPath,
} from "./engine.js";

export interface DockerSandboxProfile {
  /**
   * The image a Forge profile alias resolves to. Configuration, supplied at the
   * composition root — an author names `forge.node-ts`, never an image.
   */
  readonly image: string;
  readonly memoryMb: number;
  /** A wedged command fails the step instead of holding the run open. */
  readonly execTimeoutMs?: number;
}

export interface DockerSandboxOptions {
  readonly profiles: Readonly<Record<string, DockerSandboxProfile>>;
  /** Defaults to `DOCKER_HOST`, then the conventional daemon socket. */
  readonly socketPath?: string;
}

const WORKSPACE_PATH = "/workspace";
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
/** Nobody. The container never runs as root (010 §6). */
const UNPRIVILEGED_USER = "65534:65534";
const MEGABYTE = 1024 * 1024;

/**
 * A path the adapter is willing to interpolate into a shell line. File
 * transfer runs through `sh -c`, so anything quoting-significant is refused
 * rather than escaped — a path is workflow-adjacent data, and an escape
 * function is a thing to get subtly wrong.
 */
const SHELL_SAFE_PATH = /^[A-Za-z0-9_@%+=:,./-]+$/;

function shellSafe(path: string): string {
  if (!SHELL_SAFE_PATH.test(path)) {
    throw new Error(
      `Refusing a sandbox path containing characters a shell would interpret: ${path}`,
    );
  }
  return path;
}

/**
 * 010 §6, as container configuration rather than as a promise: no network at
 * all, every capability dropped, no new privileges, a read-only root with a
 * single writable tmpfs workspace, a memory ceiling, and no bind mount — so
 * there is no path by which the host filesystem is reachable from inside.
 */
function containerConfig(
  profile: DockerSandboxProfile,
  correlationId: string,
): unknown {
  return {
    Image: profile.image,
    // Something that stays up between execs and needs no privileges.
    Cmd: ["sleep", "2147483647"],
    User: UNPRIVILEGED_USER,
    WorkingDir: WORKSPACE_PATH,
    NetworkDisabled: true,
    Labels: {
      "com.forge.sandbox": "true",
      "com.forge.correlation-id": correlationId,
    },
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: profile.memoryMb * MEGABYTE,
      PidsLimit: 128,
      // Released explicitly, so "the container is gone" is something the
      // adapter did rather than something the daemon might get around to.
      AutoRemove: false,
      Tmpfs: {
        [WORKSPACE_PATH]: "rw,size=64m,mode=1777",
        "/tmp": "rw,size=16m,mode=1777",
      },
    },
  };
}

async function provision(
  client: EngineClient,
  profile: DockerSandboxProfile,
  correlationId: string,
): Promise<string> {
  await client.ensureImage(profile.image);
  const id = await client.createContainer(
    containerConfig(profile, correlationId),
  );
  try {
    await client.startContainer(id);
  } catch (error) {
    // A created-but-unstarted container is still a container.
    await client.remove(id);
    throw error;
  }
  return id;
}

/**
 * The Phase 1 MVP backend of ADR-003: a hardened Docker container per lease,
 * created for a declared profile and removed when the work ends however it
 * ends.
 */
export function createDockerSandbox(
  options: DockerSandboxOptions,
): SandboxPort {
  const socketPath =
    options.socketPath ?? resolveSocketPath(process.env.DOCKER_HOST);
  const client = createEngineClient(socketPath);
  const profiles = Object.keys(options.profiles);

  return {
    profiles,

    async health() {
      return { available: await client.ping() };
    },

    async withSandbox(request, work) {
      assertNotCancelled(request.signal);
      const profile = options.profiles[request.profile];
      if (profile === undefined) {
        throw unsupportedProfile(request.profile, profiles);
      }

      // Provisioning failure propagates. There is no host fallback: a step
      // that asked for isolation gets isolation or gets an error.
      const sandboxId = await provision(client, profile, request.correlationId);
      const timeoutMs = profile.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
      let open = true;

      function assertOpen(): void {
        if (!open) {
          throw new Error(
            `Sandbox ${sandboxId} has been released; its lease cannot be used again.`,
          );
        }
      }

      try {
        return await raceCancellation(
          work({
            sandboxId,
            profile: request.profile,
            workspacePath: WORKSPACE_PATH,

            async exec(command) {
              assertOpen();
              return client.exec(sandboxId, command, timeoutMs);
            },

            async readFile(path) {
              assertOpen();
              // base64 rather than the archive endpoint: one mechanism for
              // getting bytes in and out, and it is the same `exec` the
              // contract already has to be honest about.
              const result = await client.exec(
                sandboxId,
                ["sh", "-c", `base64 < ${shellSafe(path)}`],
                timeoutMs,
              );
              if (result.exitCode !== 0) {
                throw new Error(
                  `Sandbox ${sandboxId} cannot read '${path}': ${result.stderr.trim()}`,
                );
              }
              return new Uint8Array(
                Buffer.from(result.stdout.replace(/\s+/gu, ""), "base64"),
              );
            },

            async writeFile(path, data) {
              assertOpen();
              const encoded = Buffer.from(data).toString("base64");
              const result = await client.exec(
                sandboxId,
                [
                  "sh",
                  "-c",
                  `printf %s '${encoded}' | base64 -d > ${shellSafe(path)}`,
                ],
                timeoutMs,
              );
              if (result.exitCode !== 0) {
                throw new Error(
                  `Sandbox ${sandboxId} cannot write '${path}': ${result.stderr.trim()}`,
                );
              }
            },
          }),
          request.signal,
        );
      } finally {
        open = false;
        await client.remove(sandboxId);
      }
    },
  };
}
