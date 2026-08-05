import { containerRuntimeAvailable } from "@forge/store-conformance";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createEngineClient, resolveSocketPath } from "./engine.js";
import { TEST_IMAGE, TEST_PROFILES } from "./profiles.test-fixture.js";
import { createDockerSandbox } from "./sandbox.js";

/**
 * The 010 §6 hardening claims, checked against a running container rather than
 * against the configuration this adapter sends. A test that reads back its own
 * request proves the request, not the isolation.
 */

const PROFILE = "forge.sandbox-test";
const MARKER = "forge-network-reachable";
const REACH = ["wget", "-T", "3", "-q", "-O", "-"] as const;
const START_TIMEOUT_MS = 240_000;
/** The container's own root, its writable tmpfs, and kernel filesystems. */
const HOST_FREE_MOUNT =
  /^(?:\/|\/workspace|\/tmp|\/proc(?:\/.*)?|\/sys(?:\/.*)?|\/dev(?:\/.*)?|\/etc\/(?:hosts|hostname|resolv\.conf))$/u;
const EXEC_TIMEOUT_MS = 20_000;

const dockerAvailable = await containerRuntimeAvailable("sandbox-docker");

describe.skipIf(!dockerAvailable)("sandbox-docker hardening", () => {
  const client = createEngineClient(resolveSocketPath(process.env.DOCKER_HOST));
  const port = createDockerSandbox({ profiles: TEST_PROFILES });
  const started: string[] = [];

  /** A plain, unhardened container — the control the sandbox is measured against. */
  async function plainContainer(cmd: readonly string[]): Promise<string> {
    const id = await client.createContainer({
      Image: TEST_IMAGE,
      Cmd: [...cmd],
      Labels: { "com.forge.sandbox-test": "control" },
      HostConfig: { NetworkMode: "bridge", AutoRemove: false },
    });
    started.push(id);
    await client.startContainer(id);
    return id;
  }

  let peerUrl = "";
  let controlId = "";

  beforeAll(async () => {
    await client.ensureImage(TEST_IMAGE);
    const peer = await plainContainer([
      "sh",
      "-c",
      `echo ${MARKER} > /tmp/probe.txt && httpd -f -p 8080 -h /tmp`,
    ]);
    const networks = (await client.inspect(peer))?.NetworkSettings.Networks;
    const address = Object.values(networks ?? {})[0]?.IPAddress ?? "";
    peerUrl = `http://${address}:8080/probe.txt`;
    controlId = await plainContainer(["sleep", "2147483647"]);
  }, START_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all(started.map((id) => client.remove(id)));
  });

  async function inSandbox(
    command: readonly string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return port.withSandbox(
      { profile: PROFILE, correlationId: "hardening" },
      async (sandbox) => sandbox.exec(command),
    );
  }

  test(
    "the sandbox cannot reach a service the same host can reach",
    async (context) => {
      const control = await client.exec(
        controlId,
        [...REACH, peerUrl],
        EXEC_TIMEOUT_MS,
      );

      // Without a control the negative below is vacuous: a peer nothing can
      // reach makes an un-isolated sandbox look isolated. If the control
      // cannot reach it either, say so and leave the claim unproven.
      if (control.exitCode !== 0 || !control.stdout.includes(MARKER)) {
        process.stderr.write(
          "\n[sandbox-docker] The control container could not reach the peer, " +
            "so network isolation is UNVERIFIED rather than proven.\n\n",
        );
        context.skip();
        return;
      }

      const sandboxed = await inSandbox([...REACH, peerUrl]);

      expect(sandboxed.stdout).not.toContain(MARKER);
      expect(sandboxed.exitCode).not.toBe(0);
    },
    START_TIMEOUT_MS,
  );

  test("the sandbox has no network interface beyond loopback", async () => {
    const addresses = await inSandbox([
      "sh",
      "-c",
      "ip -o addr | grep -c -v ' lo '",
    ]);

    expect(addresses.stdout.trim()).toBe("0");
  });

  test("work in the sandbox does not run as root", async () => {
    expect((await inSandbox(["id", "-u"])).stdout.trim()).not.toBe("0");
  });

  test("the sandbox root filesystem is read-only outside the workspace", async () => {
    const written = await inSandbox([
      "sh",
      "-c",
      "echo escaped > /etc/forge-probe",
    ]);

    expect(written.exitCode).not.toBe(0);
    expect(written.stderr).toContain("Read-only file system");
  });

  test("nothing from the host is mounted into the sandbox", async () => {
    // The conformance suite proves the sandbox is not the host by looking for a
    // host file at its own path. A bind mount would put that file somewhere
    // *else*, so the mount table is checked directly: everything the container
    // can see must be its own root, its tmpfs workspace, or a kernel
    // filesystem. Anything else is a door into the host.
    const mounts = await inSandbox(["cat", "/proc/self/mounts"]);
    const points = mounts.stdout
      .trim()
      .split("\n")
      .map((line) => line.split(" ")[1] ?? "");

    expect(points.length).toBeGreaterThan(0);
    expect(points.filter((point) => !HOST_FREE_MOUNT.test(point))).toEqual([]);
  });

  test("the sandbox has no capabilities to escalate with", async () => {
    // CapEff is a hex mask; every capability dropped means it is all zeroes.
    const capabilities = await inSandbox([
      "sh",
      "-c",
      "grep CapEff /proc/self/status",
    ]);

    expect(capabilities.stdout).toMatch(/CapEff:\s+0+$/mu);
  });
});
