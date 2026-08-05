import type {
  ApprovalDecision,
  ApprovalPort,
  ApprovalRecord,
  ApprovalStatus,
  ClockPort,
  IdPort,
} from "@forge/ports";
import { ANY_ROLE } from "@forge/ports";
import type { Pool } from "pg";

const TERMINAL: Record<ApprovalDecision["kind"], ApprovalStatus> = {
  approve: "APPROVED",
  reject: "REJECTED",
  edit: "EDITED",
  timeout: "TIMED_OUT",
};

interface ApprovalRow {
  readonly approval_id: string;
  readonly run_id: string;
  readonly node_id: string;
  readonly effect: string;
  readonly effect_hash: string;
  readonly policy_id: string;
  readonly approvers: readonly string[];
  readonly expires_at: string;
  readonly status: ApprovalStatus;
  readonly decided_by: string | null;
  readonly decided_at: string | null;
  readonly reason: string | null;
  readonly created_at: string;
}

const COLUMNS = [
  "approval_id",
  "run_id",
  "node_id",
  "effect",
  "effect_hash",
  "policy_id",
  "approvers",
  "expires_at",
  "status",
  "decided_by",
  "decided_at",
  "reason",
  "created_at",
].join(", ");

function toRecord(row: ApprovalRow): ApprovalRecord {
  return {
    approvalId: row.approval_id,
    runId: row.run_id,
    nodeId: row.node_id,
    effect: row.effect,
    effectHash: row.effect_hash,
    policyId: row.policy_id,
    approvers: row.approvers,
    expiresAt: row.expires_at,
    status: row.status,
    decidedBy: row.decided_by ?? undefined,
    decidedAt: row.decided_at ?? undefined,
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
  };
}

async function readApproval(
  pool: Pool,
  approvalId: string,
): Promise<ApprovalRecord | undefined> {
  const { rows } = await pool.query<ApprovalRow>(
    `select ${COLUMNS} from forge_approval where approval_id = $1`,
    [approvalId],
  );
  const found = rows[0];
  return found === undefined ? undefined : toRecord(found);
}

/**
 * `ApprovalPort` over Postgres — the durable half of the human gate (006 §6.4).
 *
 * Durability is not the interesting part; single use is. Two API processes may
 * deliver a decision for the same gate at the same instant, and a
 * check-then-write in JavaScript cannot stop the second one, so the decision
 * is settled by a conditional `UPDATE` whose predicate Postgres re-evaluates
 * under the row lock. Exactly one caller writes; every other caller reads back
 * the decision that stands.
 *
 * The pool is supplied by the composition root, which is also where the
 * connection string is read from the environment. This package never names a
 * host or a credential.
 */
export function createPostgresApprovalStore(
  pool: Pool,
  clock: ClockPort,
  ids: IdPort,
): ApprovalPort {
  return {
    async request(request) {
      const { rows } = await pool.query<ApprovalRow>(
        `insert into forge_approval
           (approval_id, run_id, node_id, effect, effect_hash, policy_id,
            approvers, expires_at, status, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9)
         returning ${COLUMNS}`,
        [
          ids.next("approval"),
          request.runId,
          request.nodeId,
          request.effect,
          request.effectHash,
          request.policyId,
          [...request.approvers],
          request.expiresAt,
          clock.now().toISOString(),
        ],
      );

      const opened = rows[0];
      if (opened === undefined) {
        throw new Error("FORGE_APPROVAL_NOT_OPENED");
      }
      return toRecord(opened);
    },

    async decide(approvalId, decision, principal) {
      const { rows } = await pool.query<ApprovalRow>(
        `update forge_approval
            set status = $2, decided_by = $3, decided_at = $4, reason = $5
          where approval_id = $1 and status = 'PENDING'
         returning ${COLUMNS}`,
        [
          approvalId,
          TERMINAL[decision.kind],
          principal,
          clock.now().toISOString(),
          decision.kind === "reject" ? decision.reason : null,
        ],
      );

      const decided = rows[0];
      if (decided !== undefined) return toRecord(decided);
      // No row changed: either the gate does not exist, or it was already
      // decided. Both are reported by reading what is actually there, so a
      // repeat delivery is a no-op rather than a reversal.
      return readApproval(pool, approvalId);
    },

    async get(approvalId) {
      return readApproval(pool, approvalId);
    },

    async getPending(runId) {
      const { rows } = await pool.query<ApprovalRow>(
        `select ${COLUMNS} from forge_approval
          where run_id = $1 and status = 'PENDING'
          order by seq`,
        [runId],
      );
      return rows.map(toRecord);
    },

    async listByRun(runId) {
      const { rows } = await pool.query<ApprovalRow>(
        `select ${COLUMNS} from forge_approval where run_id = $1 order by seq`,
        [runId],
      );
      return rows.map(toRecord);
    },

    async listPendingFor(principal, roles = []) {
      const { rows } = await pool.query<ApprovalRow>(
        // A gate that names nobody is open to any authenticated operator;
        // otherwise it would sit in no inbox at all and stall its run.
        `select ${COLUMNS} from forge_approval
          where status = 'PENDING'
            and ($2 or cardinality(approvers) = 0 or approvers && $1::text[])
          order by seq`,
        [[principal, ...roles], roles.includes(ANY_ROLE)],
      );
      return rows.map(toRecord);
    },
  };
}
