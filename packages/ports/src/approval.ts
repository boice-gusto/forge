/**
 * First-class human gate protocol (006 §6.4): a durable record with approvers,
 * an expiry, and a binding to one exact action — not an engine interrupt
 * wearing a Forge label.
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

/**
 * The failures an approval store raises, as codes rather than prose — control
 * flow across a package boundary, in the same form as `RUN_STORE_ERRORS` and
 * for the same reason.
 */
export const APPROVAL_ERRORS = {
  /**
   * `request` wrote no row. The run is about to park on a gate that does not
   * exist, so this has to be loud: a swallowed failure here leaves a run
   * waiting forever on an approval no inbox will ever list and no decision can
   * ever clear.
   */
  notOpened: "FORGE_APPROVAL_NOT_OPENED",
} as const;

export type ApprovalErrorCode =
  (typeof APPROVAL_ERRORS)[keyof typeof APPROVAL_ERRORS];

export interface ApprovalPort {
  request(request: ApprovalRequest): Promise<ApprovalRecord>;
  /**
   * Single-use by contract: a second decision must be a no-op, so at-least-once
   * delivery cannot reverse an outcome or authorise an action twice (006 §8).
   */
  decide(
    approvalId: string,
    decision: ApprovalDecision,
    principal: string,
  ): Promise<ApprovalRecord | undefined>;
  get(approvalId: string): Promise<ApprovalRecord | undefined>;
  getPending(runId: string): Promise<readonly ApprovalRecord[]>;
  /** Every gate this run opened, decided ones included, oldest first. */
  listByRun(runId: string): Promise<readonly ApprovalRecord[]>;
  /**
   * Pending gates across every run: the operator inbox. A gate naming nobody is
   * open to any authenticated operator, so it cannot stall unseen.
   */
  listPendingFor(
    principal: string,
    /**
     * Roles the caller holds. A rule's `approvers` names *roles*, not people,
     * so membership is resolved at the authenticated boundary and never taken
     * from the request.
     */
    roles?: readonly string[],
  ): Promise<readonly ApprovalRecord[]>;
}

/**
 * Stands for "every role", for a deployment with no directory to ask. One
 * shared admin token is one trust tier: hiding a gate named `marketing-lead`
 * from the only operator there is would stall the run behind a decision nobody
 * could see.
 */
export const ANY_ROLE = "*";
