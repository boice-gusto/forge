import { createHmac } from "node:crypto";

import { describeConnectorConformance } from "@forge/intake/conformance";
import { describe, expect, test } from "vitest";

import { createJiraConnector } from "./connector.js";

/**
 * The second connector, and the point of a second one is that it does not
 * resemble the first. Jira signs a plain HMAC over the body with no version
 * prefix and no timestamp inside the digest; it names events differently and
 * identifies humans by account id. The same conformance suite holds, which is
 * what makes `WorkflowRequest` canonical rather than aspirational.
 */

const SECRET = ["jira", "conformance", "fixture"].join("-");
const AT = new Date("2026-08-04T00:00:00.000Z");
const WORKFLOW = { id: "acme.triage", version: "1.0.0", nodes: [], edges: [] };

function deliver(body: unknown) {
  const raw = JSON.stringify(body);
  const digest = createHmac("sha256", SECRET).update(raw, "utf8").digest("hex");
  return { body: raw, headers: { "x-hub-signature-256": `sha256=${digest}` } };
}

const created = (id: number) => ({
  webhookEvent: "jira:issue_created",
  id,
  user: { accountId: "5b10a2844c20165700ede21g" },
  issue: { key: "ACME-1", fields: { summary: "a customer named in the open" } },
});

const connector = () =>
  createJiraConnector({
    secret: SECRET,
    workflows: { "jira:issue_created": WORKFLOW },
    capabilities: { "jira:issue_created": ["repo.read"] },
    now: () => AT,
  });

describeConnectorConformance({
  name: "connector-jira",
  create: connector,
  valid: () => deliver(created(1001)),
  forged: () => {
    // The signature broken and only the signature.
    const honest = deliver(created(1001));
    return {
      body: honest.body,
      headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
    };
  },
  irrelevant: () => deliver({ webhookEvent: "jira:worklog_updated", id: 1002 }),
  externalIdOfValid: () => "1001",
});

describe("what Jira's own scheme demands", () => {
  test("a numeric delivery id becomes a stable string key", async () => {
    // Jira sends `id` as a number; the ledger keys on strings. A connector
    // that let the type through would deduplicate 1001 against "1001" never.
    const outcome = await connector().verify(deliver(created(1001)));

    expect(`${JSON.stringify(outcome)}`).toContain('"ok":true');
    if (!outcome.ok) return;
    expect(outcome.value.origin.externalId).toBe("1001");
  });

  test("an id that is not a number or a string is refused, not coerced", async () => {
    /**
     * `String({})` is `"[object Object]"` — a perfectly stable key that every
     * malformed delivery in the world shares, so they would deduplicate
     * against one another and the first would silence the rest.
     */
    const outcome = await connector().verify(
      deliver({ webhookEvent: "jira:issue_created", id: { nested: true } }),
    );

    expect(outcome).toMatchObject({ ok: false, code: "MALFORMED" });
  });

  test("a signature without its encoding prefix is refused", async () => {
    const honest = deliver(created(1003));
    const outcome = await connector().verify({
      body: honest.body,
      headers: {
        "x-hub-signature-256": honest.headers["x-hub-signature-256"].replace(
          "sha256=",
          "",
        ),
      },
    });

    expect(outcome).toMatchObject({ ok: false, code: "UNVERIFIED" });
  });

  test("only the issue key crosses into the run, never the issue", async () => {
    /**
     * A Jira issue carries whatever a human typed, which for a payroll
     * product routinely includes a customer's name. Forwarding the event
     * wholesale would put it in the run store, in the audit trail, and in
     * front of an approver who did not need it.
     */
    const verified = await connector().verify(deliver(created(1004)));
    expect(`${JSON.stringify(verified)}`).toContain('"ok":true');
    if (!verified.ok) return;

    const outcome = await connector().normalise(verified.value);

    expect(`${JSON.stringify(outcome)}`).toContain('"ok":true');
    if (!outcome.ok) return;
    expect(outcome.value.payload).toEqual({ issueKey: "ACME-1" });
    expect(JSON.stringify(outcome.value)).not.toContain("customer named");
  });

  test("a delivery with no signature header at all is refused", async () => {
    // What an unauthenticated prod looks like. It must cost a lookup, not an
    // HMAC and a parse.
    const outcome = await connector().verify({
      body: JSON.stringify(created(1008)),
      headers: {},
    });

    expect(outcome).toMatchObject({ ok: false, code: "UNVERIFIED" });
  });

  test("a correctly signed body that is not JSON is MALFORMED, not UNVERIFIED", async () => {
    // Only reachable by someone holding the secret, which is the point: it
    // proves parsing happens after verification. The codes differ because an
    // operator counting UNVERIFIED is watching for an attack and one counting
    // MALFORMED is watching for a broken integration.
    const body = "not json, but properly signed";
    const digest = createHmac("sha256", SECRET)
      .update(body, "utf8")
      .digest("hex");

    const outcome = await connector().verify({
      body,
      headers: { "x-hub-signature-256": `sha256=${digest}` },
    });

    expect(outcome).toMatchObject({ ok: false, code: "MALFORMED" });
  });

  test("an event with no webhookEvent names no workflow", async () => {
    const outcome = await connector().normalise({
      origin: {
        channel: "jira",
        externalId: "1005",
        externalActor: "unknown",
        receivedAt: AT.toISOString(),
      },
      body: { id: 1005 },
    });

    expect(outcome).toMatchObject({ ok: false, code: "MALFORMED" });
  });

  test("a delivery from no named user still records an actor", async () => {
    const outcome = await connector().verify(
      deliver({ webhookEvent: "jira:issue_created", id: 1006 }),
    );

    expect(`${JSON.stringify(outcome)}`).toContain('"ok":true');
    if (!outcome.ok) return;
    expect(outcome.value.origin.externalActor).toBe("unknown");
  });

  test("a connector built the way a deployment builds one reads the real clock", async () => {
    const production = createJiraConnector({
      secret: SECRET,
      workflows: { "jira:issue_created": WORKFLOW },
    });

    const outcome = await production.verify(deliver(created(1007)));

    expect(`${JSON.stringify(outcome)}`).toContain('"ok":true');
  });
});
