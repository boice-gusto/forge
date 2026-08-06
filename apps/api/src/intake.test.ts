import { createHmac } from "node:crypto";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadDeploymentPolicy } from "@forge/company";
import {
  createLocalStack,
  type LocalStack,
  type LocalStackOptions,
} from "@forge/composition";
import { createSlackConnector } from "@forge/connector-slack";
import { createMemoryIntakeLedger } from "@forge/intake";
import { ANY_ROLE } from "@forge/ports";
import { describe, expect, test } from "vitest";

import { createDevelopmentIdentity } from "./identity-development.js";
import { createApiApp } from "./main.js";

/**
 * A webhook is a front door, and this is what it may and may not open.
 *
 * The properties that matter are not about Slack. They are that a signed
 * delivery reaches the *same* runtime as an operator's `POST /v1/runs`, gets
 * the same policy, stops at the same gate — and that being able to start a run
 * is not being able to finish one. An intake route that could dispatch an
 * effect would be a second front door next to the one the invariant is
 * enforced at.
 */

const SECRET = ["intake", "route", "fixture"].join("-");
const BEARER = "test-operator-credential";
const AUTH = { authorization: `Bearer ${BEARER}` };
const AT = new Date("2026-08-04T00:00:00.000Z");

function deliver(body: unknown) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(AT.getTime() / 1000));
  const digest = createHmac("sha256", SECRET)
    .update(`v0:${timestamp}:${raw}`, "utf8")
    .digest("hex");
  return {
    payload: raw,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${digest}`,
    },
  };
}

const shortcut = (eventId: string) => ({
  type: "shortcut",
  callback_id: "acme.brief",
  event_id: eventId,
  user: { id: "U0SYNTHETIC" },
  payload: fixture.payload,
});

function app(stack: LocalStack = acmeStack()) {
  return createApiApp({
    build: { version: "0.1.0", gitSha: "test", buildTime: "2026-01-01" },
    dependencies: { queue: "healthy", persistence: "healthy" },
    identity: createDevelopmentIdentity([
      { subject: "marketing-lead", secret: BEARER, roles: [ANY_ROLE] },
    ]),
    stack,
    intake: {
      connectors: {
        slack: createSlackConnector({
          signingSecret: SECRET,
          // The deployment's table. A webhook names a shortcut, never a
          // workflow.
          workflows: { "acme.brief": fixture.workflow },
          capabilities: { "acme.brief": fixture.capabilities },
          now: () => AT,
        }),
      },
      ledger: createMemoryIntakeLedger(),
    },
  });
}

/** The company this deployment serves, loaded as a deployment loads one. */
const acme = await loadDeploymentPolicy({
  root: fileURLToPath(new URL("../../../examples/acme", import.meta.url)),
  hostCapabilities: ["repo.read", "docs.write", "slack.write"],
  forgeVersion: "0.1.0",
});

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
  payload?: unknown;
};

function acmeStack(): LocalStack {
  return createLocalStack({
    rules: acme.rules,
    grants: acme.grants,
    environment: "production",
    panel: fixture.panel,
    votesFor: () => fixture.review.votes,
    branchFor: (nodeId: string) => fixture.branch[nodeId],
  });
}

/**
 * The intake route persists and enqueues, exactly as `POST /v1/runs` does, so
 * the reply is a run at PENDING and the walk happens on the consumer. Waiting
 * for it here is waiting for the same thing an operator's start waits for.
 */
async function settle(
  server: ReturnType<typeof app>,
  runId: string,
): Promise<Record<string, unknown>> {
  const STOPPED = new Set([
    "AWAITING_APPROVAL",
    "SUCCEEDED",
    "FAILED",
    "CANCELLED",
  ]);
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const run = (
      await server.inject({
        method: "GET",
        url: `/v1/runs/${runId}`,
        headers: AUTH,
      })
    ).json();
    if (STOPPED.has(run.status as string)) return run;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Run ${runId} never stopped.`);
}

describe("a signed webhook starts a run and gets no further", () => {
  test("a valid delivery becomes a run, and the run stops at its gate", async () => {
    const server = app();

    const response = await server.inject({
      method: "POST",
      url: "/v1/intake/slack",
      ...deliver(shortcut("Ev0ACCEPTED")),
    });

    expect(`${response.statusCode} ${response.body}`).toContain("202");
    const runId = response.json().runId as string;
    expect(runId).toBeDefined();

    // The same runtime an operator's POST reaches, under the same policy.
    const run = await settle(server, runId);
    expect(run.status).toBe("AWAITING_APPROVAL");
    expect(run.performedEffects).toEqual([]);
  });

  test("being able to start a run is not being able to finish one", async () => {
    /**
     * The property the whole layer is arranged around. A webhook carries no
     * Forge credential, so it cannot decide the gate it just opened — and if
     * it could, the invariant would hold at `POST /v1/runs` and nowhere else.
     */
    const server = app();
    const started = await server.inject({
      method: "POST",
      url: "/v1/intake/slack",
      ...deliver(shortcut("Ev0NOAUTHORITY")),
    });
    const runId = started.json().runId as string;
    await settle(server, runId);

    const approvals = await server.inject({
      method: "GET",
      url: `/v1/runs/${runId}/approvals`,
      headers: AUTH,
    });
    const approvalId = approvals.json().pending[0].approvalId as string;

    // The same delivery signature, on the decision route. It is not a Forge
    // credential and must not be mistaken for one.
    const refused = await server.inject({
      method: "POST",
      url: `/v1/runs/${runId}/approvals/${approvalId}/decision`,
      headers: deliver(shortcut("Ev0NOAUTHORITY")).headers,
      payload: { decision: "approve" },
    });

    expect(refused.statusCode).toBe(401);
    const after = await server.inject({
      method: "GET",
      url: `/v1/runs/${runId}`,
      headers: AUTH,
    });
    expect(after.json().performedEffects).toEqual([]);
  });

  test("the signature is checked against the bytes that were sent", async () => {
    /**
     * `JSON.parse` followed by `JSON.stringify` does not round-trip —
     * whitespace, number formatting and unicode escapes all change — so a
     * signature verified against a re-serialised body is verified against
     * something the sender never signed. For a compact body the two happen to
     * agree, which is why this fixture is deliberately pretty-printed: it is
     * the difference between checking a signature and appearing to.
     *
     * Fastify parses a JSON body before any handler sees it, so getting this
     * right needs the raw string kept on purpose. It did not, at first, and
     * every test here passed anyway.
     */
    const server = app();
    const spaced = `${JSON.stringify(shortcut("Ev0SPACED"), null, 2)}\n`;
    const timestamp = String(Math.floor(AT.getTime() / 1000));
    const digest = createHmac("sha256", SECRET)
      .update(`v0:${timestamp}:${spaced}`, "utf8")
      .digest("hex");

    const response = await server.inject({
      method: "POST",
      url: "/v1/intake/slack",
      payload: spaced,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${digest}`,
      },
    });

    expect(`${response.statusCode} ${response.body}`).toContain("202");
    expect(response.json().runId).toBeDefined();
  });

  test("the thread that asked is told where its run got to", async () => {
    /**
     * The whole loop, and the reason a run remembers its origin: the process
     * that publishes this is a worker that never saw the delivery. Everything
     * it knows arrives through the run store.
     *
     * What goes back is a status and a link. The details stay in Forge, behind
     * Forge's own authentication — a Slack channel is not an access control
     * list.
     */
    const told: unknown[] = [];
    const publishing = {
      ...createSlackConnector({
        signingSecret: SECRET,
        workflows: { "acme.brief": fixture.workflow },
        capabilities: { "acme.brief": fixture.capabilities },
        now: () => AT,
      }),
      async publish(update: unknown) {
        told.push(update);
      },
    };

    const server = createApiApp({
      build: { version: "0.1.0", gitSha: "test", buildTime: "2026-01-01" },
      dependencies: { queue: "healthy", persistence: "healthy" },
      identity: createDevelopmentIdentity([
        { subject: "marketing-lead", secret: BEARER, roles: [ANY_ROLE] },
      ]),
      stack: acmeStack(),
      publicUrl: "https://forge.internal",
      intake: {
        connectors: { slack: publishing },
        ledger: createMemoryIntakeLedger(),
      },
    });

    const started = await server.inject({
      method: "POST",
      url: "/v1/intake/slack",
      ...deliver(shortcut("Ev0TOLD")),
    });
    const runId = started.json().runId as string;
    await settle(server, runId);

    expect(`told: ${JSON.stringify(told)}`).toContain("AWAITING_APPROVAL");
    expect(told[0]).toMatchObject({
      runId,
      status: "AWAITING_APPROVAL",
      origin: { channel: "slack", externalId: "Ev0TOLD" },
      runUrl: `https://forge.internal/v1/runs/${runId}`,
    });
    // Nothing about what the run is doing, only where to look.
    expect(JSON.stringify(told)).not.toContain("the copy");
  });

  test("a run the API started tells nobody, because nobody asked through a channel", async () => {
    // Guards the test above: an announcer that published everything would
    // pass it and would post a Slack message for every operator's `POST
    // /v1/runs`, including runs from a completely different team.
    const told: unknown[] = [];
    const publishing = {
      ...createSlackConnector({
        signingSecret: SECRET,
        workflows: { "acme.brief": fixture.workflow },
        now: () => AT,
      }),
      async publish(update: unknown) {
        told.push(update);
      },
    };

    const server = createApiApp({
      build: { version: "0.1.0", gitSha: "test", buildTime: "2026-01-01" },
      dependencies: { queue: "healthy", persistence: "healthy" },
      identity: createDevelopmentIdentity([
        { subject: "marketing-lead", secret: BEARER, roles: [ANY_ROLE] },
      ]),
      stack: acmeStack(),
      intake: {
        connectors: { slack: publishing },
        ledger: createMemoryIntakeLedger(),
      },
    });

    const started = await server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: AUTH,
      payload: {
        workflow: fixture.workflow,
        capabilities: fixture.capabilities,
      },
    });
    await settle(server, started.json().runId as string);

    expect(told).toEqual([]);
  });

  test("a forged delivery is a bare 401 and starts nothing", async () => {
    const server = app();
    const honest = deliver(shortcut("Ev0FORGED"));

    const response = await server.inject({
      method: "POST",
      url: "/v1/intake/slack",
      payload: honest.payload,
      headers: {
        ...honest.headers,
        "x-slack-signature": `v0=${"0".repeat(64)}`,
      },
    });

    expect(response.statusCode).toBe(401);
    // Nothing about why, and no run.
    expect(response.json()).toEqual({ status: "unauthorized" });
    const runs = await server.inject({
      method: "GET",
      url: "/v1/runs",
      headers: AUTH,
    });
    expect(runs.json().runs).toEqual([]);
  });

  test("a redelivery is accepted and starts nothing a second time", async () => {
    /**
     * Slack retries. A 4xx would make it retry harder, which is the one
     * behaviour deduplication is trying to stop — so a duplicate is a 202
     * that promises nothing, and the run count is what proves it.
     */
    const server = app();
    const first = await server.inject({
      method: "POST",
      url: "/v1/intake/slack",
      ...deliver(shortcut("Ev0RETRIED")),
    });
    const second = await server.inject({
      method: "POST",
      url: "/v1/intake/slack",
      ...deliver(shortcut("Ev0RETRIED")),
    });

    expect(first.json().runId).toBeDefined();
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({ outcome: "DUPLICATE" });
    expect(second.json().runId).toBeUndefined();

    const runs = await server.inject({
      method: "GET",
      url: "/v1/runs",
      headers: AUTH,
    });
    expect(runs.json().runs).toHaveLength(1);
  });

  test("an unrelated event is accepted and starts nothing", async () => {
    const server = app();

    const response = await server.inject({
      method: "POST",
      url: "/v1/intake/slack",
      ...deliver({ type: "message", event_id: "Ev0CHATTER" }),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ outcome: "UNSUPPORTED" });
  });

  test("a deployment's own broken workflow is a 500, and says nothing else", async () => {
    /**
     * The workflow comes from the deployment's table, so one that will not
     * compile is a deployment fault and not the sender's — 500, not 4xx, and
     * the diagnostics stay on this side. A webhook caller learns nothing about
     * the inside of a system it is only allowed to knock on.
     */
    const server = createApiApp({
      build: { version: "0.1.0", gitSha: "test", buildTime: "2026-01-01" },
      dependencies: { queue: "healthy", persistence: "healthy" },
      identity: createDevelopmentIdentity([
        { subject: "marketing-lead", secret: BEARER, roles: [ANY_ROLE] },
      ]),
      stack: acmeStack(),
      intake: {
        connectors: {
          slack: createSlackConnector({
            signingSecret: SECRET,
            workflows: { "acme.brief": { id: "not", nodes: "a workflow" } },
            now: () => AT,
          }),
        },
        ledger: createMemoryIntakeLedger(),
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/intake/slack",
      ...deliver(shortcut("Ev0BROKEN")),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ status: "error" });
    expect(response.body).not.toContain("diagnostic");
  });

  test("a channel this deployment does not serve is a 404", async () => {
    // Not an endpoint that authenticates nobody. A connector that is not
    // bound has no signing secret here, so there is nothing to verify against
    // and nothing to pretend about.
    const server = app();

    const response = await server.inject({
      method: "POST",
      url: "/v1/intake/jira",
      ...deliver(shortcut("Ev0WRONGCHANNEL")),
    });

    expect(response.statusCode).toBe(404);
  });

  test("a control plane with no intake bound serves no webhook at all", async () => {
    // The default, and the right one: a deployment that has not thought about
    // webhooks does not have one.
    const server = createApiApp({
      build: { version: "0.1.0", gitSha: "test", buildTime: "2026-01-01" },
      dependencies: { queue: "healthy", persistence: "healthy" },
      identity: createDevelopmentIdentity([
        { subject: "marketing-lead", secret: BEARER, roles: [ANY_ROLE] },
      ]),
      stack: acmeStack(),
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/intake/slack",
      ...deliver(shortcut("Ev0NOINTAKE")),
    });

    expect(response.statusCode).toBe(404);
  });
});
