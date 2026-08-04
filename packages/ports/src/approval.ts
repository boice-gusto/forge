export type ApprovalProposalInput = {
  readonly approvalId: string;
  readonly runId: string;
  readonly effectHash: string;
  readonly expiresAt: string;
};

export type ApprovalProposal = ApprovalProposalInput;

export interface ApprovalPort {
  create(proposal: ApprovalProposal): Promise<ApprovalProposal>;
}

export function createApprovalProposal(
  input: ApprovalProposalInput,
): ApprovalProposal {
  return { ...input };
}
