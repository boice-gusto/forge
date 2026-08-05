import type {
  ApprovalDecision,
  ApprovalPort,
  ApprovalRecord,
  ApprovalRequest,
  ApprovalStatus,
  ClockPort,
  IdPort,
} from "@forge/ports";
import { ANY_ROLE } from "@forge/ports";

const TERMINAL: Record<string, ApprovalStatus> = {
  approve: "APPROVED",
  reject: "REJECTED",
  edit: "EDITED",
  timeout: "TIMED_OUT",
};

export function createMemoryApprovalStore(
  clock: ClockPort,
  ids: IdPort,
): ApprovalPort {
  const records = new Map<string, ApprovalRecord>();

  return {
    async request(request: ApprovalRequest) {
      const approvalId = ids.next("approval");
      const record: ApprovalRecord = {
        ...request,
        approvalId,
        status: "PENDING",
        createdAt: clock.now().toISOString(),
      };
      records.set(approvalId, record);
      return record;
    },

    async decide(
      approvalId: string,
      decision: ApprovalDecision,
      principal: string,
    ) {
      const existing = records.get(approvalId);
      if (existing === undefined) return undefined;
      // Single-use. A repeat delivery must not reverse an outcome.
      if (existing.status !== "PENDING") return existing;

      const decided: ApprovalRecord = {
        ...existing,
        status: TERMINAL[decision.kind] ?? "PENDING",
        decidedBy: principal,
        decidedAt: clock.now().toISOString(),
        reason: decision.kind === "reject" ? decision.reason : undefined,
      };
      records.set(approvalId, decided);
      return decided;
    },

    async get(approvalId: string) {
      return records.get(approvalId);
    },

    async getPending(runId: string) {
      return [...records.values()].filter(
        (record) => record.runId === runId && record.status === "PENDING",
      );
    },

    async listByRun(runId: string) {
      // Insertion order is creation order, so the run reads chronologically.
      return [...records.values()].filter((record) => record.runId === runId);
    },

    async listPendingFor(principal: string, roles: readonly string[] = []) {
      const held = new Set([principal, ...roles]);
      const seesEverything = held.has(ANY_ROLE);
      return [...records.values()].filter(
        (record) =>
          record.status === "PENDING" &&
          (seesEverything ||
            record.approvers.length === 0 ||
            record.approvers.some((approver) => held.has(approver))),
      );
    },
  };
}
