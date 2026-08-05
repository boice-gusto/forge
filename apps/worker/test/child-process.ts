import { compileToArtifact } from "@forge/composition";
import { createDurableStack } from "@forge/composition/durable";
import type { JsonValue } from "@forge/ports";

import {
  RESTART_PAYLOAD,
  RESTART_PUBLISHED,
  RESTART_STACK_OPTIONS,
  RESTART_WORKFLOW,
  restartTransforms,
} from "./durable-workflow.js";

/**
 * One process of the restart proof, in whichever half the parent asked for.
 *
 * It exists so that "another process" means another process. A worker thread
 * or a freshly constructed stack would still share the module graph, and a
 * per-process cache would go on answering questions it should no longer be
 * able to answer — which is exactly the mistake this file was written to stop
 * the suite from making.
 *
 * `park` starts a run and lets it stop at the gate; `resume` drives one whose
 * gate has been decided. Either way the process exits, and everything it held
 * goes with it.
 */
const mode = process.env.FORGE_TEST_MODE;

const compiled = compileToArtifact(RESTART_WORKFLOW);
if (!compiled.ok) {
  process.stderr.write(JSON.stringify(compiled.diagnostics));
  process.exit(2);
}

const dispatched: JsonValue[] = [];
const ttl = process.env.FORGE_TEST_TTL_MS;
const stack = await createDurableStack({
  ...RESTART_STACK_OPTIONS,
  ...(ttl === undefined ? {} : { approvalTtlMs: Number(ttl) }),
  transforms: restartTransforms(),
  effects: {
    async perform(_runId, _nodeId, _effect, input) {
      if (mode === "park") {
        // A dispatch here would mean the gate did not hold.
        throw new Error("A PARKING PROCESS MUST NOT DISPATCH");
      }
      dispatched.push(input ?? null);
      return RESTART_PUBLISHED;
    },
  },
});

if (mode === "park") {
  const run = await stack.runtime.start({
    artifact: compiled.artifact,
    payload: RESTART_PAYLOAD,
  });
  process.stdout.write(
    JSON.stringify({ runId: run.runId, status: run.status }),
  );
} else {
  const runId = process.env.FORGE_TEST_RUN_ID as string;
  const outcome = await stack.resume({ runId, artifact: compiled.artifact });
  process.stdout.write(
    JSON.stringify({
      runId,
      kind: outcome.kind,
      status: outcome.kind === "resumed" ? outcome.run.status : outcome.reason,
      dispatched,
    }),
  );
}

await stack.close();
process.exit(0);
