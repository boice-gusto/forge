import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Whether a delivery carries the signature its secret would produce.
 *
 * Here rather than in each connector because every one of them needs it and
 * the ways to get it wrong are the same every time: comparing with `===` leaks
 * the secret a byte at a time to anyone who can measure, and comparing buffers
 * of different lengths throws where it should return false.
 *
 * The digest is over the raw body, never a re-serialised one. `JSON.parse`
 * followed by `JSON.stringify` does not round-trip — key order, number
 * formatting, unicode escapes — so a re-serialised body verifies against a
 * signature the sender never computed, which means it verifies against
 * nothing.
 */
export function signatureMatches(input: {
  readonly body: string;
  readonly secret: string;
  readonly presented: string | undefined;
  /** Prefixed by some senders, e.g. Slack's `v0=`. Compared verbatim. */
  readonly algorithm?: "sha256";
}): boolean {
  if (input.presented === undefined || input.presented === "") return false;

  const expected = createHmac(input.algorithm ?? "sha256", input.secret)
    .update(input.body, "utf8")
    .digest("hex");

  const presented = Buffer.from(input.presented, "utf8");
  const computed = Buffer.from(expected, "utf8");
  // `timingSafeEqual` throws on a length mismatch, and a mismatch is an
  // ordinary wrong answer rather than an exceptional one.
  if (presented.length !== computed.length) return false;
  return timingSafeEqual(presented, computed);
}
