import { readFileSync } from "node:fs";

import {
  CONFORMANCE_POLICY,
  type ConformancePolicy,
  describePolicyConformance,
  GRANTED_CAPABILITY,
  PRODUCTION,
  request,
} from "@forge/policy-conformance";
import { describe, expect, test } from "vitest";

import { createOpaPolicy } from "./policy.js";

/**
 * A bundle Forge did not compile: it answers the same entrypoint with each way
 * a module can misbehave, keyed by action, and defaults to `allow`. Anything
 * the adapter fails to reject therefore shows up as an allow rather than as an
 * absence.
 */
const UNTRUSTED = readFileSync(
  new URL("../policy/untrusted.wasm", import.meta.url),
);

describePolicyConformance({
  name: "@forge/policy-opa",
  create: (policy: ConformancePolicy) =>
    createOpaPolicy({ rules: policy.rules, grants: policy.grants }),
  createFailing: (policy: ConformancePolicy) =>
    createOpaPolicy({
      rules: policy.rules,
      grants: policy.grants,
      wasm: UNTRUSTED,
    }),
});

describe("@forge/policy-opa · a bundle Forge did not compile is not trusted", () => {
  const untrusted = () =>
    createOpaPolicy({ rules: [], grants: [], wasm: UNTRUSTED });

  test.for([
    ["evaluator.error", "the evaluator raises"],
    ["not.an.object", "the result is not a decision object"],
    ["unknown.kind", "the kind is one Forge does not know"],
    ["missing.fields", "a deny carries no reason or policy id"],
    ["bad.approvers", "approvers is not a list"],
    ["bad.approver.entry", "an approver is not a name"],
  ])("denies when %s — %s", async ([action]) => {
    const policy = await untrusted();

    // The fixture's default is allow, so a missing check reads as an allow.
    expect(await policy.decide(request({ action: action as string }))).toEqual({
      kind: "deny",
      reason: "Policy evaluation failed; failing closed.",
      policyId: "forge.policy.evaluator-error",
    });
  });

  test("a well-formed decision from a company bundle is still honoured", async () => {
    const policy = await untrusted();

    // The same fixture answers this one with a valid allow, so the adapter is
    // rejecting shapes rather than rejecting the bundle.
    expect(await policy.decide(request({ action: "well.formed" }))).toEqual({
      kind: "allow",
    });
  });
});

describe("@forge/policy-opa · the committed module is the one being evaluated", () => {
  test("the shipped bundle decides, with no opa binary anywhere on the path", async () => {
    const policy = await createOpaPolicy({
      rules: CONFORMANCE_POLICY.rules,
      grants: CONFORMANCE_POLICY.grants,
    });

    expect(
      await policy.decide(
        request({
          action: "slack.post",
          environment: PRODUCTION,
          capabilities: [GRANTED_CAPABILITY],
        }),
      ),
    ).toMatchObject({ kind: "require-approval" });
  });

  test("a duplicated grant is one capability, not two", async () => {
    const policy = await createOpaPolicy({
      rules: [],
      grants: ["slack.write", "slack.write", "docs.write"],
    });

    expect(await policy.grantedCapabilities()).toEqual([
      "docs.write",
      "slack.write",
    ]);
  });
});
