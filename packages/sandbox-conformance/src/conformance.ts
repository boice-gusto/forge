import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  decode,
  encode,
  never,
  type SandboxConformanceHarness,
  UNSUPPORTED_PROFILE,
} from "./harness.js";

/** Provisioning a container is not instant; a hung one must still fail. */
const LEASE_TIMEOUT_MS = 120_000;

/**
 * A cancellation that reads as an ordinary failure is one an operator cannot
 * tell from a crash, so the adapter has to say which it was.
 */
const CANCELLED = /cancel|abort/i;

function first(profiles: readonly string[]): string {
  const profile = profiles[0];
  if (profile === undefined) {
    throw new Error("A harness must claim at least one profile.");
  }
  return profile;
}

/**
 * A real file, at a real path, holding content nothing else in the process
 * knows. An adapter that quietly ran the work on the host — or bind-mounted the
 * host filesystem in — hands this content back; nothing else can.
 */
async function hostSecret(): Promise<{
  readonly path: string;
  readonly content: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "forge-sandbox-host-"));
  const path = join(directory, "host-secret.txt");
  const content = `forge-host-secret-${randomUUID()}`;
  await writeFile(path, content, "utf8");
  return {
    path,
    content,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function describeProfileHonesty(harness: SandboxConformanceHarness): void {
  describe("a profile is provisioned or refused, never substituted", () => {
    test("the adapter declares the profiles the harness claims for it", async () => {
      const port = await harness.create();

      expect([...port.profiles].sort()).toEqual([...harness.profiles].sort());
      expect(port.profiles.length).toBeGreaterThan(0);
    });

    test(
      "every declared profile provisions, and the lease reports the profile asked for",
      async () => {
        const port = await harness.create();

        for (const profile of port.profiles) {
          const lease = await port.withSandbox(
            { profile, correlationId: "conformance" },
            async (sandbox) => ({
              profile: sandbox.profile,
              sandboxId: sandbox.sandboxId,
              workspacePath: sandbox.workspacePath,
            }),
          );

          expect(lease.profile).toBe(profile);
          expect(lease.sandboxId).not.toBe("");
          expect(lease.workspacePath).not.toBe("");
        }
      },
      LEASE_TIMEOUT_MS,
    );

    test("an undeclared profile is refused, and the work never runs", async () => {
      const port = await harness.create();
      let ran = false;

      // Weaker isolation than was declared is the failure being prevented: a
      // step that asked for a microVM must not silently get a bare process.
      await expect(
        port.withSandbox(
          { profile: UNSUPPORTED_PROFILE, correlationId: "conformance" },
          async () => {
            ran = true;
          },
        ),
      ).rejects.toThrow(new RegExp(UNSUPPORTED_PROFILE));
      expect(ran).toBe(false);
    });
  });
}

function describeNoHostFallback(harness: SandboxConformanceHarness): void {
  describe("an unavailable sandbox stops the work; there is no host fallback", () => {
    test(
      "provisioning that fails refuses the work rather than running it un-isolated",
      async () => {
        const port = await harness.createUnavailable();
        let ran = false;

        await expect(
          port.withSandbox(
            {
              profile: first(harness.profiles),
              correlationId: "conformance",
            },
            async () => {
              ran = true;
            },
          ),
        ).rejects.toThrow();
        expect(ran).toBe(false);
      },
      LEASE_TIMEOUT_MS,
    );

    test("an adapter that cannot provision reports itself unhealthy rather than throwing", async () => {
      // A rejected health() reads as a broken adapter rather than a backend
      // that is merely down, and the two need different operator responses.
      const port = await harness.createUnavailable();

      expect(await port.health()).toEqual({ available: false });
    });

    test("a working adapter reports itself available", async () => {
      const port = await harness.create();

      expect(await port.health()).toEqual({ available: true });
    });
  });
}

function describeRelease(harness: SandboxConformanceHarness): void {
  describe("release is guaranteed, because the caller cannot be trusted to do it", () => {
    test(
      "the environment is gone once the work returns",
      async () => {
        const port = await harness.create();
        const sandboxId = await port.withSandbox(
          { profile: first(port.profiles), correlationId: "conformance" },
          async (sandbox) => sandbox.sandboxId,
        );

        expect(await harness.isReleased(sandboxId)).toBe(true);
      },
      LEASE_TIMEOUT_MS,
    );

    test(
      "the environment is gone when the work throws, and the caller still gets its error",
      async () => {
        const port = await harness.create();
        let sandboxId = "";

        await expect(
          port.withSandbox(
            { profile: first(port.profiles), correlationId: "conformance" },
            async (sandbox) => {
              sandboxId = sandbox.sandboxId;
              throw new Error("the work itself failed");
            },
          ),
        ).rejects.toThrow("the work itself failed");

        expect(sandboxId).not.toBe("");
        expect(await harness.isReleased(sandboxId)).toBe(true);
      },
      LEASE_TIMEOUT_MS,
    );

    test(
      "the environment is gone when the lease is cancelled, and the caller is told it was",
      async () => {
        const port = await harness.create();
        const controller = new AbortController();
        let sandboxId = "";

        const running = port.withSandbox(
          {
            profile: first(port.profiles),
            correlationId: "conformance",
            signal: controller.signal,
          },
          async (sandbox) => {
            sandboxId = sandbox.sandboxId;
            // An adapter that ignores the signal hangs here, which the test
            // timeout turns into a failure rather than a pass.
            return never();
          },
        );

        await vi.waitFor(() => expect(sandboxId).not.toBe(""), {
          timeout: LEASE_TIMEOUT_MS,
        });
        controller.abort();

        await expect(running).rejects.toThrow(CANCELLED);
        expect(await harness.isReleased(sandboxId)).toBe(true);
      },
      LEASE_TIMEOUT_MS,
    );

    test("a lease cancelled before it starts provisions nothing at all", async () => {
      // Otherwise a cancelled run still creates the container, and only a
      // sweeper — later, elsewhere — notices.
      const port = await harness.create();
      const controller = new AbortController();
      controller.abort();
      let ran = false;

      await expect(
        port.withSandbox(
          {
            profile: first(port.profiles),
            correlationId: "conformance",
            signal: controller.signal,
          },
          async () => {
            ran = true;
          },
        ),
      ).rejects.toThrow(CANCELLED);
      expect(ran).toBe(false);
    });

    test(
      "a lease is dead once its scope ends, so a handle cannot outlive the release",
      async () => {
        const port = await harness.create();
        const escaped = await port.withSandbox(
          { profile: first(port.profiles), correlationId: "conformance" },
          async (sandbox) => sandbox,
        );

        await expect(escaped.exec(["cat", "/etc/hostname"])).rejects.toThrow();
        await expect(escaped.readFile("/etc/hostname")).rejects.toThrow();
        await expect(
          escaped.writeFile(`${escaped.workspacePath}/late.txt`, encode("x")),
        ).rejects.toThrow();
      },
      LEASE_TIMEOUT_MS,
    );

    test(
      "overlapping leases are separate environments, and both are released",
      async () => {
        const port = await harness.create();
        const profile = first(port.profiles);
        const outer = await port.withSandbox(
          { profile, correlationId: "outer" },
          async (a) =>
            port.withSandbox({ profile, correlationId: "inner" }, async (b) => {
              expect(b.sandboxId).not.toBe(a.sandboxId);
              return { a: a.sandboxId, b: b.sandboxId };
            }),
        );

        expect(await harness.isReleased(outer.a)).toBe(true);
        expect(await harness.isReleased(outer.b)).toBe(true);
      },
      LEASE_TIMEOUT_MS,
    );
  });
}

function describeIsolation(harness: SandboxConformanceHarness): void {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function secret(): Promise<{ path: string; content: string }> {
    const file = await hostSecret();
    cleanups.push(file.cleanup);
    return { path: file.path, content: file.content };
  }

  describe("isolation is real, not nominal", () => {
    // The positive control. Without it "the sandbox cannot read the host file"
    // is satisfied by an adapter whose exec fails at everything, and the two
    // negatives below would prove nothing at all.
    test(
      "a file the sandbox wrote is readable by the sandbox, through both the port and a command",
      async () => {
        const port = await harness.create();
        const marker = `forge-in-sandbox-${randomUUID()}`;

        const seen = await port.withSandbox(
          { profile: first(port.profiles), correlationId: "conformance" },
          async (sandbox) => {
            const path = `${sandbox.workspacePath}/probe.txt`;
            await sandbox.writeFile(path, encode(marker));
            return {
              read: decode(await sandbox.readFile(path)),
              exec: await sandbox.exec(["cat", path]),
            };
          },
        );

        expect(seen.read).toBe(marker);
        expect(seen.exec.exitCode).toBe(0);
        expect(seen.exec.stdout).toContain(marker);
      },
      LEASE_TIMEOUT_MS,
    );

    test(
      "a file on the host is not readable from inside the sandbox",
      async () => {
        const port = await harness.create();
        const host = await secret();

        await port.withSandbox(
          { profile: first(port.profiles), correlationId: "conformance" },
          async (sandbox) => {
            await expect(sandbox.readFile(host.path)).rejects.toThrow();
          },
        );
      },
      LEASE_TIMEOUT_MS,
    );

    test(
      "a file on the host is not visible to a command run inside the sandbox",
      async () => {
        const port = await harness.create();
        const host = await secret();

        const result = await port.withSandbox(
          { profile: first(port.profiles), correlationId: "conformance" },
          async (sandbox) => sandbox.exec(["cat", host.path]),
        );

        // An adapter that "sandboxed" by spawning a child process on the host
        // returns the content here, and nothing else in the suite would notice.
        expect(result.stdout).not.toContain(host.content);
        expect(result.exitCode).not.toBe(0);
      },
      LEASE_TIMEOUT_MS,
    );

    test(
      "one lease cannot read another lease's files",
      async () => {
        const port = await harness.create();
        const profile = first(port.profiles);
        const marker = `forge-neighbour-${randomUUID()}`;

        await port.withSandbox(
          { profile, correlationId: "outer" },
          async (a) => {
            const path = `${a.workspacePath}/neighbour.txt`;
            await a.writeFile(path, encode(marker));

            await port.withSandbox(
              { profile, correlationId: "inner" },
              async (b) => {
                await expect(b.readFile(path)).rejects.toThrow();
                expect((await b.exec(["cat", path])).stdout).not.toContain(
                  marker,
                );
              },
            );
          },
        );
      },
      LEASE_TIMEOUT_MS,
    );

    test(
      "a sandbox is disposable: a new lease does not inherit the last one's files",
      async () => {
        const port = await harness.create();
        const profile = first(port.profiles);
        const marker = `forge-leftover-${randomUUID()}`;

        const path = await port.withSandbox(
          { profile, correlationId: "first" },
          async (sandbox) => {
            const target = `${sandbox.workspacePath}/leftover.txt`;
            await sandbox.writeFile(target, encode(marker));
            return target;
          },
        );

        await port.withSandbox(
          { profile, correlationId: "second" },
          async (sandbox) => {
            await expect(sandbox.readFile(path)).rejects.toThrow();
          },
        );
      },
      LEASE_TIMEOUT_MS,
    );
  });
}

/**
 * Runs the whole `SandboxPort` contract against one adapter. A new sandbox
 * backend proves itself by calling this with its own factory, so the in-memory
 * adapter and a container-backed one cannot drift apart.
 */
export function describeSandboxConformance(
  harness: SandboxConformanceHarness,
): void {
  describe(`${harness.name} · SandboxPort conformance`, () => {
    describeProfileHonesty(harness);
    describeNoHostFallback(harness);
    describeRelease(harness);
    describeIsolation(harness);
  });
}
