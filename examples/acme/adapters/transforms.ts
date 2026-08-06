/**
 * Acme's transform table: what a `transform` node computes with.
 *
 * A company ships these, not Forge. An author writes `transformRef:
 * "acme.marketing.summarise"` in a workflow; this is where that name becomes
 * code, and the deployment decides which code.
 *
 * Pure functions of their input, deliberately. A transform runs inside a walk
 * with no gate in front of it — it is not a side effect and must not become
 * one. Anything that reaches a customer belongs on a `tool` node behind a
 * policy decision.
 */

export type Transform = (
  input: unknown,
) => unknown | undefined | Promise<unknown | undefined>;

/** Trims a brief to its first line, for a channel with a length limit. */
const headline: Transform = (input) => {
  const body = (input as { body?: unknown })?.body;
  if (typeof body !== "string") return undefined;
  const [first = ""] = body.split("\n");
  return { headline: first.slice(0, 120) };
};

export default {
  "acme.marketing.headline": headline,
} satisfies Record<string, Transform>;
