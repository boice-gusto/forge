import type { RunEvent, RunEventStorePort } from "@forge/observability";
import type { Pool } from "pg";

interface EventRow {
  /** `bigint` arrives as a string from `pg`, so it is narrowed on the way out. */
  readonly seq: string;
  readonly run_id: string;
  readonly kind: RunEvent["kind"];
  readonly name: string;
  readonly at: string;
  readonly attributes: RunEvent["attributes"];
}

/**
 * `RunEventStorePort` over Postgres. This is what makes a run's timeline
 * durable rather than a fact one process happens to remember: after a restart,
 * or from a control plane that never started the run, the operator still reads
 * what happened.
 *
 * The pool is supplied by the composition root, which is also where the
 * connection string is read from the environment. This package never names a
 * host or a credential.
 */
export function createPostgresRunEventStore(pool: Pool): RunEventStorePort {
  return {
    async append(input) {
      const { rows } = await pool.query<{ readonly seq: string }>(
        `insert into forge_run_event_log (run_id, kind, name, at, attributes)
         values ($1, $2, $3, $4, $5)
         returning seq`,
        [
          input.runId,
          input.kind,
          input.name,
          input.at,
          JSON.stringify(input.attributes),
        ],
      );
      return Number(rows[0]?.seq);
    },

    async close(seq, attributes) {
      // `||` merges right over left, so a closing `status` replaces the opening
      // one — and the row keeps its sequence, so the span stays where it opened
      // rather than jumping to the end of the timeline.
      await pool.query(
        `update forge_run_event_log
            set attributes = attributes || $2::jsonb
          where seq = $1`,
        [seq, JSON.stringify(attributes)],
      );
    },

    async list(runId) {
      const { rows } = await pool.query<EventRow>(
        `select seq, run_id, kind, name, at, attributes
           from forge_run_event_log
          where run_id = $1
          order by seq`,
        [runId],
      );
      return rows.map(
        (row): RunEvent => ({
          seq: Number(row.seq),
          runId: row.run_id,
          kind: row.kind,
          name: row.name,
          at: row.at,
          attributes: row.attributes,
        }),
      );
    },
  };
}
