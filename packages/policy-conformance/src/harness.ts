import type { PolicyPort, PolicyRequest } from "@forge/ports";

/**
 * A rule as a company policy pack writes it (`PolicyPackSchema` in
 * `@forge/manifest`). The port itself has no rule language — it only answers
 * decisions — so a suite that wants to ask "does a production-scoped rule fire
 * in research?" has to be able to state the rule. This is the one shared
 * vocabulary every implementation must accept, whatever it compiles down to.
 */
export interface ConformanceRule {
  readonly id: string;
  readonly action: string;
  /** Absent means the rule is unscoped and matches every environment. */
  readonly environment?: string;
  readonly decision: "allow" | "deny" | "require-approval";
  readonly reason: string;
  readonly approvers?: readonly string[];
}

export interface ConformancePolicy {
  readonly rules: readonly ConformanceRule[];
  /** The host capability closure. An implementation may not widen it. */
  readonly grants: readonly string[];
}

export interface PolicyConformanceHarness {
  /** Names the suite, so a failure says which adapter broke. */
  readonly name: string;
  /** The adapter carrying exactly this policy and nothing else. */
  create(policy: ConformancePolicy): PolicyPort | Promise<PolicyPort>;
  /**
   * The same adapter carrying the same policy, with its evaluator broken for
   * real — not a flag that returns a deny, which would prove only that the
   * flag works. Without this the fail-closed rule the whole system rests on
   * cannot be tested from outside, and it is the one rule that must never be
   * merely asserted in a comment.
   */
  createFailing(policy: ConformancePolicy): PolicyPort | Promise<PolicyPort>;
}

export const CONFORMANCE_ACTOR = "u_conformance";
export const PRODUCTION = "production";
export const RESEARCH = "research";

export const GRANTED_CAPABILITY = "slack.write";
export const SECOND_GRANTED_CAPABILITY = "docs.write";
export const UNGRANTED_CAPABILITY = "prod.write";

/** An action deliberately absent from every rule below. */
export const UNGOVERNED_ACTION = "nothing.matches";

export const APPROVERS = ["marketing-lead", "security-reviewer"] as const;

/**
 * One pack, shaped like the Gusto-style packs in 009 §11: some rules scoped to
 * an environment, one that is not, and one decision of each kind. Three of the
 * four are production-scoped so that the same request in `research` has to fall
 * through to the default — an implementation that ignores environment turns
 * `deploy.rollout` into an allow anywhere, which is exactly forge.gusto G4.
 */
export const CONFORMANCE_POLICY: ConformancePolicy = {
  grants: [GRANTED_CAPABILITY, SECOND_GRANTED_CAPABILITY],
  rules: [
    {
      id: "pack.slack.production",
      action: "slack.post",
      environment: PRODUCTION,
      decision: "require-approval",
      reason: "A production post reaches a customer.",
      approvers: [...APPROVERS],
    },
    {
      id: "pack.deploy.production",
      action: "deploy.rollout",
      environment: PRODUCTION,
      decision: "allow",
      reason: "Rollout is governed by change management.",
    },
    {
      id: "pack.payroll.production",
      action: "payroll.run",
      environment: PRODUCTION,
      decision: "deny",
      reason: "Payroll is never run by a workflow.",
    },
    {
      id: "pack.docs.anywhere",
      action: "docs.write",
      decision: "allow",
      reason: "Internal documentation is unscoped.",
    },
  ],
};

export const RULE_IDS: readonly string[] = CONFORMANCE_POLICY.rules.map(
  (rule) => rule.id,
);

export function request(
  overrides: Partial<PolicyRequest> & Pick<PolicyRequest, "action">,
): PolicyRequest {
  return {
    actor: CONFORMANCE_ACTOR,
    environment: PRODUCTION,
    capabilities: [],
    ...overrides,
  };
}
