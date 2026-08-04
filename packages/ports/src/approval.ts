/**
 * First-class human gate protocol (006 §6.4). Not an engine interrupt wearing
 * a Forge label: an approval is a durable record with approvers, an expiry,
 * and a binding to one exact action.
 */

export type ApprovalDecision =
  | { readonly kind: "approve" }
  | { readonly kind: "reject"; readonly reason: string }
  /** Amends the proposed action, which necessarily invalidates the binding. */
  | { readonly kind: "edit"; readonly patch: unknown }
  | { readonly kind: "timeout" };

export type ApprovalStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "EDITED"
  | "TIMED_OUT";

export interface ApprovalRequest {
  readonly runId: string;
  /** The node this decision authorises, and nothing else. */
  readonly nodeId: string;
  readonly effect: string;
  /** Covers run, node, effect and artifact fingerprint. */
  readonly effectHash: string;
  readonly policyId: string;
  readonly approvers: readonly string[];
  readonly expiresAt: string;
}

export interface ApprovalRecord extends ApprovalRequest {
  readonly approvalId: string;
  readonly status: ApprovalStatus;
  readonly decidedBy?: string | undefined;
  readonly decidedAt?: string | undefined;
  readonly reason?: string | undefined;
  readonly createdAt: string;
}

export interface ApprovalPort {
  request(request: ApprovalRequest): Promise<ApprovalRecord>;
  /**
   * Records a decision. Single-use by contract: a second decision on the same
   * approval must be a no-op, so at-least-once delivery cannot reverse an
   * outcome or authorise an action twice (006 §8).
   */
  decide(
    approvalId: string,
    decision: ApprovalDecision,
    principal: string,
  ): Promise<ApprovalRecord | undefined>;
  get(approvalId: string): Promise<ApprovalRecord | undefined>;
  getPending(runId: string): Promise<readonly ApprovalRecord[]>;
}
