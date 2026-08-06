import { createRunConsumer, runtimeHost } from "@forge/composition";
import { createDurableStack } from "@forge/composition/durable";

import { deploymentPolicy, harnessSink, harnessTransforms } from "./sink.js";

/**
 * A worker, composed the way `apps/worker/src/server.ts` composes one.
 *
 * Same durable stack, same consumer, same policy loader, same queue. The only
 * differences are the two things the binary offers no way to supply from the
 * outside: an effect sink that can be observed and slowed, and a transform
 * table. Both are needed to have a window to be violent inside; neither touches
 * the runtime, the stores or the queue, which is where every invariant under
 * attack actually lives.
 */

const deployment = await deploymentPolicy();

const stack = await createDurableStack({
  rules: deployment.rules,
  grants: deployment.grants,
  environment: "production",
  effects: harnessSink(),
  transforms: harnessTransforms(),
});

await createRunConsumer({
  queue: stack.queue,
  host: runtimeHost(stack.runtime),
  observability: stack.observability,
}).start();

// The parent waits for this before it starts a run. Without it, a run enqueued
// in the gap between spawn and subscribe would sit in Redis and the scenario
// would time out blaming the wrong thing.
process.stdout.write("HARNESS-READY\n");

process.on("SIGTERM", () => {
  void stack.close().then(() => process.exit(0));
});
