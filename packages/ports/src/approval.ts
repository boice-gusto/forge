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
  /**
   * Every gate this run opened, decided ones included, oldest first. A run
   * inspector that could only see `PENDING` could not show that a gate was
   * refused — and a refusal is the outcome most worth being able to audit.
   */
  listByRun(runId: string): Promise<readonly ApprovalRecord[]>;
  /**
   * Pending gates across every run: the operator inbox. Scoped to a principal
   * because a gate names its approvers, and an inbox that ignored them would
   * hand one operator another's queue. A gate that names nobody is open to any
   * authenticated operator — otherwise it would be visible to no one and the
   * run would stall behind a decision nobody could see they had to make.
   */

  listPendingFor(
    principal: string,
    /**
     * Roles the caller holds. A policy rule's `approvers` names *roles*
     * (`marketing-lead`), not people, so matching them against a principal
     * identity alone finds nothing — an inbox that silently showed no work is
     * worse than no inbox. Membership is resolved at the authenticated
     * boundary, never taken from the request.
     */
    roles?: readonly string[],
  ): Promise<readonly ApprovalRecord[]>;
}

/**
 * Stands for "every role", for a deployment with no directory to ask.
 *
 * A single shared admin token is one trust tier: refusing to show a gate named
 * `marketing-lead` would hide work from the only operator there is, and the run
 * would stall behind a decision nobody could see. Declared here rather than
 * left as a magic string, so a store must implement it deliberately and a
 * reader can find every place it is honoured.
 */
export const ANY_ROLE = "*";
