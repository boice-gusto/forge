import type { IntakeLedgerPort } from "@forge/intake";
import type { Pool } from "pg";

/**
 * The intake ledger, in Postgres, so a fleet deduplicates rather than each
 * process deduplicating for itself.
 *
 * Object names are unqualified so the caller chooses the schema with
 * `search_path`, as the run store does.
 */
export const INTAKE_LEDGER_SCHEMA_SQL = `
create table if not exists forge_intake (
  channel     text not null,
  external_id text not null,
  claimed_at  timestamptz not null default now(),

  -- The whole mechanism. Uniqueness is the *database's* to enforce, because
  -- two control planes receiving the same webhook retry in the same
  -- millisecond cannot be separated by a check in JavaScript — both would
  -- read "not seen" and both would proceed.
  primary key (channel, external_id)
);

-- Deliveries age out of usefulness but not out of danger: a sender that
-- retries a week later still must not start a second run. Kept, and indexed
-- by time so an operator can see intake volume and a future retention policy
-- has something to sort on.
create index if not exists forge_intake_by_time on forge_intake (claimed_at desc);
`;

export async function applyIntakeLedgerSchema(pool: Pool): Promise<void> {
  await pool.query(INTAKE_LEDGER_SCHEMA_SQL);
}

export function createPostgresIntakeLedger(pool: Pool): IntakeLedgerPort {
  return {
    async claim(channel, externalId) {
      /**
       * One statement, and the answer is whether *this* insert created the
       * row. `on conflict do nothing` returns no rows when it did not, which
       * is the same fact the primary key already decided — so the race is
       * resolved by the index rather than by anything here.
       *
       * A `select` followed by an `insert` would be the bug this exists to
       * prevent, wearing the costume of the fix.
       */
      const { rows } = await pool.query(
        `insert into forge_intake (channel, external_id)
         values ($1, $2)
         on conflict (channel, external_id) do nothing
         returning 1 as claimed`,
        [channel, externalId],
      );
      return rows.length === 1;
    },
  };
}
