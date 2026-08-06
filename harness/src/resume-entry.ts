import { createDurableStack } from "@forge/composition/durable";

import {
  deploymentPolicy,
  harnessSink,
  harnessTransforms,
  label,
  performed,
} from "./sink.js";

/**
 * One re-entry into one run, in a process of its own, then exit.
 *
 * This is the operator redrive the product does not expose as a route — see the
 * report — and it is also how two workers are made to race one decided gate:
 * several of these, each told the same `HARNESS_START_AT`, so they call
 * `resume` within a few milliseconds of one another rather than in whatever
 * order `spawn` happened to return.
 *
 * A barrier on the wall clock rather than on a shared lock is deliberate: a
 * lock would be a thing this harness owns and could get wrong, and the race
 * being *approximate* is fine — the scenario asserts that both processes win
 * across repetitions, which is only satisfiable if the contention is real.
 */

const runId = process.env.HARNESS_RUN_ID;
if (runId === undefined) throw new Error("HARNESS_RUN_ID is required.");

const deployment = await deploymentPolicy();
const stack = await createDurableStack({
  rules: deployment.rules,
  grants: deployment.grants,
  environment: "production",
  effects: harnessSink(),
  transforms: harnessTransforms(),
});

const startAt = process.env.HARNESS_START_AT;
if (startAt !== undefined) {
  const wait = Number.parseInt(startAt, 10) - Date.now();
  if (wait > 0) await new Promise((settle) => setTimeout(settle, wait));
}

const startedAt = Date.now();
let status = "UNKNOWN";
let error: string | undefined;
try {
  const record = await stack.resume(runId);
  status = record?.status ?? "MISSING";
  error = record?.error;
} catch (thrown) {
  status = "THREW";
  error = thrown instanceof Error ? thrown.message : String(thrown);
}
const finishedAt = Date.now();

process.stdout.write(
  `HARNESS-REPORT ${JSON.stringify({
    label: label(),
    status,
    ...(error === undefined ? {} : { error }),
    performed,
    startedAt,
    finishedAt,
  })}\n`,
);

await stack.close();
process.exit(0);
