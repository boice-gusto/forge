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
      "content-type": "application/json",
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
