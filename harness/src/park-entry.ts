import { compileToArtifact } from "@forge/composition";
import { createDurableStack } from "@forge/composition/durable";

import {
  deploymentPolicy,
  harnessSink,
  harnessTransforms,
  label,
} from "./sink.js";
import { CHAINED, GATED, PAYLOAD, SLOW } from "./workflows.js";

/**
 * A run, created and walked as far as its gate, in a process that then exits.
 *
 * The starting process being *gone* is the point. Every chaos scenario that
 * follows attacks the window around the decision, and it has to attack a run
 * whose runtime, ledgers and connection pool are already someone else's memory
 * — otherwise a passing assertion could be explained by state this process
 * happened to still be holding.
 */

const WORKFLOWS = { gated: GATED, chained: CHAINED, slow: SLOW } as const;

const chosen = process.env.HARNESS_WORKFLOW ?? "chained";
const source = WORKFLOWS[chosen as keyof typeof WORKFLOWS];
if (source === undefined) {
  throw new Error(
    `HARNESS_WORKFLOW must be one of ${Object.keys(WORKFLOWS).join(", ")}; got ${chosen}.`,
  );
}

const compiled = compileToArtifact(source);
if (!compiled.ok) {
  throw new Error(
    `A harness fixture must compile: ${JSON.stringify(compiled.diagnostics)}`,
  );
}

const deployment = await deploymentPolicy();
const stack = await createDurableStack({
  rules: deployment.rules,
  grants: deployment.grants,
  environment: "production",
  effects: harnessSink(),
  transforms: harnessTransforms(),
});

/**
 * `create` then `resume`, rather than `start`.
 *
 * The same two steps the control plane and a worker take between them, so the
 * run this leaves behind is indistinguishable from one a deployment produced —
 * including its `PENDING` moment, which `start` skips.
 */
const created = await stack.runtime.create({
  artifact: compiled.artifact,
  capabilities: ["slack.write"],
  payload: PAYLOAD,
});

// `HARNESS_STOP_AT_PENDING` leaves the run created and unwalked, which is the
// state a control plane produces when the queue is unreachable.
const record =
  process.env.HARNESS_STOP_AT_PENDING === "1"
    ? created
    : await stack.runtime.resume(created.runId);

process.stdout.write(
  `HARNESS-PARKED ${JSON.stringify({
    label: label(),
    runId: created.runId,
    fingerprint: compiled.artifact.fingerprint,
    status: record?.status ?? "MISSING",
    ...(record?.error === undefined ? {} : { error: record.error }),
    pendingApprovalId: record?.pendingApprovalId,
  })}\n`,
);

await stack.close();
process.exit(0);
