import {
  type ConformancePolicy,
  describePolicyConformance,
} from "@forge/policy-conformance";
import { describe, expect, test } from "vitest";

import { createMemoryPolicy } from "./policy.js";

describePolicyConformance({
  name: "@forge/policy-memory",
  create: (policy: ConformancePolicy) =>
    createMemoryPolicy({ rules: policy.rules, grants: policy.grants }),
  createFailing: (policy: ConformancePolicy) =>
    createMemoryPolicy({
      rules: policy.rules,
      grants: policy.grants,
      failEvaluation: true,
    }),
});

describe("@forge/policy-memory · beyond the contract", () => {
  test("the granted closure comes back sorted and deduplicated by the set", () => {
    const policy = createMemoryPolicy({
      rules: [],
      grants: ["slack.write", "docs.write", "slack.write"],
    });

    return expect(policy.grantedCapabilities()).resolves.toEqual([
      "docs.write",
      "slack.write",
    ]);
  });
});
