import { createHmac } from "node:crypto";

import { describeConnectorConformance } from "@forge/intake/conformance";
import { describe, expect, test } from "vitest";

import { createSlackConnector } from "./connector.js";

/**
 * A signing secret for this file and nowhere else. Not a credential: it signs
 * fixtures against a connector constructed in the same function.
 */
const SECRET = ["conformance", "fixture", "secret"].join("-");
const AT = new Date("2026-08-04T00:00:00.000Z");
const WORKFLOW = { id: "acme.brief", version: "1.0.0", nodes: [], edges: [] };

/** Signs a body the way Slack does: `v0:{timestamp}:{body}`. */
function deliver(body: unknown, options: { readonly at?: Date } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor((options.at ?? AT).getTime() / 1000));
  const digest = createHmac("sha256", SECRET)
    .update(`v0:${timestamp}:${raw}`, "utf8")
    .digest("hex");
  return {
    body: raw,
    headers: {
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
  payload: { body: "the copy" },
});

const connector = () =>
  createSlackConnector({
    signingSecret: SECRET,
    workflows: { "acme.brief": WORKFLOW },
    capabilities: { "acme.brief": ["slack.write"] },
    now: () => AT,
  });

describeConnectorConformance({
  name: "connector-slack",
  create: connector,
  valid: () => deliver(shortcut("Ev0SYNTHETIC")),
  forged: () => {
    // The signature broken and *only* the signature: same body, same
    // timestamp. A fixture that also changed the body would pass the suite
    // while proving the body check rather than the signature check.
    const honest = deliver(shortcut("Ev0SYNTHETIC"));
    return {
      body: honest.body,
      headers: {
        ...honest.headers,
        "x-slack-signature": `v0=${"0".repeat(64)}`,
      },
    };
  },
  irrelevant: () =>
    deliver({
      type: "message",
      event_id: "Ev0CHATTER",
      user: { id: "U0SYNTHETIC" },
    }),
  externalIdOfValid: () => "Ev0SYNTHETIC",
});

describe("the properties Slack's own scheme adds", () => {
  test("a captured delivery cannot be replayed once its window has passed", async () => {
    /**
     * A correctly signed body stays correctly signed forever. Without the
     * window, anyone who captures one delivery — a proxy log, a mirrored
     * port — can resend it for as long as the signing secret lives, and every
     * replay is a genuinely valid signature.
     *
     * Signed at the fixture instant and presented six minutes later, so the
     * signature is real and only its age is wrong.
     */
    const stale = deliver(shortcut("Ev0REPLAY"), { at: AT });
    const later = createSlackConnector({
      signingSecret: SECRET,
      workflows: { "acme.brief": WORKFLOW },
      now: () => new Date(AT.getTime() + 6 * 60 * 1000),
    });

    const outcome = await later.verify(stale);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("UNVERIFIED");
    expect(outcome.ok === false && outcome.detail).toContain("out of date");
  });

  test("the timestamp is inside the digest, so it cannot be moved forward", async () => {
    /**
     * The other half of the replay defence, and the half that is easy to get
     * wrong: if the signature covered the body alone, an attacker would
     * simply present a captured body under a fresh timestamp and the window
     * would defend nothing.
     */
    const captured = deliver(shortcut("Ev0REPLAY"), { at: AT });
    const moved = {
      body: captured.body,
      headers: {
        ...captured.headers,
        "x-slack-request-timestamp": String(
          Math.floor(AT.getTime() / 1000) + 60,
        ),
      },
    };

    await expect(connector().verify(moved)).resolves.toMatchObject({
      ok: false,
      code: "UNVERIFIED",
    });
  });

  test("a shortcut this deployment does not serve reaches no workflow", async () => {
    // There is no path from a webhook to a workflow the deployment did not
    // name. Refused by absence rather than by a check somebody can forget.
    const outcome = await connector().normalise({
      origin: {
        channel: "slack",
        externalId: "Ev0UNKNOWN",
        externalActor: "U0SYNTHETIC",
        receivedAt: AT.toISOString(),
      },
      body: { ...shortcut("Ev0UNKNOWN"), callback_id: "acme.not-registered" },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("UNSUPPORTED");
  });

  test("a verified delivery with no event id is refused rather than accepted undeduplicable", async () => {
    // Slack redelivers. A delivery with no stable id cannot be deduplicated,
    // and accepting it would mean one shortcut becoming two runs.
    const outcome = await connector().verify(
      deliver({ type: "shortcut", callback_id: "acme.brief" }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("MALFORMED");
  });

  test("a delivery with no signature headers is refused before anything else", async () => {
    // What an unauthenticated prod looks like: a POST with a body and no
    // headers at all. It must cost a lookup, not an HMAC and a parse.
    const outcome = await connector().verify({
      body: JSON.stringify(shortcut("Ev0BARE")),
      headers: {},
    });

    expect(outcome).toMatchObject({ ok: false, code: "UNVERIFIED" });
  });

  test("a signature under a scheme version we do not implement is refused", async () => {
    /**
     * Slack versions its scheme, and a future `v1` will not mean the same
     * bytes. Accepting an unknown version because the digest happened to
     * match would be verifying against a construction nobody agreed on.
     */
    const honest = deliver(shortcut("Ev0VERSION"));
    const outcome = await connector().verify({
      body: honest.body,
      headers: {
        ...honest.headers,
        "x-slack-signature": honest.headers["x-slack-signature"].replace(
          "v0=",
          "v9=",
        ),
      },
    });

    expect(outcome).toMatchObject({ ok: false, code: "UNVERIFIED" });
  });

  test("a timestamp that is not a number is refused rather than compared as NaN", async () => {
    // `Math.abs(now - NaN)` is NaN, and `NaN > MAX_SKEW` is false — so a
    // garbage timestamp would sail past the replay window into the digest.
    const honest = deliver(shortcut("Ev0NAN"));
    const outcome = await connector().verify({
      body: honest.body,
      headers: { ...honest.headers, "x-slack-request-timestamp": "recently" },
    });

    expect(outcome).toMatchObject({ ok: false, code: "UNVERIFIED" });
  });

  test("a correctly signed body that is not JSON is MALFORMED, not UNVERIFIED", async () => {
    /**
     * Only reachable by someone holding the signing secret, which is the
     * point: it proves parsing happens *after* verification. The codes have
     * to differ, because an operator counting UNVERIFIED is watching for an
     * attack and one counting MALFORMED is watching for a broken integration.
     */
    const timestamp = String(Math.floor(AT.getTime() / 1000));
    const body = "not json, but properly signed";
    const digest = createHmac("sha256", SECRET)
      .update(`v0:${timestamp}:${body}`, "utf8")
      .digest("hex");

    const outcome = await connector().verify({
      body,
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${digest}`,
      },
    });

    expect(outcome).toMatchObject({ ok: false, code: "MALFORMED" });
  });

  test("a shortcut with no callback_id names no workflow and says so", async () => {
    const outcome = await connector().normalise({
      origin: {
        channel: "slack",
        externalId: "Ev0NOCALLBACK",
        externalActor: "U0SYNTHETIC",
        receivedAt: AT.toISOString(),
      },
      body: { type: "shortcut", event_id: "Ev0NOCALLBACK" },
    });

    expect(outcome).toMatchObject({ ok: false, code: "MALFORMED" });
  });

  test("a delivery from an unnamed sender still records an actor", async () => {
    // Slack does not always send `user` — an app-level event has none. The
    // origin still has to carry *something*, because a run with no recorded
    // asker is a run nobody can be asked about.
    const outcome = await connector().verify(
      deliver({
        type: "shortcut",
        callback_id: "acme.brief",
        event_id: "Ev0NOUSER",
      }),
    );

    expect(`${JSON.stringify(outcome)}`).toContain('"ok":true');
    if (!outcome.ok) return;
    expect(outcome.value.origin.externalActor).toBe("unknown");
  });

  test("a shortcut carrying no payload produces a request with none", async () => {
    // Absent stays absent. An omitted payload must not become an empty
    // object, or a node reading one proceeds on data nobody sent.
    const outcome = await connector().normalise({
      origin: {
        channel: "slack",
        externalId: "Ev0NOPAYLOAD",
        externalActor: "U0SYNTHETIC",
        receivedAt: AT.toISOString(),
      },
      body: { type: "shortcut", callback_id: "acme.brief" },
    });

    expect(`${JSON.stringify(outcome)}`).toContain('"ok":true');
    if (!outcome.ok) return;
    expect("payload" in outcome.value).toBe(false);
    // Capabilities are keyed on the callback id, not on the payload, so they
    // are unchanged by its absence — a shortcut asks for what the deployment
    // said that shortcut asks for.
    expect(outcome.value.capabilities).toEqual(["slack.write"]);
  });

  test("a connector built the way a deployment builds one reads the real clock", async () => {
    // Every test above injects `now`, so the default was the one line here
    // that production uses and no test did.
    const production = createSlackConnector({
      signingSecret: SECRET,
      workflows: { "acme.brief": WORKFLOW },
    });

    const outcome = await production.verify(
      deliver(shortcut("Ev0CLOCK"), { at: new Date() }),
    );

    expect(`${JSON.stringify(outcome)}`).toContain('"ok":true');
  });

  test("the request carries what the deployment said, not what the caller asked for", async () => {
    // The workflow comes from the deployment's own table, keyed by callback
    // id. A connector that accepted workflow source over a webhook would be
    // an unauthenticated caller choosing what runs.
    const outcome = await connector().normalise({
      origin: {
        channel: "slack",
        externalId: "Ev0SYNTHETIC",
        externalActor: "U0SYNTHETIC",
        receivedAt: AT.toISOString(),
      },
      body: { ...shortcut("Ev0SYNTHETIC"), workflow: { id: "attacker.owns" } },
    });

    expect(`normalised: ${JSON.stringify(outcome)}`).toContain('"ok":true');
    if (!outcome.ok) return;
    expect(outcome.value.workflow).toEqual(WORKFLOW);
    expect(outcome.value.capabilities).toEqual(["slack.write"]);
  });
});
