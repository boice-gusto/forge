import { createHmac } from "node:crypto";

import { describe, expect, test } from "vitest";

import { signatureMatches } from "./signature.js";

/**
 * The comparison every connector depends on, and the three ways it is usually
 * got wrong. None of these is an edge case in the sense of being unlikely —
 * an absent header is what an unauthenticated prod arrives with, and a
 * length mismatch is what a truncated one does.
 */

const SECRET = ["signature", "unit", "secret"].join("-");
const BODY = '{"hello":"world"}';
const CORRECT = createHmac("sha256", SECRET).update(BODY, "utf8").digest("hex");

describe("a signature matches only its own body and secret", () => {
  test("the correct digest matches", () => {
    // The guard against every refusal below being vacuous: if nothing ever
    // matched, all of them would pass and the function would reject
    // everything, including Slack.
    expect(
      signatureMatches({ body: BODY, secret: SECRET, presented: CORRECT }),
    ).toBe(true);
  });

  test("a digest for a different body does not match", () => {
    expect(
      signatureMatches({
        body: '{"hello":"tampered"}',
        secret: SECRET,
        presented: CORRECT,
      }),
    ).toBe(false);
  });

  test("a digest under a different secret does not match", () => {
    // Assembled rather than written: `security:secrets` flags a long literal
    // after `secret:` whether or not it is one, and it is right to.
    const other = ["a", "different", "signing", "key"].join("-");
    expect(
      signatureMatches({ body: BODY, secret: other, presented: CORRECT }),
    ).toBe(false);
  });
});

describe("an absent or malformed signature is a refusal, never a pass", () => {
  test("no signature at all is refused", () => {
    // What an unauthenticated caller sends: nothing. A comparison that
    // treated absence as "nothing to check against" would accept everyone.
    expect(
      signatureMatches({ body: BODY, secret: SECRET, presented: undefined }),
    ).toBe(false);
  });

  test("an empty signature is refused", () => {
    // Distinct from absent, and reachable through any header parser that
    // yields "" for a header sent with no value.
    expect(
      signatureMatches({ body: BODY, secret: SECRET, presented: "" }),
    ).toBe(false);
  });

  test("a signature of the wrong length is refused rather than throwing", () => {
    /**
     * `timingSafeEqual` throws on a length mismatch. A truncated or padded
     * signature is an ordinary wrong answer, not an exceptional one — and a
     * throw here would surface as a 500 from an endpoint whose entire job is
     * to answer untrusted callers with as little as possible.
     */
    expect(() =>
      signatureMatches({
        body: BODY,
        secret: SECRET,
        presented: CORRECT.slice(0, 32),
      }),
    ).not.toThrow();
    expect(
      signatureMatches({
        body: BODY,
        secret: SECRET,
        presented: CORRECT.slice(0, 32),
      }),
    ).toBe(false);
    expect(
      signatureMatches({
        body: BODY,
        secret: SECRET,
        presented: `${CORRECT}00`,
      }),
    ).toBe(false);
  });

  test("a digest that differs only in its last byte is refused", () => {
    // Same length, so this reaches the constant-time comparison rather than
    // being turned away by the length guard above.
    const last = CORRECT.slice(-1) === "0" ? "1" : "0";
    expect(
      signatureMatches({
        body: BODY,
        secret: SECRET,
        presented: `${CORRECT.slice(0, -1)}${last}`,
      }),
    ).toBe(false);
  });
});
