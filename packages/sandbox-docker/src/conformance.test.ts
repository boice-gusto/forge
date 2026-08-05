import { describeSandboxConformance } from "@forge/sandbox-conformance";
import { containerRuntimeAvailable } from "@forge/store-conformance";
import { describe } from "vitest";

import { createEngineClient, resolveSocketPath } from "./engine.js";
import { DEAD_SOCKET_PATH, TEST_PROFILES } from "./profiles.test-fixture.js";
import { createDockerSandbox } from "./sandbox.js";

const dockerAvailable = await containerRuntimeAvailable("sandbox-docker");

describe.skipIf(!dockerAvailable)("sandbox-docker", () => {
  const client = createEngineClient(resolveSocketPath(process.env.DOCKER_HOST));

  describeSandboxConformance({
    name: "sandbox-docker",
    profiles: Object.keys(TEST_PROFILES),
    create: () => createDockerSandbox({ profiles: TEST_PROFILES }),
    // Not a flag: the adapter is pointed at a socket with no daemon behind it,
    // which is what an operator's broken host actually looks like.
    createUnavailable: () =>
      createDockerSandbox({
        profiles: TEST_PROFILES,
        socketPath: DEAD_SOCKET_PATH,
      }),
    // Asked of the daemon, not of the adapter. An adapter that forgot a
    // container it left running would answer this one wrong.
    isReleased: async (sandboxId) =>
      (await client.inspect(sandboxId)) === undefined,
  });
});
