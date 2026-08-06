import type { Pool } from "pg";

/**
 * The whole schema, in one idempotent block.
 *
 * Deliberately not a migration framework: there are four tables, and an
 * operator who can read this file can also apply it with `psql`. Object names
 * are unqualified so the caller chooses the schema with `search_path`. The one
 * `alter table` is there for the same reason — a column added after the fact
 * still has to arrive on a database that already exists.
 *
 * The record is one `jsonb` document rather than a column per field. Its
 * optional halves — `pendingApprovalId`, `error`, `result` — are meaningfully
 * *absent* rather than null, and a run result may itself be JSON `null`; a
 * column each would need a companion boolean each to say so. The document is
 * rewritten whole from the runtime's single transition point, so there is no
 * partial update for it to lose.
 */
export const RUN_STORE_SCHEMA_SQL = `
create sequence if not exists forge_run_seq;

create table if not exists forge_run (
  run_id       text primary key,
  -- Creation order, from a sequence rather than a clock. "Most recent first"
  -- has to be a total order: two runs starting in the same millisecond would
  -- tie on a timestamp, and a tie is a run that moves between two reads.
  seq          bigint not null default nextval('forge_run_seq'),
  record       jsonb not null,
  -- Bumped on every record write, and presented back by whoever writes. A
  -- blind \`update ... where run_id = $1\` is a lost update, and what it loses
  -- is \`status\` and \`pendingApprovalId\` — a run left waiting on an approval
  -- nothing will look for.
  revision     bigint not null default 1,
  artifact     jsonb not null,
  capabilities jsonb not null,
  changed_paths jsonb not null
);

-- For a database created before the column existed. \`nextval\` is volatile, so
-- each existing row is backfilled with a distinct value rather than all
-- sharing one; the relative order of rows already there is whatever the rewrite
-- reads them in, which is the best that can be said after the fact.
alter table forge_run add column if not exists seq bigint not null default nextval('forge_run_seq');

-- For a database created before optimistic concurrency existed. Every existing
-- row starts at 1, which is correct: nothing has presented a revision for them
-- yet, so nothing holds a stale one.
alter table forge_run add column if not exists revision bigint not null default 1;

create index if not exists forge_run_by_seq on forge_run (seq desc);

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
  -- When the action came back. Null is the window this column exists to make
  -- visible: claimed, and never seen to finish.
  settled_at    text,

  -- One dispatch per node per run. Stated where the row lives, because two
  -- workers racing a resume cannot be stopped by a check in JavaScript.
  constraint forge_run_effect_once unique (run_id, node_id)
);

-- For a database created before settlement was recorded. Existing rows are
-- left null rather than backfilled: nothing knows whether those actions
-- completed, and inventing a settlement time would answer the one question
-- this column is for.
alter table forge_run_effect add column if not exists settled_at text;

create index if not exists forge_run_effect_by_run
  on forge_run_effect (run_id, seq);

-- Partial, because the interesting rows are the rare ones and a full index on
-- a column that is almost always set would be mostly dead weight.
create index if not exists forge_run_effect_unsettled
  on forge_run_effect (dispatched_at) where settled_at is null;
`;

/** Applies {@link RUN_STORE_SCHEMA_SQL}. Safe to run on every boot. */
export async function applyRunStoreSchema(pool: Pool): Promise<void> {
  await pool.query(RUN_STORE_SCHEMA_SQL);
}
