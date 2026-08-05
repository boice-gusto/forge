import type { Pool } from "pg";

/**
 * The whole schema, in one idempotent block.
 *
 * Deliberately not a migration framework: there are four tables, and an
 * operator who can read this file can also apply it with `psql`. Object names
 * are unqualified so the caller chooses the schema with `search_path`.
 *
 * The record is one `jsonb` document rather than a column per field. Its
 * optional halves — `pendingApprovalId`, `error`, `result` — are meaningfully
 * *absent* rather than null, and a run result may itself be JSON `null`; a
 * column each would need a companion boolean each to say so. The document is
 * rewritten whole from the runtime's single transition point, so there is no
 * partial update for it to lose.
 */
export const RUN_STORE_SCHEMA_SQL = `
create table if not exists forge_run (
  run_id       text primary key,
  record       jsonb not null,
  artifact     jsonb not null,
  capabilities jsonb not null,
  changed_paths jsonb not null
);

create table if not exists forge_run_value (
  run_id   text not null references forge_run (run_id),
  node_id  text not null,
  -- False means the node ran and produced nothing. Kept as its own column
  -- because a produced value may itself be JSON null, and the two must not
  -- read the same: one is "nothing to read", the other is a value.
  produced boolean not null,
  value    jsonb,
  primary key (run_id, node_id)
);

create table if not exists forge_run_route (
  run_id  text not null references forge_run (run_id),
  node_id text not null,
  arm     text not null,
  primary key (run_id, node_id)
);

create sequence if not exists forge_run_effect_seq;

create table if not exists forge_run_effect (
  -- Ordering key and identity from the same sequence, so "dispatch order" is a
  -- fact about the row rather than about the clock that wrote it.
  seq           bigint primary key default nextval('forge_run_effect_seq'),
  run_id        text not null references forge_run (run_id),
  node_id       text not null,
  effect        text not null,
  -- What the action was performed *on*, so an audit can show that the action
  -- dispatched is the action the approver saw.
  input         jsonb,
  has_input     boolean not null,
  dispatched_at text not null,

  -- One dispatch per node per run. Stated where the row lives, because two
  -- workers racing a resume cannot be stopped by a check in JavaScript.
  constraint forge_run_effect_once unique (run_id, node_id)
);

create index if not exists forge_run_effect_by_run
  on forge_run_effect (run_id, seq);
`;

/** Applies {@link RUN_STORE_SCHEMA_SQL}. Safe to run on every boot. */
export async function applyRunStoreSchema(pool: Pool): Promise<void> {
  await pool.query(RUN_STORE_SCHEMA_SQL);
}
