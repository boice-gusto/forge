import type {
  DispatchedEffect,
  JsonValue,
  PinnedRoute,
  PinnedValue,
  RunRecord,
  RunStorePort,
  StoredArtifact,
} from "@forge/ports";
import type { Pool } from "pg";

interface RunRow {
  readonly record: RunRecord;
  /** `bigint` arrives as a string from `pg`; narrowed at the boundary. */
  readonly revision: string;
  readonly artifact: StoredArtifact;
  readonly capabilities: readonly string[];
  readonly changed_paths: readonly string[];
}

interface ValueRow {
  readonly node_id: string;
  readonly produced: boolean;
  readonly value: JsonValue | null;
}

interface RouteRow {
  readonly node_id: string;
  readonly arm: string;
}

interface EffectRow {
  readonly node_id: string;
  readonly effect: string;
  readonly input: JsonValue | null;
  readonly has_input: boolean;
  readonly dispatched_at: string;
}

/** `undefined` is absent; anything else, JSON null included, is a value. */
const asJson = (value: JsonValue | undefined): string | null =>
  value === undefined ? null : JSON.stringify(value);

/**
 * `RunStorePort` over Postgres. This is what makes `AWAITING_APPROVAL` durable
 * state rather than a fact one process happens to remember (006 §5): a second
 * process reads the record, the pinned values, the routes and the effect
 * ledger, and re-enters the run without re-invoking anything.
 *
 * The pool is supplied by the composition root, which is also where the
 * connection string is read from the environment. This package never names a
 * host or a credential.
 */
export function createPostgresRunStore(pool: Pool): RunStorePort {
  return {
    async create(input) {
      // No upsert. A duplicate run id is a collision, not an update.
      await pool.query(
        `insert into forge_run (run_id, record, artifact, capabilities, changed_paths)
         values ($1, $2, $3, $4, $5)`,
        [
          input.record.runId,
          JSON.stringify(input.record),
          JSON.stringify(input.artifact),
          JSON.stringify(input.capabilities),
          JSON.stringify(input.changedPaths),
        ],
      );
    },

    async load(runId) {
      const run = await pool.query<RunRow>(
        `select record, revision, artifact, capabilities, changed_paths
           from forge_run where run_id = $1`,
        [runId],
      );
      const found = run.rows[0];
      if (found === undefined) return undefined;

      const [values, routes, effects] = await Promise.all([
        pool.query<ValueRow>(
          `select node_id, produced, value from forge_run_value
             where run_id = $1 order by node_id`,
          [runId],
        ),
        pool.query<RouteRow>(
          `select node_id, arm from forge_run_route
             where run_id = $1 order by node_id`,
          [runId],
        ),
        pool.query<EffectRow>(
          `select node_id, effect, input, has_input, dispatched_at
             from forge_run_effect where run_id = $1 order by seq`,
          [runId],
        ),
      ]);

      return {
        record: found.record,
        revision: Number(found.revision),
        artifact: found.artifact,
        capabilities: found.capabilities,
        changedPaths: found.changed_paths,
        values: values.rows.map(
          (row): PinnedValue =>
            // `produced` is the whole reason the column exists: without it a
            // node that produced JSON null and one that produced nothing read
            // identically, and a rehydrated run would invoke the second again.
            row.produced
              ? { nodeId: row.node_id, value: row.value }
              : { nodeId: row.node_id },
        ),
        routes: routes.rows.map(
          (row): PinnedRoute => ({ nodeId: row.node_id, arm: row.arm }),
        ),
        effects: effects.rows.map(
          (row): DispatchedEffect => ({
            nodeId: row.node_id,
            effect: row.effect,
            ...(row.has_input ? { input: row.input } : {}),
            dispatchedAt: row.dispatched_at,
          }),
        ),
      };
    },

    async list(query) {
      // Ordered by the creation sequence, descending. `record` is the whole
      // document, so the status filter reads it out of the same row rather
      // than from a second column that could disagree with it.
      const status = query?.status;
      const { rows } = await pool.query<{ readonly record: RunRecord }>(
        status === undefined
          ? `select record from forge_run order by seq desc`
          : `select record from forge_run where record->>'status' = $1 order by seq desc`,
        status === undefined ? [] : [status],
      );
      return rows.map((row) => row.record);
    },

    async update(record, expectedRevision) {
      /**
       * One statement, so the compare and the write cannot be separated by
       * another writer. Two queries with a check between them would be the bug
       * this exists to prevent, wearing the costume of the fix.
       */
      const { rows } = await pool.query<{ revision: string }>(
        `update forge_run
            set record = $2, revision = revision + 1
          where run_id = $1 and revision = $3
      returning revision`,
        [record.runId, JSON.stringify(record), expectedRevision],
      );
      const updated = rows[0];
      if (updated !== undefined) return Number(updated.revision);

      // No row changed: either the run is not there, or it moved on. Reading
      // afterwards to tell those apart is not a race — both answers are
      // already final, and neither is the write succeeding.
      const { rows: current } = await pool.query<{ revision: string }>(
        `select revision from forge_run where run_id = $1`,
        [record.runId],
      );
      const existing = current[0];
      if (existing === undefined) {
        throw new Error(`FORGE_RUN_NOT_FOUND: ${record.runId}`);
      }
      throw new Error(
        `FORGE_RUN_CONFLICT: ${record.runId} is at revision ${existing.revision}, not ${expectedRevision}.`,
      );
    },

    async pinValue(runId, nodeId, value) {
      // First write wins. A value a human approved must not be overwritten by
      // one computed later, so the refusal lives in the statement.
      await pool.query(
        `insert into forge_run_value (run_id, node_id, produced, value)
         values ($1, $2, $3, $4)
         on conflict (run_id, node_id) do nothing`,
        [runId, nodeId, value !== undefined, asJson(value)],
      );
    },

    async pinRoute(runId, nodeId, arm) {
      await pool.query(
        `insert into forge_run_route (run_id, node_id, arm)
         values ($1, $2, $3)
         on conflict (run_id, node_id) do nothing`,
        [runId, nodeId, arm],
      );
    },

    async claimEffect(claim) {
      const { rows } = await pool.query<{ readonly seq: string }>(
        `insert into forge_run_effect (run_id, node_id, effect, input, has_input, dispatched_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict on constraint forge_run_effect_once do nothing
         returning seq`,
        [
          claim.runId,
          claim.nodeId,
          claim.effect,
          asJson(claim.input),
          claim.input !== undefined,
          claim.at,
        ],
      );
      return rows.length === 1;
    },
  };
}
