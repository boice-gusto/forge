import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadDeploymentPolicy } from "@forge/company";
import {
  createLocalStack,
  type LocalStack,
  type LocalStackOptions,
} from "@forge/composition";
import { ANY_ROLE } from "@forge/ports";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { createRequestAuthenticator } from "./auth.js";
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

type Server = ReturnType<typeof app> | ReturnType<typeof Fastify>;

/** `POST /v1/runs` and nothing more: the accepted record, still PENDING. */
async function accept(server: Server, payload: object = startBody) {
  return server.inject({
    method: "POST",
    url: "/v1/runs",
    headers: AUTH,
    payload,
  });
}

/**
 * The statuses at which the queue owes the run nothing more.
 *
 * Not "terminal". A helper that waited for a finished run would make every
 * assertion about a *gate* below unfalsifiable — it would drive the run past
 * the gate and then assert the gate was there.
 */
const SETTLED = new Set([
  "AWAITING_APPROVAL",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);

/**
 * Reads the run until the consumer has taken it as far as it goes.
 *
 * Over HTTP, deliberately, rather than through the stack this suite happens to
 * hold: it is the loop a client writes, so if the route stopped reporting a
 * run's progress this would hang rather than quietly pass.
 */
async function settle(server: Server, runId: string) {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const run = (
      await server.inject({
        method: "GET",
        url: `/v1/runs/${runId}`,
        headers: AUTH,
      })
    ).json();
    if (SETTLED.has(run.status as string)) return run;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Run ${runId} never settled.`);
}

/** Enough turns of the loop for a deferred delivery to have started. */
const settleTicks = async () => {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

/** Start a run and wait for it to stop moving. What most tests want. */
async function startRun(server: Server, payload: object = startBody) {
  const response = await accept(server, payload);
  if (response.statusCode !== 202) return response.json();
  return settle(server, response.json().runId as string);
}

/** `POST …/decision` and nothing more: the accepted record, not the outcome. */
async function submit(
  server: Server,
  run: { runId: string; pendingApprovalId?: string },
  payload: object,
  headers: Record<string, string> = AUTH,
) {
  return server.inject({
    method: "POST",
    url: `/v1/runs/${run.runId}/approvals/${run.pendingApprovalId}/decision`,
    headers,
    payload,
  });
}

/**
 * Decide a gate and wait for the run to stop moving again.
 *
 * The decision route enqueues rather than walking (006 §10.3), so the reply is
 * a run that has not advanced — still `AWAITING_APPROVAL`, still naming the
 * gate just decided. `settle` alone would therefore return **immediately**,
 * having observed the run exactly where it already was, and every assertion
 * after it would be about a run nothing had happened to. So the condition is
 * that the run has stopped *and* no longer names the gate this decision
 * settled, which is true of all four outcomes: an approve finishes or reaches
 * the next gate, a reject or a timeout fails, an edit names its successor.
 */
async function settlePast(
  server: Server,
  runId: string,
  decided: string | undefined,
  headers: Record<string, string> = AUTH,
) {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const current = (
      await server.inject({ method: "GET", url: `/v1/runs/${runId}`, headers })
    ).json();
    if (
      SETTLED.has(current.status as string) &&
      current.pendingApprovalId !== decided
    ) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Run ${runId} never moved past ${decided}.`);
}

async function decideRun(
  server: Server,
  run: { runId: string; pendingApprovalId?: string },
  payload: object,
  headers: Record<string, string> = AUTH,
) {
  const response = await submit(server, run, payload, headers);
  if (response.statusCode !== 202) return response.json();
  return settlePast(server, run.runId, run.pendingApprovalId, headers);
}

/**
 * The routes with **no consumer bound**, so a run stops exactly where the
 * control plane leaves it. `createApiApp` binds one; this does not, which is
 * the only way to observe what the request itself did rather than what the
 * request plus a turn of the event loop did.
 */
function bare(stack: LocalStack) {
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
  return server;
}

describe("the control plane persists and enqueues; it does not walk", () => {
  test("the reply is 202 with a PENDING run and where to find it", async () => {
    const stack = acmeStack();
    const response = await accept(bare(stack));

    // 202, not 201: a run exists, but the thing that was asked for has not
    // happened. The body says so — a client that read this as the outcome
    // would be reading a run that has not run.
    expect(response.statusCode).toBe(202);
    const run = response.json();
    expect(run.status).toBe("PENDING");
    expect(run.pendingApprovalId).toBeUndefined();
    expect(run.performedEffects).toEqual([]);
    expect(response.headers.location).toBe(`/v1/runs/${run.runId}`);
  });

  test("the run is in the store before the reply, and readable at once", async () => {
    const stack = acmeStack();
    const server = bare(stack);
    const accepted = (await accept(server)).json();

    // Enqueueing without persisting would leave the consumer a run id it
    // cannot find, and this is where that shows: a 404 from the route the
    // `Location` header just pointed at.
    const fetched = await server.inject({
      method: "GET",
      url: `/v1/runs/${accepted.runId}`,
      headers: AUTH,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().status).toBe("PENDING");
    expect((await stack.runs.load(accepted.runId))?.record.status).toBe(
      "PENDING",
    );
  });

  test("the work is on the queue, naming the run and the sealed version", async () => {
    const stack = acmeStack();
    const accepted = (await accept(bare(stack))).json();

    // Persisting without enqueueing is the other half, and it is silent: the
    // run would sit at PENDING forever with nothing to blame.
    expect(await stack.queue.depth()).toBe(1);

    const seen: { type: string; runId: string; workflowVersionId?: string }[] =
      [];
    await stack.queue.subscribe(async (job) => {
      seen.push(job as (typeof seen)[number]);
    });
    await stack.drain();

    expect(seen).toEqual([
      {
        type: "workflow.execute",
        runId: accepted.runId,
        workflowVersionId: accepted.fingerprint,
        attempt: 1,
      },
    ]);
  });

  test("nothing is walked on the request: no policy, no gate, no effect", async () => {
    const stack = acmeStack();
    const accepted = (await accept(bare(stack))).json();

    // The whole point. This workflow reaches a gate; if the route were still
    // calling `Runtime.start`, all three of these would already be true by
    // the time the response was written.
    expect(stack.dispatched).toEqual([]);
    expect(await stack.approvals.getPending(accepted.runId)).toEqual([]);
    expect(
      stack.observability.timeline.map((entry) => entry.name),
    ).not.toContain("forge.policy.decide");
  });

  test("the request returns while the walk is still blocked inside the agent", async () => {
    /**
     * The failure this whole change is about, made observable.
     *
     * The provider below never answers until it is released, and the workflow
     * reaches it before its gate. A route that walked the run would still be
     * inside `createSession` when this `await` was made, and the test would
     * hang rather than fail an assertion — which is the honest shape, because
     * "the request is held open across a model call" is a hang, and with a
     * real provider bound it is a hang of minutes.
     */
    let release: (() => void) | undefined;
    const answered = new Promise<void>((settle) => {
      release = settle;
    });
    let asked = false;

    const stack = acmeStack({
      provider: {
        providerId: "latched",
        capabilities: ["streaming"],
        async createSession() {
          asked = true;
          await answered;
          return { sessionId: "session_1", providerId: "latched" };
        },
        async resumeSession(input) {
          return { sessionId: input.sessionId, providerId: "latched" };
        },
        async *execute() {
          yield { type: "completed" } as const;
        },
        async cancel() {},
        async destroySession() {},
        async health() {
          return { available: true, providerId: "latched" };
        },
      },
    });
    const server = app(stack);

    const response = await accept(server);
    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe("PENDING");

    // Let the consumer get as far as the model, then confirm it is stuck
    // there while the request has long since been answered.
    await settleTicks();
    expect(asked).toBe(true);
    expect((await stack.runs.load(response.json().runId))?.record.status).toBe(
      "RUNNING",
    );

    release?.();
    await stack.drain();
    expect((await stack.runs.load(response.json().runId))?.record.status).toBe(
      "AWAITING_APPROVAL",
    );
  });

  test("a consumer, and only a consumer, takes the run to its gate", async () => {
    // Same stack, same route, one difference: something is reading the queue.
    // The route's reply is identical either way, which is what makes it a
    // contract rather than a description of this deployment.
    const stack = acmeStack();
    const server = app(stack);
    const accepted = (await accept(server)).json();
    expect(accepted.status).toBe("PENDING");

    const settled = await settle(server, accepted.runId);
    expect(settled.status).toBe("AWAITING_APPROVAL");
    expect(settled.pendingApprovalId).toBeDefined();
    expect(settled.performedEffects).toEqual([]);
  });

  test("starting a run still requires an authenticated caller", async () => {
    // The 401 sweep reaches the new shape too: nothing is created and nothing
    // is enqueued for a caller the deployment cannot name.
    const stack = acmeStack();
    const response = await bare(stack).inject({
      method: "POST",
      url: "/v1/runs",
      payload: startBody,
    });

    expect(response.statusCode).toBe(401);
    expect(await stack.queue.depth()).toBe(0);
    expect(await stack.runs.list()).toEqual([]);
  });
});

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

    const run = await startRun(app(stack));

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
    const server = app();
    const run = await startRun(server);

    expect(run.status).toBe("AWAITING_APPROVAL");
    expect(run.performedEffects).toEqual([]);
    expect(run.pendingApprovalId).toBeDefined();
  });

  test("the full lifecycle: start, list the gate, approve, effect dispatched once", async () => {
    const server = app();
    const started = await startRun(server);

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

    const run = await decideRun(server, started, { decision: "approve" });

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
    const started = await startRun(server);

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
    const started = await startRun(server);

    const response = await server.inject({
      method: "POST",
      url: `/v1/runs/${started.runId}/approvals/${started.pendingApprovalId}/decision`,
      payload: { decision: "approve" },
    });

    expect(response.statusCode).toBe(401);
  });

  test("an unrecognised decision kind is refused rather than defaulted", async () => {
    const server = app();
    const started = await startRun(server);

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
    const started = await startRun(server);

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
    const started = await startRun(server);

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
    const started = await startRun(server);

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
    const started = await startRun(server);

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
    const response = await accept(app(), { workflow: { nope: true } });

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("WORKFLOW_COMPILE_FAILED");
  });

  test("listing a run's gates requires a caller, now that it names deciders", async () => {
    const server = app();
    const started = await startRun(server);

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

    const kinds = new Set(events.map((event: { kind: string }) => event.kind));
    for (const kind of ["run", "node", "policy", "approval"]) {
      expect([...kinds]).toContain(kind);
    }
    // A subset rather than an equality, because the consumer that walks the
    // run reports on the *job* too — `forge.worker.*`, which is not in the 011
    // taxonomy and falls to `other` by design. Nothing is left unclassified.
    expect(
      [...kinds].filter(
        (kind) =>
          !["run", "node", "policy", "approval", "effect", "other"].includes(
            kind as string,
          ),
      ),
    ).toEqual([]);
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
    await decideRun(server, started, { decision: "approve" });

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

    // No consumer is bound to this stack, so the run stays where the control
    // plane left it — which is all this test needs, and is itself worth
    // seeing: a control plane that only persists and enqueues does not
    // advance a run by itself.
    const started = (
      await accept(server, { workflow: fixture.workflow })
    ).json();
    expect(started.status).toBe("PENDING");
    // Written to the store the route reads, which is the seam that matters:
    // `stack.observability` is the trace sink, and a span there is not a row
    // an operator can query.
    await stack.runEvents.append({
      runId: started.runId,
      kind: "event",
      name: "forge.worker.job",
      at: new Date().toISOString(),
      attributes: { runId: started.runId, jobId: "job_1" },
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
    const accepted = (
      await server.inject({
        method: "POST",
        url: "/v1/runs",
        headers: as(credential),
        payload: bodyFor(WORKFLOW_OF[approver]),
      })
    ).json();

    // The gate opens on the consumer's turn, not on this request's.
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const run = (
        await server.inject({
          method: "GET",
          url: `/v1/runs/${accepted.runId}`,
          headers: as(credential),
        })
      ).json();
      if (SETTLED.has(run.status as string)) return run;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`Run ${accepted.runId} never settled.`);
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

    const decided = await decideRun(
      server,
      run,
      { decision: "approve" },
      as("sam-cred"),
    );

    expect(decided.performedEffects).toEqual(["publish"]);

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
    const routes: readonly [
      "POST" | "GET" | "DELETE",
      string,
      Record<string, string>?,
    ][] = [
      ["POST", "/v1/workflows/compile"],
      ["POST", "/v1/runs"],
      ["GET", "/v1/runs"],
      ["GET", "/v1/approvals"],
      ["GET", "/v1/runs/run_1"],
      ["GET", "/v1/runs/run_1/approvals"],
      ["GET", "/v1/runs/run_1/events"],
      // The stream is the same resource asked for differently, so it is the
      // same route and the same check — but "the same" is a claim, and a
      // representation nobody swept is exactly where an exemption would hide.
      ["GET", "/v1/runs/run_1/events", { accept: "text/event-stream" }],
      ["POST", "/v1/runs/run_1/approvals/approval_1/decision"],
      // Sign-in is the one route that may be reached without a session,
      // because it is the route that establishes one. Reading or ending a
      // session still needs one.
      ["GET", "/v1/auth/session"],
      ["DELETE", "/v1/auth/session"],
      ["GET", "/health"],
    ];

    for (const [method, url, headers] of routes) {
      const response = await server.inject({
        method,
        url,
        payload: {},
        ...(headers === undefined ? {} : { headers }),
      });
      const what = `${method} ${url} ${headers?.accept ?? ""}`.trim();
      expect(`${what} -> ${response.statusCode}`).toBe(`${what} -> 401`);
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

/**
 * The decision route's half of 006 §10.3. It used to walk the graph inside the
 * request — every node after the gate, the sandbox lease, the model call and
 * the dispatch, all inside an operator's click. It now does what `POST /v1/runs`
 * does: records durably, enqueues, replies.
 */
describe("the control plane records the decision and enqueues the resume", () => {
  test("the reply is 202 with the run still at its gate, and where to look", async () => {
    // Bare: nothing consumes the queue, so what is asserted here is what the
    // *request* did, rather than what the request plus a turn of the loop did.
    const stack = acmeStack();
    const server = app(stack);
    const started = await startRun(server);

    const bareServer = bare(stack);
    const response = await submit(bareServer, started, { decision: "approve" });

    expect(response.statusCode).toBe(202);
    const run = response.json();
    expect(run.status).toBe("AWAITING_APPROVAL");
    expect(run.pendingApprovalId).toBe(started.pendingApprovalId);
    expect(run.performedEffects).toEqual([]);
    expect(response.headers.location).toBe(`/v1/runs/${started.runId}`);
    // Nothing was walked on the request. With the old route all three of these
    // would already be true by the time the response was written.
    expect(stack.dispatched).toEqual([]);
  });

  test("the decision is durable before the reply, whoever walks the run", async () => {
    const stack = acmeStack();
    const started = await startRun(app(stack));

    await submit(bare(stack), started, {
      decision: "approve",
    });

    // Enqueueing without recording would hand the consumer a gate that still
    // says PENDING, and `resume` would park the run straight back where it was.
    const approval = await stack.approvals.get(started.pendingApprovalId);
    expect(approval?.status).toBe("APPROVED");
    expect(approval?.decidedBy).toBe("marketing-lead");
  });

  test("the resume is on the queue, naming the run and the gate decided", async () => {
    const stack = acmeStack();
    const server = app(stack);
    const started = await startRun(server);

    // Recording without enqueueing is the silent half: the gate would read
    // APPROVED and the run would sit at AWAITING_APPROVAL forever. Subscribed
    // *before* the decision, which also displaces the consumer that would
    // otherwise walk the run — so what is seen here is the job itself.
    const seen: object[] = [];
    await stack.queue.subscribe(async (job) => {
      seen.push(job);
    });
    await submit(server, started, { decision: "approve" });
    await stack.drain();

    expect(seen).toEqual([
      {
        type: "workflow.resume",
        runId: started.runId,
        approvalId: started.pendingApprovalId,
        attempt: 1,
      },
    ]);
  });

  test("a consumer, and only a consumer, dispatches the approved effect", async () => {
    const stack = acmeStack();
    const server = app(stack);
    const started = await startRun(server);

    const accepted = (
      await submit(server, started, { decision: "approve" })
    ).json();
    expect(accepted.status).toBe("AWAITING_APPROVAL");
    expect(accepted.performedEffects).toEqual([]);

    const finished = await settlePast(
      server,
      started.runId,
      started.pendingApprovalId,
    );
    expect(finished.status).toBe("SUCCEEDED");
    expect(finished.performedEffects).toEqual(["publish"]);
    expect(stack.dispatched).toEqual(["slack.post"]);
  });

  test("the request returns while the walk after the gate is still blocked", async () => {
    /**
     * The same shape as the start route's latch, on the other side of the
     * gate. The effect sink never answers until it is released; a route that
     * walked the run would still be inside `perform` when this `await` was
     * made, and this test would hang rather than fail — which is the honest
     * shape, because "the operator's click is held open across the dispatch"
     * *is* a hang.
     */
    let release: (() => void) | undefined;
    const performed = new Promise<void>((settled) => {
      release = settled;
    });
    let dispatching = false;

    const stack = acmeStack({
      effects: {
        async perform() {
          dispatching = true;
          await performed;
          return undefined;
        },
      },
    });
    const server = app(stack);
    const started = await startRun(server);

    const response = await submit(server, started, { decision: "approve" });
    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe("AWAITING_APPROVAL");

    await settleTicks();
    expect(dispatching).toBe(true);

    release?.();
    await stack.drain();
    expect((await stack.runs.load(started.runId))?.record.status).toBe(
      "SUCCEEDED",
    );
  });

  test("a refused decision records nothing and enqueues nothing", async () => {
    // Every way the route can say no, in one place: unauthenticated, not the
    // gate's approver, and the right gate named under the wrong run. None of
    // them may leave a durable decision or a job behind.
    const stack = acmeStack({ rules: SEPARATION_RULES });
    const server = createApiApp({
      build: { version: "0.1.0", gitSha: "test", buildTime: "2026-01-01" },
      dependencies: { queue: "healthy", persistence: "healthy" },
      identity: createDevelopmentIdentity([
        { subject: "sam@example.test", secret: "sam-cred", roles: ["role-a"] },
        { subject: "ash@example.test", secret: "ash-cred", roles: ["role-b"] },
      ]),
      stack,
    });

    const gated = async () => {
      const accepted = (
        await server.inject({
          method: "POST",
          url: "/v1/runs",
          headers: { authorization: "Bearer sam-cred" },
          payload: bodyFor(WORKFLOW_A),
        })
      ).json();
      for (let attempt = 0; attempt < 2_000; attempt += 1) {
        const run = (
          await server.inject({
            method: "GET",
            url: `/v1/runs/${accepted.runId}`,
            headers: { authorization: "Bearer sam-cred" },
          })
        ).json();
        if (SETTLED.has(run.status as string)) return run;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error(`Run ${accepted.runId} never settled.`);
    };
    const mine = await gated();
    const other = await gated();

    const refusals: readonly [string, number, object][] = [
      ["no credential", 401, {}],
      ["the wrong role", 403, { authorization: "Bearer ash-cred" }],
    ];
    for (const [why, code, headers] of refusals) {
      const response = await server.inject({
        method: "POST",
        url: `/v1/runs/${mine.runId}/approvals/${mine.pendingApprovalId}/decision`,
        headers: headers as Record<string, string>,
        payload: { decision: "approve" },
      });
      expect(`${why} -> ${response.statusCode}`).toBe(`${why} -> ${code}`);
    }

    // And the gate named under a run it does not belong to.
    const mismatched = await server.inject({
      method: "POST",
      url: `/v1/runs/${other.runId}/approvals/${mine.pendingApprovalId}/decision`,
      headers: { authorization: "Bearer sam-cred" },
      payload: { decision: "approve" },
    });
    expect(mismatched.statusCode).toBe(404);

    expect((await stack.approvals.get(mine.pendingApprovalId))?.status).toBe(
      "PENDING",
    );
    // Nothing reached the queue: the two runs' own execute jobs were consumed
    // when they were started, so a resume here would be the only thing left.
    const seen: { type: string }[] = [];
    await stack.queue.subscribe(async (job) => {
      seen.push(job);
    });
    await stack.drain();
    expect(seen.filter((job) => job.type === "workflow.resume")).toEqual([]);
  });

  test("deciding twice enqueues one resume and dispatches once", async () => {
    // `operationKey` is `resume:<run>:<approval>`, so a repeated decision is
    // one operation. The effect ledger is the second guard, and neither is
    // allowed to be the only one.
    const stack = acmeStack();
    const server = app(stack);
    const started = await startRun(server);

    await submit(server, started, { decision: "approve" });
    await submit(server, started, { decision: "approve" });
    const finished = await settlePast(
      server,
      started.runId,
      started.pendingApprovalId,
    );

    expect(finished.status).toBe("SUCCEEDED");
    expect(finished.performedEffects).toEqual(["publish"]);
    expect(stack.dispatched).toEqual(["slack.post"]);
  });

  test("an edit is recorded and reissues its gate without a walk", async () => {
    // An edit authorises nothing, so there is nothing for a consumer to do —
    // but the route still behaves identically, because whether a decision
    // advances a run is the runtime's to know and not the route's.
    const stack = acmeStack();
    const server = app(stack);
    const started = await startRun(server);

    const response = await submit(server, started, {
      decision: "edit",
      patch: { copy: "reworded" },
    });
    expect(response.statusCode).toBe(202);

    const after = await settlePast(
      server,
      started.runId,
      started.pendingApprovalId,
    );
    expect(after.status).toBe("AWAITING_APPROVAL");
    expect(after.pendingApprovalId).not.toBe(started.pendingApprovalId);
    expect(stack.dispatched).toEqual([]);
  });
});

describe("a decision names one gate on one run", () => {
  test("an approval decided through another run's URL is not found", async () => {
    // The path parameter was decorative: the approval id alone selected the
    // run, so a caller sending the right gate with the wrong run got a 200 and
    // a decision applied to a run they never named. The binding and the
    // approver check always held, so this was never a bypass — but a control
    // plane that acts on a mismatched pair is telling the operator something
    // untrue about what they just did.
    const server = app();
    const mine = await startRun(server);
    const other = await startRun(server);

    const response = await server.inject({
      method: "POST",
      url: `/v1/runs/${other.runId}/approvals/${mine.pendingApprovalId}/decision`,
      headers: AUTH,
      payload: { decision: "approve" },
    });

    expect(response.statusCode).toBe(404);

    // And neither run moved.
    for (const run of [mine, other]) {
      const after = (
        await server.inject({
          method: "GET",
          url: `/v1/runs/${run.runId}`,
          headers: AUTH,
        })
      ).json();
      expect(after.status).toBe("AWAITING_APPROVAL");
      expect(after.performedEffects).toEqual([]);
    }
  });
});
