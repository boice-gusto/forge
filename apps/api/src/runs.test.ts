import { readFileSync } from "node:fs";
import { createLocalStack } from "@forge/composition";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";

import { createApiApp } from "./main.js";
import { registerRunRoutes } from "./runs.js";

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

/**
 * An API whose caller holds exactly these roles, standing in for a directory.
 * The default `app()` grants every role, which is the right stance for one
 * shared admin token but the wrong one for testing that scoping works.
 */
function appWithRoles(roles: readonly string[]) {
  return createApiApp({
    build: { version: "0.1.0", gitSha: "test", buildTime: "2026-01-01" },
    dependencies: { queue: "healthy", persistence: "healthy" },
    adminToken: BEARER,
    principal: "marketing-lead",
    roles,
  });
}

const startBody = fixture;

/** The same workflow, gated for somebody who is not the caller. */
function gatedFor(approver: string) {
  return {
    ...fixture,
    policy: {
      ...fixture.policy,
      rules: fixture.policy.rules.map((rule) => ({
        ...(rule as Record<string, unknown>),
        approvers: [approver],
      })),
    },
  };
}

async function startRun(
  server: ReturnType<typeof app> | ReturnType<typeof Fastify>,
  payload: object = startBody,
) {
  const response = await server.inject({
    method: "POST",
    url: "/v1/runs",
    headers: AUTH,
    payload,
  });
  return response.json();
}

describe("control plane", () => {
  test("compiles a workflow and exposes only its public surface", async () => {
    const response = await app().inject({
      method: "POST",
      url: "/v1/workflows/compile",
      headers: AUTH,
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
      headers: AUTH,
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

  test("listing a run's gates requires a caller, now that it names deciders", async () => {
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
      method: "GET",
      url: `/v1/runs/${started.runId}/approvals`,
    });

    expect(response.statusCode).toBe(401);
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

/**
 * An operator arrives without a run id — that is the whole point of an inbox.
 * These routes are the ones that make the operator surfaces possible at all.
 */
describe("the operator can see the estate without knowing a run id first", () => {
  test("every run is listed, most recent first, with distinct identifiers", async () => {
    const server = app();
    const first = await startRun(server);
    const second = await startRun(server);

    const response = await server.inject({
      method: "GET",
      url: "/v1/runs",
      headers: AUTH,
    });

    expect(response.statusCode).toBe(200);
    // Each run carries its own policy, so each gets its own stack. Distinct
    // ids are what stop the second silently displacing the first.
    expect(first.runId).not.toBe(second.runId);
    expect(
      response.json().runs.map((run: { runId: string }) => run.runId),
    ).toEqual([second.runId, first.runId]);
  });

  test("the run list refuses an unauthenticated caller", async () => {
    const response = await app().inject({ method: "GET", url: "/v1/runs" });

    expect(response.statusCode).toBe(401);
  });

  test("the inbox gathers gates from every run at once", async () => {
    const server = app();
    const first = await startRun(server);
    const second = await startRun(server);

    const inbox = (
      await server.inject({
        method: "GET",
        url: "/v1/approvals",
        headers: AUTH,
      })
    ).json();

    expect(
      inbox.pending.map((gate: { runId: string }) => gate.runId).sort(),
    ).toEqual([first.runId, second.runId].sort());
    expect(inbox.pending[0].effectHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a gate that names another approver is not in this operator's inbox", async () => {
    const server = appWithRoles(["marketing-lead"]);
    const mine = await startRun(server);
    await startRun(server, gatedFor("finance-lead"));

    const inbox = (
      await server.inject({
        method: "GET",
        url: "/v1/approvals",
        headers: AUTH,
      })
    ).json();

    expect(inbox.pending.map((gate: { runId: string }) => gate.runId)).toEqual([
      mine.runId,
    ]);
  });

  test("a role the caller holds puts the gate in their inbox", async () => {
    // `approvers` names roles, not people. Matching on identity alone found
    // nothing, so every gate naming a role sat in no inbox at all.
    const server = appWithRoles(["finance-lead"]);
    const theirs = await startRun(server, gatedFor("finance-lead"));

    const inbox = (
      await server.inject({
        method: "GET",
        url: "/v1/approvals",
        headers: AUTH,
      })
    ).json();

    expect(inbox.pending.map((gate: { runId: string }) => gate.runId)).toEqual([
      theirs.runId,
    ]);
  });

  test("with no directory to ask, one admin token sees every gate", async () => {
    // The deployment stance behind `ALL_ROLES`: hiding a gate from the only
    // operator there is would stall the run behind a decision nobody can see.
    const server = app();
    const mine = await startRun(server);
    const theirs = await startRun(server, gatedFor("finance-lead"));

    const inbox = (
      await server.inject({
        method: "GET",
        url: "/v1/approvals",
        headers: AUTH,
      })
    ).json();

    expect(
      inbox.pending.map((gate: { runId: string }) => gate.runId).sort(),
    ).toEqual([mine.runId, theirs.runId].sort());
  });

  test("the inbox refuses an unauthenticated caller rather than showing everything", async () => {
    const response = await app().inject({
      method: "GET",
      url: "/v1/approvals",
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("a decided gate stays visible to the run inspector", () => {
  test("approving empties the pending list but not the history", async () => {
    const server = app();
    const started = await startRun(server);
    await server.inject({
      method: "POST",
      url: `/v1/runs/${started.runId}/approvals/${started.pendingApprovalId}/decision`,
      headers: AUTH,
      payload: { decision: "reject", reason: "off brand" },
    });

    const body = (
      await server.inject({
        method: "GET",
        url: `/v1/runs/${started.runId}/approvals`,
        headers: AUTH,
      })
    ).json();

    expect(body.pending).toEqual([]);
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]).toMatchObject({
      status: "REJECTED",
      reason: "off brand",
      decidedBy: "marketing-lead",
    });
  });

  test("an edit leaves both the superseded gate and its successor on the run", async () => {
    const server = app();
    const started = await startRun(server);
    await server.inject({
      method: "POST",
      url: `/v1/runs/${started.runId}/approvals/${started.pendingApprovalId}/decision`,
      headers: AUTH,
      payload: { decision: "edit", patch: { copy: "reworded" } },
    });

    const body = (
      await server.inject({
        method: "GET",
        url: `/v1/runs/${started.runId}/approvals`,
        headers: AUTH,
      })
    ).json();

    expect(
      body.approvals.map((gate: { status: string }) => gate.status),
    ).toEqual(["EDITED", "PENDING"]);
  });
});

describe("the run event stream is the telemetry, not a second story", () => {
  test("the run's own decisions appear in the order they happened", async () => {
    const server = app();
    const started = await startRun(server);

    const events = (
      await server.inject({
        method: "GET",
        url: `/v1/runs/${started.runId}/events`,
        headers: AUTH,
      })
    ).json().events;

    const names = events.map((event: { name: string }) => event.name);
    expect(names).toContain("forge.policy.decide");
    expect(names).toContain("forge.approval.requested");
    expect(names).toContain("forge.run.transition");
    expect(events.map((event: { seq: number }) => event.seq)).toEqual(
      [...events.map((event: { seq: number }) => event.seq)].sort(
        (a, b) => a - b,
      ),
    );
  });

  test("every event is classified so a timeline can group it", async () => {
    const server = app();
    const started = await startRun(server);

    const events = (
      await server.inject({
        method: "GET",
        url: `/v1/runs/${started.runId}/events`,
        headers: AUTH,
      })
    ).json().events;

    expect(
      new Set(events.map((event: { kind: string }) => event.kind)),
    ).toEqual(new Set(["run", "node", "policy", "approval"]));
  });

  test("one run's events never include another's", async () => {
    const server = app();
    const first = await startRun(server);
    const second = await startRun(server);

    const events = (
      await server.inject({
        method: "GET",
        url: `/v1/runs/${second.runId}/events`,
        headers: AUTH,
      })
    ).json().events;

    expect(
      events.every(
        (event: { attributes: { runId?: string } }) =>
          event.attributes.runId === second.runId,
      ),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain(first.runId);
  });

  test("the stream carries no prompt content and names no human", async () => {
    const server = app();
    const started = await startRun(server);
    await server.inject({
      method: "POST",
      url: `/v1/runs/${started.runId}/approvals/${started.pendingApprovalId}/decision`,
      headers: AUTH,
      payload: { decision: "approve" },
    });

    const events = (
      await server.inject({
        method: "GET",
        url: `/v1/runs/${started.runId}/events`,
        headers: AUTH,
      })
    ).json().events;

    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain("marketing-lead");
    expect(serialised).toContain("forge.approval.decided");
    expect(serialised).toContain("forge.effect.dispatched");
  });

  test("events for an unknown run are a 404, not an empty stream", async () => {
    const response = await app().inject({
      method: "GET",
      url: "/v1/runs/run_nope/events",
      headers: AUTH,
    });

    expect(response.statusCode).toBe(404);
  });

  test("the event stream refuses an unauthenticated caller", async () => {
    const response = await app().inject({
      method: "GET",
      url: "/v1/runs/run_1/events",
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("an event family this build does not know is served, not dropped", () => {
  test("an unrecognised forge event is classified rather than discarded", async () => {
    // Registered directly so the test can reach the stack the routes read
    // from. A control plane that silently withheld telemetry it could not
    // classify would leave an operator reading an incomplete run.
    const stack = createLocalStack();
    const server = Fastify({ logger: false });
    registerRunRoutes(server, {
      principalFor: (authorization) =>
        authorization === `Bearer ${BEARER}` ? "marketing-lead" : undefined,
      stack,
    });

    const started = await startRun(server, { workflow: fixture.workflow });
    stack.observability.event("forge.worker.job", {
      runId: started.runId,
      jobId: "job_1",
    });

    const events = (
      await server.inject({
        method: "GET",
        url: `/v1/runs/${started.runId}/events`,
        headers: AUTH,
      })
    ).json().events;

    expect(
      events.find(
        (event: { name: string }) => event.name === "forge.worker.job",
      ),
    ).toMatchObject({ kind: "other", attributes: { jobId: "job_1" } });
  });
});

/**
 * The run data plane, from the boundary. The payload the caller sends is the
 * value the workflow's input nodes produce — and an omitted one is still
 * omitted, not an empty object a node could quietly read.
 */
describe("a run carries the payload it was started with", () => {
  const dataWorkflow = {
    id: "acme.api-data",
    version: "1.0.0",
    sideEffects: ["slack.post"],
    nodes: [
      { id: "intake", kind: "input", schemaRef: "s@1" },
      { id: "gate", kind: "approval", gateSchemaRef: "g@1", gates: ["send"] },
      {
        id: "send",
        kind: "tool",
        skillRef: "t@1",
        effect: "slack.post",
        reads: { node: "intake", path: ["body"] },
      },
      { id: "done", kind: "output", schemaRef: "s@1" },
    ],
    edges: [
      { from: "intake", to: "gate" },
      { from: "gate", to: "send" },
      { from: "send", to: "done" },
    ],
  };

  const openPolicy = {
    rules: [
      {
        id: "acme.api-data.open",
        action: "slack.post",
        environment: "production",
        decision: "allow",
        reason: "Test rule.",
      },
    ],
    grants: [],
  };

  test("a payload flows to the effect and the run succeeds", async () => {
    const run = await startRun(app(), {
      workflow: dataWorkflow,
      policy: openPolicy,
      payload: { body: "the copy" },
    });

    expect(run.status).toBe("SUCCEEDED");
    expect(run.performedEffects).toEqual(["send"]);
  });

  test("an omitted payload is not an empty one; the read fails closed", async () => {
    const run = await startRun(app(), {
      workflow: dataWorkflow,
      policy: openPolicy,
    });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("no value");
    expect(run.performedEffects).toEqual([]);
  });
});

describe("every control-plane route is authenticated", () => {
  test("compile refuses an unauthenticated caller", async () => {
    // It reads no run state, so it looked harmless and was left open. It is
    // still unmetered work on a control plane, and a company acceptance suite
    // found it by revoking its token and watching compile keep working.
    const response = await app().inject({
      method: "POST",
      url: "/v1/workflows/compile",
      payload: { workflow: fixture.workflow },
    });

    expect(response.statusCode).toBe(401);
  });

  test("no route answers without a bearer token", async () => {
    const server = app();
    const routes: readonly ["POST" | "GET", string][] = [
      ["POST", "/v1/workflows/compile"],
      ["POST", "/v1/runs"],
      ["GET", "/v1/runs"],
      ["GET", "/v1/approvals"],
      ["GET", "/v1/runs/run_1"],
      ["GET", "/v1/runs/run_1/approvals"],
      ["GET", "/v1/runs/run_1/events"],
      ["POST", "/v1/runs/run_1/approvals/approval_1/decision"],
    ];

    for (const [method, url] of routes) {
      const response = await server.inject({ method, url, payload: {} });
      expect(`${method} ${url} -> ${response.statusCode}`).toBe(
        `${method} ${url} -> 401`,
      );
    }
  });
});
