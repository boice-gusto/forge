import type { Pool } from "pg";

/**
 * The whole schema, in one idempotent block.
 *
 * The constraints are the point. Two API processes can deliver a decision at
 * the same instant, so what a gate may become is stated where the row lives
 * rather than in whichever process happens to read it first. Object names are
 * unqualified so the caller chooses the schema with `search_path`.
 */
export const APPROVAL_SCHEMA_SQL = `
create sequence if not exists forge_approval_seq;

create table if not exists forge_approval (
  seq         bigint primary key default nextval('forge_approval_seq'),
  approval_id text   not null unique,
  run_id      text   not null,
  node_id     text   not null,
  effect      text   not null,
  effect_hash text   not null,
  policy_id   text   not null,
  approvers   text[] not null,
  -- ISO-8601 strings rather than timestamptz: the port types these as strings
  -- and the runtime compares them verbatim, so a round trip that reformats
  -- one would move a deadline or break a comparison.
  expires_at  text   not null,
  status      text   not null,
  decided_by  text,
  decided_at  text,
  reason      text,
  created_at  text   not null,

  constraint forge_approval_status_known check (
    status in ('PENDING', 'APPROVED', 'REJECTED', 'EDITED', 'TIMED_OUT')
  ),
  -- A decided gate says who decided it and when; a pending one says neither.
  -- Without this a half-written row could be terminal but unattributable,
  -- which is an effect nobody can be shown to have authorised.
  constraint forge_approval_decision_attributed check (
    (status = 'PENDING') = (decided_at is null)
    and (decided_at is null) = (decided_by is null)
  ),
  -- A reason is the rejection's; it cannot be attached to a yes.
  constraint forge_approval_reason_is_a_rejection check (
    reason is null or status = 'REJECTED'
  )
);

create index if not exists forge_approval_pending_by_run
  on forge_approval (run_id, seq)
  where status = 'PENDING';
`;

/** Applies {@link APPROVAL_SCHEMA_SQL}. Safe to run on every boot. */
export async function applyApprovalSchema(pool: Pool): Promise<void> {
  await pool.query(APPROVAL_SCHEMA_SQL);
}
