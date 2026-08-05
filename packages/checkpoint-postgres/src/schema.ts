import type { Pool } from "pg";

/**
 * The whole schema, in one idempotent block.
 *
 * Deliberately not a migration framework: there is one table, and an operator
 * who can read this file can also apply it with `psql`. Object names are
 * unqualified so the caller chooses the schema with `search_path`.
 */
export const CHECKPOINT_SCHEMA_SQL = `
create sequence if not exists forge_checkpoint_seq;

create table if not exists forge_checkpoint (
  -- Ordering key and identifier come from the same sequence, so "oldest
  -- first" is a fact about the row rather than about the clock that wrote it.
  seq           bigint primary key,
  checkpoint_id text    not null unique,
  run_id        text    not null,
  step_id       text    not null,
  state_version integer not null,
  resume_token  text    not null
);

create index if not exists forge_checkpoint_by_run
  on forge_checkpoint (run_id, seq);
`;

/** Applies {@link CHECKPOINT_SCHEMA_SQL}. Safe to run on every boot. */
export async function applyCheckpointSchema(pool: Pool): Promise<void> {
  await pool.query(CHECKPOINT_SCHEMA_SQL);
}
