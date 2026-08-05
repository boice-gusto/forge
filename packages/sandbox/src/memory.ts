import type { SandboxPort } from "@forge/ports";

import {
  assertNotCancelled,
  raceCancellation,
  unsupportedProfile,
} from "./lease.js";

export interface MemorySandboxOptions {
  /** The profile aliases this adapter answers to. */
  readonly profiles?: readonly string[];
  /** Set false to prove a required sandbox failing closed. */
  readonly available?: boolean;
}

export interface MemorySandbox extends SandboxPort {
  /**
   * Whether the environment behind `sandboxId` is gone. For an in-memory
   * adapter the bookkeeping *is* the backend, so this is the honest answer
   * rather than a convenience for the conformance suite.
   */
  isReleased(sandboxId: string): boolean;
}

const DEFAULT_PROFILES = ["forge.mock"] as const;
/**
 * Process-wide, so a sandbox id names one lease and not one lease per adapter
 * instance. Two adapters handing out `sandbox_1` would make "is this released?"
 * an ambiguous question.
 */
let leases = 0;
const WORKSPACE_PATH = "/workspace";
const COMMAND_NOT_FOUND = 127;

/**
 * The `sandbox-mock` adapter of 010 §5: an in-memory filesystem and an exec
 * that runs nothing.
 *
 * It is not an isolation mechanism and does not pretend to be one — it exists
 * so that a workflow declaring a sandbox can be exercised without a container
 * runtime. What keeps it honest is that it answers the same conformance suite
 * as the Docker adapter: it cannot see the host filesystem, it releases every
 * lease, and it refuses a profile it was not configured for.
 */
export function createMemorySandbox(
  options: MemorySandboxOptions = {},
): MemorySandbox {
  const profiles = options.profiles ?? DEFAULT_PROFILES;
  const available = options.available ?? true;
  const live = new Set<string>();
  const decoder = new TextDecoder();

  return {
    profiles,

    isReleased(sandboxId) {
      return !live.has(sandboxId);
    },

    async health() {
      return { available };
    },

    async withSandbox(request, work) {
      assertNotCancelled(request.signal);
      if (!profiles.includes(request.profile)) {
        throw unsupportedProfile(request.profile, profiles);
      }
      if (!available) {
        throw new Error(
          `Sandbox profile '${request.profile}' could not be provisioned; host execution is not permitted.`,
        );
      }

      leases += 1;
      const sandboxId = `sandbox_${leases}`;
      const files = new Map<string, Uint8Array>();
      let open = true;
      live.add(sandboxId);

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
              const [program, ...paths] = command;
              // The mock runs nothing. It answers `cat` out of its own
              // filesystem, because that is what the isolation contract is
              // written in, and refuses everything else rather than reporting
              // success for work it did not do.
              if (program !== "cat") {
                return {
                  exitCode: COMMAND_NOT_FOUND,
                  stdout: "",
                  stderr: `${program ?? ""}: not found`,
                };
              }
              let stdout = "";
              for (const path of paths) {
                const data = files.get(path);
                if (data === undefined) {
                  return {
                    exitCode: 1,
                    stdout,
                    stderr: `cat: can't open '${path}': No such file or directory`,
                  };
                }
                stdout += decoder.decode(data);
              }
              return { exitCode: 0, stdout, stderr: "" };
            },

            async readFile(path) {
              assertOpen();
              const data = files.get(path);
              if (data === undefined) {
                throw new Error(
                  `No such file in sandbox ${sandboxId}: ${path}. A sandbox cannot read the host.`,
                );
              }
              return data;
            },

            async writeFile(path, data) {
              assertOpen();
              files.set(path, Uint8Array.from(data));
            },
          }),
          request.signal,
        );
      } finally {
        open = false;
        files.clear();
        live.delete(sandboxId);
      }
    },
  };
}
