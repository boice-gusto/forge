import type { PolicyDecision, PolicyPort, PolicyRequest } from "@forge/ports";

/**
 * In-memory policy evaluator.
 *
 * Stands in for the OPA-backed adapter (ADR-007). The behaviour that matters
 * is not the rule language but the two invariants: authorisation is decided
 * from the trusted actor rather than inferred from any payload, and an
 * evaluator error is a deny.
 */

export interface PolicyRule {
  readonly id: string;
  readonly action: string;
  /**
   * `| undefined` is explicit because these rules arrive from a parsed company
   * policy pack, and a Zod optional yields a present-but-undefined property
   * rather than an absent one. Under `exactOptionalPropertyTypes` those are
   * different types, and the alternative is a mapper stripping undefined at
   * every boundary where a pack meets the evaluator.
   */
  readonly environment?: string | undefined;
  readonly decision: "allow" | "deny" | "require-approval";
  readonly reason: string;
  readonly approvers?: readonly string[] | undefined;
}

export interface MemoryPolicyOptions {
  readonly rules: readonly PolicyRule[];
  readonly grants: readonly string[];
  /**
   * Makes evaluation throw, to prove the fail-closed path. Never used in
   * normal operation.
   */
  readonly failEvaluation?: boolean;
}

const DENY_BY_DEFAULT: PolicyDecision = {
  kind: "deny",
  reason: "No rule permits this action; policy denies by default.",
  policyId: "forge.policy.default-deny",
};

const EVALUATOR_ERROR: PolicyDecision = {
  kind: "deny",
  reason: "Policy evaluation failed; failing closed.",
  policyId: "forge.policy.evaluator-error",
};

export function createMemoryPolicy(options: MemoryPolicyOptions): PolicyPort {
  const grants = new Set(options.grants);

  function evaluate(request: PolicyRequest): PolicyDecision {
    // Thrown rather than returned, so `decide`'s catch is what turns an
    // evaluator failure into a deny. A flag that returned the deny directly
    // would prove only that the flag works, and the catch could be deleted
    // without a test noticing.
    if (options.failEvaluation === true) {
      throw new Error("Injected policy evaluation failure.");
    }

    // A capability the closure never granted cannot be exercised, whatever
    // any rule or prompt says.
    const ungranted = request.capabilities.filter((cap) => !grants.has(cap));
    if (ungranted.length > 0) {
      return {
        kind: "deny",
        reason: `Capabilities outside the granted closure: ${ungranted.join(", ")}.`,
        policyId: "forge.policy.capability-closure",
      };
    }

    const rule = options.rules.find(
      (candidate) =>
        candidate.action === request.action &&
        (candidate.environment === undefined ||
          candidate.environment === request.environment),
    );
    if (rule === undefined) return DENY_BY_DEFAULT;

    if (rule.decision === "allow") return { kind: "allow" };
    if (rule.decision === "deny")
      return { kind: "deny", reason: rule.reason, policyId: rule.id };
    return {
      kind: "require-approval",
      reason: rule.reason,
      policyId: rule.id,
      approvers: rule.approvers ?? [],
    };
  }

  return {
    async decide(request: PolicyRequest): Promise<PolicyDecision> {
      try {
        return evaluate(request);
      } catch {
        return EVALUATOR_ERROR;
      }
    },

    async grantedCapabilities() {
      return [...grants].sort();
    },
  };
}
