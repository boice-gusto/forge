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
        `select record, artifact, capabilities, changed_paths
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

    async update(record) {
      const { rowCount } = await pool.query(
        `update forge_run set record = $2 where run_id = $1`,
        [record.runId, JSON.stringify(record)],
      );
      if (rowCount === 0) {
        throw new Error(`FORGE_RUN_NOT_FOUND: ${record.runId}`);
      }
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
