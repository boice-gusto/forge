import { readFileSync } from "node:fs";

import { FORGE_POLICY_IDS } from "@forge/ports";
import { describe, expect, test } from "vitest";

/**
 * `policy/forge.rego` is the third copy of the policy ids, and the only one
 * outside TypeScript's reach: a rename in `FORGE_POLICY_IDS` leaves the Rego
 * spelling the old one, compiles, passes every other test, and ships two
 * adapters that disagree about what to call the same denial.
 *
 * Read as source text rather than through the compiled `forge.wasm`,
 * deliberately. What the module *does* is already covered by the conformance
 * suite; what nothing checks is the file the next person edits, which is also
 * the file the Wasm is rebuilt by hand from.
 */
const REGO = readFileSync(
  new URL("../policy/forge.rego", import.meta.url),
  "utf8",
);

const HARD_CODED_POLICY_ID = /(?<="policyId":\s*")[^"]*/g;

describe("@forge/policy-opa · the Rego and the TypeScript agree on policy ids", () => {
  test("every id the module hard-codes is one the adapters know", () => {
    const inRego = new Set(
      [...REGO.matchAll(HARD_CODED_POLICY_ID)].map((match) => match[0]),
    );

    // `evaluatorError` is absent on purpose: the Rego cannot report that it
    // failed to run. Every other id the module answers with comes from a rule.
    expect(inRego).toEqual(
      new Set([
        FORGE_POLICY_IDS.defaultDeny,
        FORGE_POLICY_IDS.capabilityClosure,
      ]),
    );
  });
});
