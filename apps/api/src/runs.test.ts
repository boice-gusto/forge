import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createLocalStack,
  type LocalStack,
  type LocalStackOptions,
} from "@forge/composition";
import { ANY_ROLE } from "@forge/ports";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";

import { createRequestAuthenticator } from "./auth.js";
import { loadDeploymentPolicy } from "./company.js";
import { createSessionStore } from "./identity.js";
import { createDevelopmentIdentity } from "./identity-development.js";
import { createApiApp } from "./main.js";
import { registerRunRoutes } from "./runs.js";

const BEARER = "local-test";
const AUTH = { authorization: `Bearer ${BEARER}` };

/**
 * The workflow, the panel and the votes come from the fixture; the **policy
 * does not**. It is loaded from `examples/acme`'s policy packs, exactly as a
 * deployment loads the company package it serves, because the request body no
 * longer carries one — `POST /v1/runs` used to build a stack per request from
 * `body.policy`, which let the caller choose the rules governing their own run
 * and, with Postgres behind it, would have opened a pool per request.
 */
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
  panel: NonNullable<LocalStackOptions["panel"]>;
  review: { votes: ReturnType<NonNullable<LocalStackOptions["votesFor"]>> };
  branch: Record<string, string>;
  changedPaths: string[];
};

const ACME = fileURLToPath(new URL("../../../examples/acme", import.meta.url));
/** The ceiling this deployment grants. Never read from the manifest. */
const HOST_CAPABILITIES = ["repo.read", "docs.write", "slack.write"];

const acme = await loadDeploymentPolicy({
  root: ACME,
  hostCapabilities: HOST_CAPABILITIES,
  forgeVersion: "0.1.0",
});

/**
 * The stack a deployment serving Acme would build: the company's own rules,
 * its granted capabilities, and the host bindings that stand in for a review
 * adapter. Votes and branch arms are the deployment's, not the caller's — a
 * request that could name its own verdict would be steering the decision it is
 * asking a human to make.
 */
function acmeStack(
  overrides: LocalStackOptions & {
    readonly approvers?: readonly string[];
  } = {},
): LocalStack {
  const { approvers, ...rest } = overrides;
  return createLocalStack({
    rules:
      approvers === undefined
        ? acme.rules
        : acme.rules.map((rule) => ({ ...rule, approvers })),
    grants: acme.grants,
    environment: "production",
    panel: fixture.panel,
    votesFor: () => fixture.review.votes,
    branchFor: (nodeId: string) => fixture.branch[nodeId],
    ...rest,
  });
}

/**
 * An API whose directory says exactly this. Roles are never inferred: an
 * operator holds what the identity provider resolved and nothing more, which
 * is the whole difference from one shared token standing for every role.
 */
function appWithRoles(
  roles: readonly string[],
  stack: LocalStack = acmeStack(),
) {
  return createApiApp({
    build: { version: "0.1.0", gitSha: "test", buildTime: "2026-01-01" },
    dependencies: { queue: "healthy", persistence: "healthy" },
    identity: createDevelopmentIdentity([
      { subject: "marketing-lead", secret: BEARER, roles },
    ]),
    stack,
  });
}

/**
 * The single-operator deployment: one credential, every role, stated rather
 * than assumed. Most of the suite below is about run mechanics rather than
 * authority, so it uses this and says why the caller can decide anything.
 */
function app(stack?: LocalStack) {
  return appWithRoles([ANY_ROLE], stack);
}

/** Everything the caller still supplies: a workflow and what it needs. */
const startBody = {
  workflow: fixture.workflow,
  capabilities: fixture.capabilities,
  changedPaths: fixture.changedPaths,
};

/**
 * The same workflow, publishing a different effect under a different id.
 *
 * With one stack per deployment, two runs on one host are governed by one rule
 * set — so showing that two roles cannot decide each other's gates now means
 * two *actions* with different approvers, which is what a company policy pack
 * looks like anyway (009 §11).
 */
function workflowFor(id: string, effect: string): unknown {
  const source = JSON.parse(JSON.stringify(fixture.workflow)) as {
    id: string;
    sideEffects: string[];
    nodes: { effect?: string }[];
  };
  source.id = id;
  source.sideEffects = [effect];
  for (const node of source.nodes) {
    if (node.effect !== undefined) node.effect = effect;
  }
  return source;
}

const WORKFLOW_A = workflowFor("acme.marketing.a", "slack.post");
const WORKFLOW_B = workflowFor("acme.marketing.b", "jira.comment");
const WORKFLOW_UNOWNED = workflowFor("acme.marketing.open", "docs.publish");

/** A pack naming a different approver per action, and one naming nobody. */
const SEPARATION_RULES: NonNullable<LocalStackOptions["rules"]> = [
  {
    id: "acme.a",
    action: "slack.post",
    environment: "production",
    decision: "require-approval",
    reason: "Publishing externally is a human call.",
    approvers: ["role-a"],
  },
  {
    id: "acme.b",
    action: "jira.comment",
    environment: "production",
    decision: "require-approval",
    reason: "Commenting on a ticket is a human call.",
    approvers: ["role-b"],
  },
  {
    id: "acme.open",
    action: "docs.publish",
    environment: "production",
    decision: "require-approval",
    reason: "Anyone on call may decide this.",
    approvers: [],
  },
];

const bodyFor = (workflow: unknown) => ({ ...startBody, workflow });

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
    // A deployment that binds no branch source has nothing to choose with.
    // Failing closed is the only safe answer: running every arm would make a
    // branch a fan-out, and picking one would invent a decision nobody made.
    const stack = createLocalStack({
      rules: acme.rules,
      grants: acme.grants,
      environment: "production",
      panel: fixture.panel,
      votesFor: () => fixture.review.votes,
    });

    const response = await app(stack).inject({
      method: "POST",
      url: "/v1/runs",
      headers: AUTH,
      payload: startBody,
    });

    expect(response.statusCode).toBe(201);
    const run = response.json();
    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("No arm was chosen");
    expect(run.performedEffects).toEqual([]);
  });

  test("a run cannot bring its own policy: a body field is not a rule set", async () => {
    // The mistake this boundary now prevents, stated as a test. The stack's
    // rule set requires a human for `slack.post`; a body claiming the action
    // is allowed must change nothing at all.
    const run = await startRun(app(), {
      ...startBody,
      policy: {
        grants: ["docs.write", "slack.write"],
        rules: [
          {
            id: "attacker.allow-everything",
            action: "slack.post",
            environment: "production",
            decision: "allow",
            reason: "Supplied by the caller.",
          },
        ],
      },
    });

    expect(run.status).toBe("AWAITING_APPROVAL");
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

  test("a started run is retrievable from the one stack this deployment serves", async () => {
    const server = app();
    const started = await startRun(server);

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
    expect(first.runId).not.toBe(second.runId);
    expect(
      response.json().runs.map((run: { runId: string }) => run.runId),
    ).toEqual([second.runId, first.runId]);
  });

  test("the list is the store's, not a map of runs this process started", async () => {
    // A run written straight to the store, which the API never saw start. It
    // has to appear, because after a restart *every* run is one of these.
    const stack = acmeStack();
    const server = app(stack);
    const mine = await startRun(server);
    await stack.runs.create({
      record: {
        runId: "run_from_another_process",
        workflowId: "acme.marketing.campaign-brief",
        fingerprint: "sha256:elsewhere",
        status: "AWAITING_APPROVAL",
        attempt: 1,
        performedEffects: [],
      },
      artifact: {
        workflowId: "acme.marketing.campaign-brief",
        fingerprint: "sha256:elsewhere",
        ir: {},
      },
      capabilities: [],
      changedPaths: [],
    });

    const runs = (
      await server.inject({ method: "GET", url: "/v1/runs", headers: AUTH })
    ).json().runs;

    expect(runs.map((run: { runId: string }) => run.runId)).toEqual([
      "run_from_another_process",
      mine.runId,
    ]);
  });

  test("a status filter narrows the list, and an unknown status is refused", async () => {
    const server = app();
    const parked = await startRun(server);

    const awaiting = (
      await server.inject({
        method: "GET",
        url: "/v1/runs?status=AWAITING_APPROVAL",
        headers: AUTH,
      })
    ).json();
    expect(awaiting.runs.map((run: { runId: string }) => run.runId)).toEqual([
      parked.runId,
    ]);

    const none = (
      await server.inject({
        method: "GET",
        url: "/v1/runs?status=SUCCEEDED",
        headers: AUTH,
      })
    ).json();
    expect(none.runs).toEqual([]);

    // Refused, not ignored: a misspelt status that listed everything would
    // show an operator exactly the runs they asked to exclude.
    const bad = await server.inject({
      method: "GET",
      url: "/v1/runs?status=awaiting",
      headers: AUTH,
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe("RUN_STATUS_UNKNOWN");
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
    const server = appWithRoles(
      ["role-a"],
      acmeStack({ rules: SEPARATION_RULES }),
    );
    const mine = await startRun(server, bodyFor(WORKFLOW_A));
    await startRun(server, bodyFor(WORKFLOW_B));

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
    const server = appWithRoles(
      ["role-b"],
      acmeStack({ rules: SEPARATION_RULES }),
    );
    await startRun(server, bodyFor(WORKFLOW_A));
    const theirs = await startRun(server, bodyFor(WORKFLOW_B));

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

  test("an operator explicitly granted every role sees every gate", async () => {
    // The single-operator deployment, now something a directory says rather
    // than something the API assumes: hiding a gate from the only operator
    // there is would stall the run behind a decision nobody can see.
    const server = appWithRoles(
      [ANY_ROLE],
      acmeStack({ rules: SEPARATION_RULES }),
    );
    const mine = await startRun(server, bodyFor(WORKFLOW_A));
    const theirs = await startRun(server, bodyFor(WORKFLOW_B));

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
      authenticate: createRequestAuthenticator({
        identity: createDevelopmentIdentity([
          { subject: "marketing-lead", secret: BEARER, roles: [ANY_ROLE] },
        ]),
        sessions: createSessionStore(),
      }),
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

  /** A deployment whose pack allows the action outright, so no gate opens. */
  const openStack = () =>
    acmeStack({
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
    });

  test("a payload flows to the effect and the run succeeds", async () => {
    const run = await startRun(app(openStack()), {
      workflow: dataWorkflow,
      payload: { body: "the copy" },
    });

    expect(run.status).toBe("SUCCEEDED");
    expect(run.performedEffects).toEqual(["send"]);
  });

  test("an omitted payload is not an empty one; the read fails closed", async () => {
    const run = await startRun(app(openStack()), {
      workflow: dataWorkflow,
    });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("no value");
    expect(run.performedEffects).toEqual([]);
  });
});

/**
 * The acceptance this unblocks: two operators, two roles, and neither able to
 * decide the other's gate. Until now every caller held `ANY_ROLE`, so "who
 * decided this" was "whoever had the token".
 */
describe("a role decides its own gates and no one else's", () => {
  const DIRECTORY = [
    { subject: "sam@example.test", secret: "sam-cred", roles: ["role-a"] },
    { subject: "ash@example.test", secret: "ash-cred", roles: ["role-b"] },
  ];

  /** One deployment, one pack, a different approver per action. */
  function shared() {
    return createApiApp({
      build: { version: "0.1.0", gitSha: "test", buildTime: "2026-01-01" },
      dependencies: { queue: "healthy", persistence: "healthy" },
      identity: createDevelopmentIdentity(DIRECTORY),
      stack: acmeStack({ rules: SEPARATION_RULES }),
    });
  }

  const as = (secret: string) => ({ authorization: `Bearer ${secret}` });

  const WORKFLOW_OF: Readonly<Record<string, unknown>> = {
    "role-a": WORKFLOW_A,
    "role-b": WORKFLOW_B,
    nobody: WORKFLOW_UNOWNED,
  };

  async function gatedRun(
    server: ReturnType<typeof shared>,
    approver: keyof typeof WORKFLOW_OF,
    credential: string,
  ) {
    return (
      await server.inject({
        method: "POST",
        url: "/v1/runs",
        headers: as(credential),
        payload: bodyFor(WORKFLOW_OF[approver]),
      })
    ).json();
  }

  test("the holder of the other role is refused, and nothing dispatches", async () => {
    const server = shared();
    const run = await gatedRun(server, "role-a", "sam-cred");

    const refused = await server.inject({
      method: "POST",
      url: `/v1/runs/${run.runId}/approvals/${run.pendingApprovalId}/decision`,
      headers: as("ash-cred"),
      payload: { decision: "approve" },
    });

    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("DECISION_FORBIDDEN");

    const after = (
      await server.inject({
        method: "GET",
        url: `/v1/runs/${run.runId}`,
        headers: as("sam-cred"),
      })
    ).json();
    expect(after.status).toBe("AWAITING_APPROVAL");
    expect(after.performedEffects).toEqual([]);
  });

  test("the role the gate names decides it, and the record says who", async () => {
    const server = shared();
    const run = await gatedRun(server, "role-a", "sam-cred");

    const decided = await server.inject({
      method: "POST",
      url: `/v1/runs/${run.runId}/approvals/${run.pendingApprovalId}/decision`,
      headers: as("sam-cred"),
      payload: { decision: "approve" },
    });

    expect(decided.statusCode).toBe(200);
    expect(decided.json().performedEffects).toEqual(["publish"]);

    const history = (
      await server.inject({
        method: "GET",
        url: `/v1/runs/${run.runId}/approvals`,
        headers: as("sam-cred"),
      })
    ).json();
    // The durable audit trail names the human; the span never does.
    expect(history.approvals[0].decidedBy).toBe("sam@example.test");
  });

  test("each inbox holds only its own role's gates", async () => {
    const server = shared();
    const mine = await gatedRun(server, "role-a", "sam-cred");
    const theirs = await gatedRun(server, "role-b", "sam-cred");

    const inboxOf = async (credential: string) =>
      (
        await server.inject({
          method: "GET",
          url: "/v1/approvals",
          headers: as(credential),
        })
      )
        .json()
        .pending.map((gate: { runId: string }) => gate.runId);

    expect(await inboxOf("sam-cred")).toEqual([mine.runId]);
    expect(await inboxOf("ash-cred")).toEqual([theirs.runId]);
  });

  /**
   * The inbox and the decision route apply the same rule from two places — the
   * approval store filters the list, `mayDecide` guards the decision. If they
   * ever disagree, an operator either sees a gate they cannot decide or can
   * decide one they never saw. This is the assertion that would catch it.
   */
  test("what an inbox shows is exactly what its holder may decide", async () => {
    const server = shared();
    const mine = await gatedRun(server, "role-a", "sam-cred");
    const theirs = await gatedRun(server, "role-b", "sam-cred");
    const unowned = await gatedRun(server, "nobody", "sam-cred");

    const inbox = (
      await server.inject({
        method: "GET",
        url: "/v1/approvals",
        headers: as("sam-cred"),
      })
    ).json().pending;

    const visible = new Set(inbox.map((gate: { runId: string }) => gate.runId));
    expect(visible).toEqual(new Set([mine.runId, unowned.runId]));

    for (const run of [mine, theirs, unowned]) {
      const response = await server.inject({
        method: "POST",
        url: `/v1/runs/${run.runId}/approvals/${run.pendingApprovalId}/decision`,
        headers: as("sam-cred"),
        payload: { decision: "approve" },
      });
      expect(`${run.runId} ${response.statusCode !== 403}`).toBe(
        `${run.runId} ${visible.has(run.runId)}`,
      );
    }
  });

  test("a body cannot name the principal that decides", async () => {
    // The one mistake this boundary exists to prevent. `principal` and
    // `roles` in a payload are ignored entirely — the credential decides.
    const server = shared();
    const run = await gatedRun(server, "role-a", "sam-cred");

    const refused = await server.inject({
      method: "POST",
      url: `/v1/runs/${run.runId}/approvals/${run.pendingApprovalId}/decision`,
      headers: as("ash-cred"),
      payload: {
        decision: "approve",
        principal: "sam@example.test",
        roles: ["role-a"],
      },
    });

    expect(refused.statusCode).toBe(403);
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
    const routes: readonly ["POST" | "GET" | "DELETE", string][] = [
      ["POST", "/v1/workflows/compile"],
      ["POST", "/v1/runs"],
      ["GET", "/v1/runs"],
      ["GET", "/v1/approvals"],
      ["GET", "/v1/runs/run_1"],
      ["GET", "/v1/runs/run_1/approvals"],
      ["GET", "/v1/runs/run_1/events"],
      ["POST", "/v1/runs/run_1/approvals/approval_1/decision"],
      // Sign-in is the one route that may be reached without a session,
      // because it is the route that establishes one. Reading or ending a
      // session still needs one.
      ["GET", "/v1/auth/session"],
      ["DELETE", "/v1/auth/session"],
      ["GET", "/health"],
    ];

    for (const [method, url] of routes) {
      const response = await server.inject({ method, url, payload: {} });
      expect(`${method} ${url} -> ${response.statusCode}`).toBe(
        `${method} ${url} -> 401`,
      );
    }
  });

  test("a credential the directory does not know is refused everywhere", async () => {
    const server = app();
    const headers = { authorization: "Bearer not-a-real-credential" };

    for (const [method, url] of [
      ["POST", "/v1/workflows/compile"],
      ["GET", "/v1/approvals"],
      ["GET", "/health"],
    ] as const) {
      const response = await server.inject({
        method,
        url,
        headers,
        payload: {},
      });
      expect(`${method} ${url} -> ${response.statusCode}`).toBe(
        `${method} ${url} -> 401`,
      );
    }

    // And it cannot be traded for a session either.
    const login = await server.inject({
      method: "POST",
      url: "/v1/auth/session",
      payload: {
        credential: { kind: "operator-secret", value: "not-a-real-credential" },
      },
    });
    expect(login.statusCode).toBe(401);
    expect(login.headers["set-cookie"]).toBeUndefined();
  });
});
