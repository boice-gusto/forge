import { loadDeploymentPolicy, NO_COMPANY_POLICY } from "@forge/company";
import { createRunConsumer, runtimeHost } from "@forge/composition";
import {
  createDurableStack,
  type EffectSink,
  type TransformFn,
} from "@forge/composition/durable";
import { bindIntake } from "@forge/composition/intake-binding";

/**
 * Every channel a deployment serves must resolve, or a webhook that was
 * configured answers 404 and looks like the sender's fault.
 */
const refuseIntake = (problems: readonly string[]): never => {
  process.stderr.write(
    `[forge-worker] The company's "connectors" adapter could not be bound:\n` +
      problems.map((problem) => `  - ${problem}\n`).join(""),
  );
  process.exit(1);
};

import { createProgressAnnouncer } from "@forge/intake";
import { createAnthropicProvider } from "@forge/provider-anthropic";
import { createDockerSandbox } from "@forge/sandbox-docker";

import { startWorker } from "./main.js";

/**
 * The worker process.
 *
 * Until now this started a health endpoint and nothing else: the consumer and
 * the durable stack existed but only ever met inside a test, so the binary
 * answered `/health/ready` while consuming no jobs at all. A green probe on a
 * process doing no work is worse than a red one.
 */

/**
 * Read once: the health snapshot reports this and the policy loader resolves
 * the company package against it, and a deployment where those two disagree is
 * one whose probe names a version it is not running.
 */
const forgeVersion = process.env.FORGE_VERSION ?? "0.1.0";

const build = {
  version: forgeVersion,
  gitSha: process.env.FORGE_GIT_SHA ?? "local",
  buildTime: process.env.FORGE_BUILD_TIME ?? new Date().toISOString(),
};

const port = Number.parseInt(process.env.PORT ?? "3102", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`PORT must be a valid port number; got ${process.env.PORT}.`);
}

if (
  process.env.FORGE_DATABASE_URL === undefined ||
  process.env.FORGE_REDIS_URL === undefined
) {
  // Loudly, and then exit. A worker that cannot reach its queue has nothing to
  // do, and staying up to serve a health check would report a fleet as ready
  // while no run ever advances.
  process.stderr.write(
    "[forge-worker] FORGE_DATABASE_URL and FORGE_REDIS_URL are both required; " +
      "a worker with no queue consumes nothing.\n",
  );
  process.exit(1);
}

const csv = (spec: string): readonly string[] =>
  spec
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

/**
 * A worker is part of a deployment, not a deployment of its own.
 *
 * It resolves policy through the same loader the control plane uses, from the
 * same company package and the same ceiling. A worker configured even slightly
 * differently would make a run's outcome depend on which process happened to
 * take it off the queue, which is the least debuggable failure this system
 * could have — so a missing company is a refusal to start rather than a
 * warning and a silent default-deny.
 */
const companyRoot = process.env.FORGE_COMPANY;
if (companyRoot === undefined && process.env.FORGE_WORKER_NO_COMPANY !== "1") {
  process.stderr.write(
    "[forge-worker] FORGE_COMPANY is required: a worker sharing a queue with a " +
      "control plane must resolve the same policy, or a run's outcome depends " +
      "on which process took it. Set FORGE_WORKER_NO_COMPANY=1 only if this " +
      "deployment serves no company package.\n",
  );
  process.exit(1);
}

const deployment =
  companyRoot === undefined
    ? NO_COMPANY_POLICY
    : await loadDeploymentPolicy({
        root: companyRoot,
        hostCapabilities: csv(process.env.FORGE_HOST_CAPABILITIES ?? ""),
        forgeVersion,
      });

/**
 * Where a gated action actually lands.
 *
 * The default sink returns `undefined` and does nothing, which in a control
 * plane is reasonable — it is not the thing that acts — and in a *worker* is
 * the whole job missing. A worker with the default sink walks every run,
 * passes every gate, records every effect as dispatched, and performs none of
 * them. A human approves, the audit log says the action went out, and nothing
 * went anywhere. That is the same shape as the health probe hard-coded to
 * "healthy", and worse, because it is silent on the safety-critical path.
 *
 * So: a worker binds the company's `effects` adapter, or refuses to start.
 */
function effectSinkFrom(bound: unknown): EffectSink {
  const candidate =
    (bound as { default?: unknown; effects?: unknown })?.default ??
    (bound as { effects?: unknown })?.effects;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as EffectSink).perform === "function"
  ) {
    return candidate as EffectSink;
  }
  process.stderr.write(
    '[forge-worker] The company\'s "effects" adapter resolved to something ' +
      "with no perform(); a worker cannot dispatch with it. Export the sink " +
      "as the module's default, or as `effects`.\n",
  );
  process.exit(1);
}

const boundEffects = deployment.adapters.effects;
if (boundEffects === undefined && process.env.FORGE_WORKER_NO_EFFECTS !== "1") {
  process.stderr.write(
    '[forge-worker] This company binds no "effects" adapter, so every gated ' +
      "action would be recorded as dispatched and performed nowhere. Add an " +
      'adapter binding with id "effects", or set FORGE_WORKER_NO_EFFECTS=1 ' +
      "if this deployment really is meant to walk runs without acting.\n",
  );
  process.exit(1);
}

/**
 * What a `transform` node computes with.
 *
 * Bound if the company offers one, and — unlike the effect sink — *not* a
 * refusal when it does not. A company may simply have no transform nodes, and
 * the failure mode if it has one and this is missing is already loud: the
 * runtime stops the run naming the `transformRef` it could not resolve. That
 * is a bad place to find out, but it is not a silent one, and inventing a
 * refusal for a table nobody may need would make every company declare an
 * empty adapter to start a worker.
 *
 * A table that is present and wrong is a different matter. A `transformRef`
 * resolving to something that is not a function would throw deep inside a
 * walk, so the shape is checked here, where the message can say which entry.
 */
function transformsFrom(bound: unknown): Record<string, TransformFn> {
  const candidate =
    (bound as { default?: unknown; transforms?: unknown })?.default ??
    (bound as { transforms?: unknown })?.transforms;
  if (typeof candidate !== "object" || candidate === null) {
    process.stderr.write(
      '[forge-worker] The company\'s "transforms" adapter resolved to ' +
        "something that is not a table. Export a record of transformRef to " +
        "function as the module's default, or as `transforms`.\n",
    );
    process.exit(1);
  }
  const table = candidate as Record<string, unknown>;
  const notFunctions = Object.keys(table).filter(
    (ref) => typeof table[ref] !== "function",
  );
  if (notFunctions.length > 0) {
    process.stderr.write(
      `[forge-worker] These entries in the company's "transforms" table are ` +
        `not functions, so a node naming one would fail mid-walk: ${notFunctions.join(", ")}.\n`,
    );
    process.exit(1);
  }
  return table as Record<string, TransformFn>;
}

const boundTransforms = deployment.adapters.transforms;

/**
 * The isolation a `sandbox` node actually gets.
 *
 * `createDurableStack` defaults to the in-memory adapter, which simulates a
 * filesystem and an exec. In a test that is the point; in a worker it means a
 * step that declared `forge.node-ts` — declared, in the compiled artifact,
 * that it runs somewhere it cannot reach the host — runs against a Map, in
 * this process, with this process's filesystem and this process's network. The
 * declaration is the whole basis on which a workflow is allowed to run
 * untrusted content, and nothing anywhere said it was not being honoured.
 *
 * So a worker serving a company that declares profiles provisions them for
 * real, and refuses if it cannot. Profiles come from the deployment operator,
 * as the sandbox images do: an author names an alias, never an image.
 */
const declaredProfiles = process.env.FORGE_SANDBOX_PROFILES;
const sandboxProfiles = csv(declaredProfiles ?? "");
const sandboxImage = process.env.FORGE_SANDBOX_IMAGE;
const declaredMemoryMb = process.env.FORGE_SANDBOX_MEMORY_MB;
const sandboxMemoryMb = Number.parseInt(declaredMemoryMb ?? "512", 10);
const mockSandbox = process.env.FORGE_WORKER_MOCK_SANDBOX === "1";

if (sandboxProfiles.length > 0 && !mockSandbox) {
  if (sandboxImage === undefined) {
    process.stderr.write(
      "[forge-worker] FORGE_SANDBOX_PROFILES names profiles but " +
        "FORGE_SANDBOX_IMAGE does not say what to provision them with, so " +
        "every sandboxed step would run in a simulated environment inside " +
        "this process. Set FORGE_SANDBOX_IMAGE, or set " +
        "FORGE_WORKER_MOCK_SANDBOX=1 if simulated isolation is really what " +
        "this deployment wants.\n",
    );
    process.exit(1);
  }
  if (!Number.isInteger(sandboxMemoryMb) || sandboxMemoryMb <= 0) {
    process.stderr.write(
      `[forge-worker] FORGE_SANDBOX_MEMORY_MB must be a positive integer; got ${declaredMemoryMb}.\n`,
    );
    process.exit(1);
  }
}

const realSandbox =
  sandboxProfiles.length > 0 && sandboxImage !== undefined && !mockSandbox
    ? createDockerSandbox({
        profiles: Object.fromEntries(
          sandboxProfiles.map((profile) => [
            profile,
            { image: sandboxImage, memoryMb: sandboxMemoryMb },
          ]),
        ),
      })
    : undefined;

if (realSandbox !== undefined && !(await realSandbox.health()).available) {
  // Checked at boot, not at the first sandboxed step. A worker that cannot
  // provision isolation is a worker that will fail every run needing it, and
  // discovering that behind an approval gate is discovering it too late.
  process.stderr.write(
    "[forge-worker] The container runtime is unreachable, so the profiles " +
      "this deployment declares cannot be provisioned.\n",
  );
  process.exit(1);
}

/**
 * Which model a workflow's `agent` node actually talks to.
 *
 * `createDurableStack` defaults to `createMockProvider`, which returns a
 * canned completion. Correct for a test, and in a worker it means an agent
 * step producing content nobody generated — content that then flows into a
 * gate, is shown to a human as the thing they are approving, and is dispatched
 * as a real side effect. The third stand-in wired into a process that meant
 * it, after the effect sink and the sandbox.
 *
 * The adapter refuses to construct without a credential, so this only decides
 * *which* adapter. The model is the deployment's choice, like the sandbox
 * images: an author writes a prompt, never a model name.
 */
const mockProvider = process.env.FORGE_WORKER_MOCK_PROVIDER === "1";
if (!mockProvider && process.env.ANTHROPIC_API_KEY === undefined) {
  process.stderr.write(
    "[forge-worker] No ANTHROPIC_API_KEY, so every agent step would be " +
      "answered by a canned completion and then shown to a human as the " +
      "thing they are approving. Set it, or set FORGE_WORKER_MOCK_PROVIDER=1 " +
      "if a stand-in model is really what this deployment wants.\n",
  );
  process.exit(1);
}
const model = process.env.FORGE_MODEL;
if (!mockProvider && model === undefined) {
  process.stderr.write(
    "[forge-worker] FORGE_MODEL is required: which model answers an agent " +
      "step is a deployment's decision, not a default this binary picks.\n",
  );
  process.exit(1);
}

const declaredMaxTokens = process.env.FORGE_MODEL_MAX_TOKENS;

const provider = mockProvider
  ? undefined
  : createAnthropicProvider({
      model: model as string,
      ...(declaredMaxTokens === undefined
        ? {}
        : { maxTokens: Number.parseInt(declaredMaxTokens, 10) }),
    });

const stack = await createDurableStack({
  ...(provider === undefined ? {} : { provider }),
  rules: deployment.rules,
  grants: deployment.grants,
  ...(realSandbox === undefined ? {} : { sandbox: realSandbox }),
  ...(boundTransforms === undefined
    ? {}
    : { transforms: transformsFrom(boundTransforms) }),
  environment: "production",
  ...(boundEffects === undefined
    ? {}
    : { effects: effectSinkFrom(boundEffects) }),
  ...(declaredProfiles === undefined ? {} : { sandboxProfiles }),
});

/**
 * The same consumer the control plane runs, on the same queue. It lives in
 * `@forge/composition` so that "what a `workflow.execute` job means" has one
 * answer rather than one per process that reads the queue.
 */
/**
 * The channels this worker can report back to.
 *
 * Bound from the same company adapter the control plane uses, and this is the
 * half that was missing: in a real deployment the *worker* walks most runs, so
 * a control plane that announces and a worker that does not means a webhook
 * hears about the runs the API happened to pick up and nothing else. A run
 * whose visibility depends on which process took it off the queue is the same
 * class of failure as one whose *outcome* does.
 */
const intake = bindIntake(
  deployment.adapters.connectors,
  stack.pool,
  refuseIntake,
);

const consumer = createRunConsumer({
  queue: stack.queue,
  host: runtimeHost(stack.runtime),
  observability: stack.observability,
  ...(intake === undefined
    ? {}
    : {
        progress: {
          announcer: createProgressAnnouncer({
            connectors: intake.connectors,
          }),
          runs: stack.runs,
          runUrl: (runId: string) =>
            `${process.env.FORGE_PUBLIC_URL ?? ""}/v1/runs/${runId}`,
        },
      }),
});

let closing = false;
/**
 * Draining matters more here than anywhere else: `close()` is what flushes
 * buffered spans and returns the Redis and Postgres connections. A worker
 * killed without it loses exactly the telemetry describing why it was killed.
 */
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  process.stderr.write(`[forge-worker] ${signal}, draining.\n`);
  try {
    await stack.close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await consumer.start();
// Asked on every probe: the queue's own answer, plus whether this process is
// still subscribed. A worker whose consumer connection died is not ready, and
// nothing else in the deployment can tell.
await startWorker(
  build,
  async () => ({
    queue: (await stack.queue.health()).available ? "healthy" : "unavailable",
    persistence: "healthy",
  }),
  port,
);
