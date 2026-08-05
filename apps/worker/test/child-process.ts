import { compileToArtifact } from "@forge/composition";
import { createDurableStack } from "@forge/composition/durable";
import type { JsonValue } from "@forge/ports";

import {
  AGENT_WORKFLOW,
  countingProvider,
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
 * goes with it. What it reports on the way out includes how many times *it*
 * asked a model, so the parent can sum the two halves and require one.
 */
const mode = process.env.FORGE_TEST_MODE;
const source =
  process.env.FORGE_TEST_WORKFLOW === "agent"
    ? AGENT_WORKFLOW
    : RESTART_WORKFLOW;

const compiled = compileToArtifact(source);
if (!compiled.ok) {
  process.stderr.write(JSON.stringify(compiled.diagnostics));
  process.exit(2);
}

const dispatched: JsonValue[] = [];
const ttl = process.env.FORGE_TEST_TTL_MS;
const arm = process.env.FORGE_TEST_ARM ?? "publish-it";
const agent = countingProvider(
  process.env.FORGE_TEST_TEXT ?? "drafted by process one",
);

const stack = await createDurableStack({
  ...RESTART_STACK_OPTIONS,
  ...(ttl === undefined ? {} : { approvalTtlMs: Number(ttl) }),
  transforms: restartTransforms(),
  provider: agent.provider,
  branchFor: () => arm,
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

const report = (fields: Record<string, unknown>): void => {
  process.stdout.write(
    JSON.stringify({ ...fields, dispatched, providerCalls: agent.calls() }),
  );
};

if (mode === "park") {
  const run = await stack.runtime.start({
    artifact: compiled.artifact,
    payload: RESTART_PAYLOAD,
  });
  report({ runId: run.runId, status: run.status });
} else {
  const runId = process.env.FORGE_TEST_RUN_ID as string;
  const run = await stack.resume(runId);
  report({ runId, status: run?.status ?? "unknown", error: run?.error });
}

await stack.close();
process.exit(0);
