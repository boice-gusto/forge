export type PolicyDecision =
  | { readonly kind: "allow" }
  | {
      readonly kind: "deny";
      readonly reason: string;
      readonly policyId: string;
    }
  | {
      readonly kind: "require-approval";
      readonly reason: string;
      readonly policyId: string;
      readonly approvers: readonly string[];
    };

/**
 * Four fields, and deliberately no resource and no free text: there is nothing
 * here for workflow or model content to steer. `@forge/policy-conformance`
 * holds an implementation to that — a request carrying anything else must
 * decide identically.
 */
export interface PolicyRequest {
  /** Established at the authenticated boundary, never read from a payload. */
  readonly actor: string;
  readonly action: string;
  readonly environment: string;
  readonly capabilities: readonly string[];
}

export interface PolicyPort {
  /**
   * Fails closed: an evaluator error must surface as a deny, never an allow
   * (ADR-007).
   */
  decide(request: PolicyRequest): Promise<PolicyDecision>;
  /** The static closure a compiler can check a role's requirements against. */
  grantedCapabilities(): Promise<readonly string[]>;
}
