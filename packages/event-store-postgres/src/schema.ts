import type { Pool } from "pg";

/**
 * One table, in one idempotent block, following `@forge/run-store-postgres`.
 * Object names are unqualified so the caller chooses the schema with
 * `search_path`, and no host or credential is named here or anywhere in this
 * package — the composition root reads those from the environment.
 *
 * **No foreign key to `forge_run`.** The first thing a run records is
 * `forge.run.start`, and the runtime opens that span *before* the run row
 * exists; a reference would refuse the one event that says a run began. The
 * timeline is a log about a run, not a child of it.
 */
export const RUN_EVENT_SCHEMA_SQL = `
create sequence if not exists forge_run_event_log_seq;

create table if not exists forge_run_event_log (
  -- Ordering key and identity from the same sequence. "What happened next" has
  -- to be a total order: two events recorded in the same millisecond would tie
  -- on \`at\`, and a tie is a record that swaps place between two reads.
  seq        bigint primary key default nextval('forge_run_event_log_seq'),
  run_id     text not null,
  kind       text not null,
  name       text not null,
  -- When the recorder saw it, for display. Never for ordering.
  at         text not null,
  -- Already redacted by \`recordRunEvents\`, which is the single writer. This
  -- table stores what it is handed; it does not scrub, so that the proof that
  -- nothing reached it is aimed at the writer rather than at itself.
  attributes jsonb not null
);

create index if not exists forge_run_event_log_by_run
  on forge_run_event_log (run_id, seq);
`;

/** Applies {@link RUN_EVENT_SCHEMA_SQL}. Safe to run on every boot. */
export async function applyRunEventSchema(pool: Pool): Promise<void> {
  await pool.query(RUN_EVENT_SCHEMA_SQL);
}
