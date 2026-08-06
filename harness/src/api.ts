import type { JsonValue } from "@forge/ports";

import { waitFor } from "./docker.js";
import { type Api, OPERATORS, type Role } from "./processes.js";

/** A thin client. Not `@forge/sdk`: these scenarios need the raw status code. */

export interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export async function call(
  api: Api,
  method: string,
  path: string,
  role: Role,
  body?: unknown,
): Promise<Reply> {
  const response = await fetch(`${api.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${OPERATORS[role]}`,
      // Only when there is one. Announcing a JSON body and sending none is
      // rejected by the server before any route sees it, so a POST that
      // legitimately carries nothing — a redrive names its target in the path
      // — would fail with a content-type error that says nothing about the
      // thing being tested.
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

export const startRun = (
  api: Api,
  workflow: unknown,
  payload: JsonValue,
  role: Role = "marketing-lead",
): Promise<Reply> =>
  call(api, "POST", "/v1/runs", role, {
    workflow,
    capabilities: ["slack.write"],
    payload,
  });

/**
 * The statuses at which the queue owes the run nothing.
 *
 * Not "terminal", and the distinction is the whole point: every scenario here
 * is about a run parked at its *gate*, and a helper that waited for a finished
 * run would drive the run past the thing under test before asserting on it.
 */
/**
 * "Stopped", not "finished".
 *
 * `AWAITING_APPROVAL` is in here because a run parked at a gate has stopped
 * moving, which is what most callers are waiting for. It is also a trap: call
 * this on a run that is *already* at a gate and it returns immediately, having
 * waited for a state the run never left. A test that then asserts on work an
 * enqueued job has yet to do is racing, and will mostly lose.
 *
 * If what you need is "the decision was carried out", wait for that — the
 * effect settling, the status changing from the one you started in — and not
 * for this.
 */
const SETTLED = new Set([
  "AWAITING_APPROVAL",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);

export async function settle(
  api: Api,
  runId: string,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = {};
  await waitFor(
    `run ${runId} to settle`,
    async () => {
      const run = await call(api, "GET", `/v1/runs/${runId}`, "marketing-lead");
      last = run.body;
      return SETTLED.has(String(run.body.status));
    },
    timeoutMs,
    25,
  );
  return last;
}

export async function decide(
  api: Api,
  runId: string,
  approvalId: string,
  decision: "approve" | "reject" = "approve",
  role: Role = "marketing-lead",
): Promise<Reply> {
  return call(
    api,
    "POST",
    `/v1/runs/${runId}/approvals/${approvalId}/decision`,
    role,
    { decision },
  );
}
