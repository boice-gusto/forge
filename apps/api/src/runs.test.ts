import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { createApiApp } from "./main.js";

const BEARER = "local-test";
const AUTH = { authorization: `Bearer ${BEARER}` };

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../examples/acme/workflows/campaign-brief.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  workflow: unknown;
  capabilities: string[];
  policy: { rules: unknown[]; grants: string[] };
};

function app() {
  return createApiApp({
    build: { version: "0.1.0", gitSha: "test", buildTime: "2026-01-01" },
    dependencies: { queue: "healthy", persistence: "healthy" },
    adminToken: BEARER,
    principal: "marketing-lead",
  });
}

const startBody = fixture;

describe("control plane", () => {
  test("compiles a workflow and exposes only its public surface", async () => {
    const response = await app().inject({
      method: "POST",
      url: "/v1/workflows/compile",
      payload: { workflow: fixture.workflow },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.workflowId).toBe("acme.marketing.campaign-brief");
    expect(body.publicSurface.approvalGates).toEqual(["gate"]);
    expect(body.publicSurface.declaredEffects).toEqual(["slack.post"]);
    // The engine plan and the IR are never serialised to a client.
    expect(body).not.toHaveProperty("ir");
    expect(body).not.toHaveProperty("enginePlan");
  });

  test("a compile failure returns diagnostics rather than a 500", async () => {
    const response = await app().inject({
      method: "POST",
      url: "/v1/workflows/compile",
      payload: { workflow: { id: "broken", version: "nope", nodes: [] } },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("WORKFLOW_COMPILE_FAILED");
  });

  test("starting a run requires an authenticated caller", async () => {
    const response = await app().inject({
      method: "POST",
      url: "/v1/runs",
      payload: startBody,
    });

    expect(response.statusCode).toBe(401);
  });

  test("a branch with no decision fails the run rather than taking every arm", async () => {
    // The API accepts branch decisions in the body only because run data does
    // not flow between nodes yet. Omitting them must stop the run, not pick.
    const { branch, ...withoutBranch } = startBody as Record<string, unknown>;
    expect(branch).toBeDefined();

    const response = await app().inject({
      method: "POST",
      url: "/v1/runs",
      headers: AUTH,
      payload: withoutBranch,
    });

    expect(response.statusCode).toBe(201);
    const run = response.json();
    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("No arm was chosen");
    expect(run.performedEffects).toEqual([]);
  });

  test("a started run parks at the gate with nothing dispatched", async () => {
    const response = await app().inject({
      method: "POST",
      url: "/v1/runs",
      headers: AUTH,
      payload: startBody,
    });
    const run = response.json();

    expect(response.statusCode).toBe(201);
    expect(run.status).toBe("AWAITING_APPROVAL");
    expect(run.performedEffects).toEqual([]);
    expect(run.pendingApprovalId).toBeDefined();
  });

  test("the full lifecycle: start, list the gate, approve, effect dispatched once", async () => {
    const server = app();
    const started = (
      await server.inject({
        method: "POST",
        url: "/v1/runs",
        headers: AUTH,
        payload: startBody,
      })
    ).json();

    const pending = (
      await server.inject({
        method: "GET",
        url: `/v1/runs/${started.runId}/approvals`,
        headers: AUTH,
      })
    ).json();
    expect(pending.pending).toHaveLength(1);
    expect(pending.pending[0].nodeId).toBe("publish");
    expect(pending.pending[0].policyId).toBe("acme.marketing.external-publish");

    const decided = await server.inject({
      method: "POST",
      url: `/v1/runs/${started.runId}/approvals/${started.pendingApprovalId}/decision`,
      headers: AUTH,
      payload: { decision: "approve" },
    });
    const run = decided.json();

    expect(decided.statusCode).toBe(200);
    expect(run.status).toBe("SUCCEEDED");
    expect(run.performedEffects).toEqual(["publish"]);

    const after = (
      await server.inject({
        method: "GET",
        url: `/v1/runs/${started.runId}/approvals`,
        headers: AUTH,
      })
    ).json();
    expect(after.pending).toEqual([]);
  });

  test("rejecting fails the run and dispatches nothing", async () => {
    const server = app();
    const started = (
      await server.inject({
        method: "POST",
        url: "/v1/runs",
        headers: AUTH,
        payload: startBody,
      })
    ).json();

    const run = (
      await server.inject({
        method: "POST",
        url: `/v1/runs/${started.runId}/approvals/${started.pendingApprovalId}/decision`,
        headers: AUTH,
        payload: { decision: "reject", reason: "off brand" },
      })
    ).json();

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("off brand");
    expect(run.performedEffects).toEqual([]);
  });

  test("deciding without authentication is refused", async () => {
    const server = app();
    const started = (
      await server.inject({
        method: "POST",
        url: "/v1/runs",
        headers: AUTH,
        payload: startBody,
      })
    ).json();

    const response = await server.inject({
      method: "POST",
      url: `/v1/runs/${started.runId}/approvals/${started.pendingApprovalId}/decision`,
      payload: { decision: "approve" },
    });

    expect(response.statusCode).toBe(401);
  });

  test("an unrecognised decision kind is refused rather than defaulted", async () => {
    const server = app();
    const started = (
      await server.inject({
        method: "POST",
        url: "/v1/runs",
        headers: AUTH,
        payload: startBody,
      })
    ).json();

    const response = await server.inject({
      method: "POST",
      url: `/v1/runs/${started.runId}/approvals/${started.pendingApprovalId}/decision`,
      headers: AUTH,
      payload: { decision: "yolo" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("DECISION_INVALID");
  });

  test("an unknown run is a 404, not an empty success", async () => {
    const response = await app().inject({
      method: "GET",
      url: "/v1/runs/run_nope",
      headers: AUTH,
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("control plane edges", () => {
  test("approvals for an unknown run is a 404", async () => {
    const response = await app().inject({
      method: "GET",
      url: "/v1/runs/run_nope/approvals",
      headers: AUTH,
    });

    expect(response.statusCode).toBe(404);
  });

  test("a stale decision is a 409 conflict, not a 500", async () => {
    const server = app();
    const started = (
      await server.inject({
        method: "POST",
        url: "/v1/runs",
        headers: AUTH,
        payload: startBody,
      })
    ).json();

    const response = await server.inject({
      method: "POST",
      url: `/v1/runs/${started.runId}/approvals/approval_missing/decision`,
      headers: AUTH,
      payload: { decision: "approve" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("DECISION_REFUSED");
  });

  test("a reject without a reason still records one", async () => {
    const server = app();
    const started = (
      await server.inject({
        method: "POST",
        url: "/v1/runs",
        headers: AUTH,
        payload: startBody,
      })
    ).json();

    const run = (
      await server.inject({
        method: "POST",
        url: `/v1/runs/${started.runId}/approvals/${started.pendingApprovalId}/decision`,
        headers: AUTH,
        payload: { decision: "reject" },
      })
    ).json();

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("No reason given");
  });

  test("an edit reissues the gate instead of authorising", async () => {
    const server = app();
    const started = (
      await server.inject({
        method: "POST",
        url: "/v1/runs",
        headers: AUTH,
        payload: startBody,
      })
    ).json();

    const run = (
      await server.inject({
        method: "POST",
        url: `/v1/runs/${started.runId}/approvals/${started.pendingApprovalId}/decision`,
        headers: AUTH,
        payload: { decision: "edit", patch: { copy: "reworded" } },
      })
    ).json();

    expect(run.status).toBe("AWAITING_APPROVAL");
    expect(run.pendingApprovalId).not.toBe(started.pendingApprovalId);
    expect(run.performedEffects).toEqual([]);
  });

  test("a timeout decision fails the run", async () => {
    const server = app();
    const started = (
      await server.inject({
        method: "POST",
        url: "/v1/runs",
        headers: AUTH,
        payload: startBody,
      })
    ).json();

    const run = (
      await server.inject({
        method: "POST",
        url: `/v1/runs/${started.runId}/approvals/${started.pendingApprovalId}/decision`,
        headers: AUTH,
        payload: { decision: "timeout" },
      })
    ).json();

    expect(run.status).toBe("FAILED");
  });

  test("starting with a malformed workflow returns diagnostics", async () => {
    const response = await app().inject({
      method: "POST",
      url: "/v1/runs",
      headers: AUTH,
      payload: { workflow: { nope: true } },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("WORKFLOW_COMPILE_FAILED");
  });

  test("a run started without policy uses the shared stack and is retrievable", async () => {
    const server = app();
    const started = (
      await server.inject({
        method: "POST",
        url: "/v1/runs",
        headers: AUTH,
        payload: { workflow: fixture.workflow },
      })
    ).json();

    const fetched = await server.inject({
      method: "GET",
      url: `/v1/runs/${started.runId}`,
      headers: AUTH,
    });

    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().runId).toBe(started.runId);
  });
});
