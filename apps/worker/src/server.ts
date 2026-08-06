import { loadDeploymentPolicy, NO_COMPANY_POLICY } from "@forge/company";
import { createRunConsumer, runtimeHost } from "@forge/composition";
import {
  createDurableStack,
  type EffectSink,
} from "@forge/composition/durable";

import { startWorker } from "./main.js";

/**
 * The worker process.
 *
 * Until now this started a health endpoint and nothing else: the consumer and
 * the durable stack existed but only ever met inside a test, so the binary
 * answered `/health/ready` while consuming no jobs at all. A green probe on a
 * process doing no work is worse than a red one.
 */

const build = {
  version: process.env.FORGE_VERSION ?? "0.1.0",
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
        forgeVersion: process.env.FORGE_VERSION ?? "0.1.0",
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

const stack = await createDurableStack({
  rules: deployment.rules,
  grants: deployment.grants,
  environment: "production",
  ...(boundEffects === undefined
    ? {}
    : { effects: effectSinkFrom(boundEffects) }),
  ...(process.env.FORGE_SANDBOX_PROFILES === undefined
    ? {}
    : { sandboxProfiles: csv(process.env.FORGE_SANDBOX_PROFILES) }),
});

/**
 * The same consumer the control plane runs, on the same queue. It lives in
 * `@forge/composition` so that "what a `workflow.execute` job means" has one
 * answer rather than one per process that reads the queue.
 */
const consumer = createRunConsumer({
  queue: stack.queue,
  host: runtimeHost(stack.runtime),
  observability: stack.observability,
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
