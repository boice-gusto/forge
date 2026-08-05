import type { CheckpointRecord, CheckpointStorePort } from "@forge/ports";
import type { Pool } from "pg";

interface CheckpointRow {
  readonly checkpoint_id: string;
  readonly run_id: string;
  readonly step_id: string;
  readonly state_version: number;
  readonly resume_token: string;
}

const COLUMNS = "checkpoint_id, run_id, step_id, state_version, resume_token";

function toRecord(row: CheckpointRow): CheckpointRecord {
  return {
    checkpointId: row.checkpoint_id,
    runId: row.run_id,
    stepId: row.step_id,
    stateVersion: row.state_version,
    resumeToken: row.resume_token,
  };
}

/**
 * `CheckpointStorePort` over Postgres. Forge-level metadata only (006 §6.3) —
 * engine state blobs stay inside the engine adapter, so nothing here needs to
 * know what a graph is.
 *
 * The pool is supplied by the composition root, which is also where the
 * connection string is read from the environment. This package never names a
 * host or a credential.
 */
export function createPostgresCheckpointStore(pool: Pool): CheckpointStorePort {
  return {
    async save(input) {
      // One sequence supplies both the ordering key and the identifier, drawn
      // once in a CTE so the two cannot drift apart.
      const { rows } = await pool.query<CheckpointRow>(
        `with issued as (select nextval('forge_checkpoint_seq') as seq)
         insert into forge_checkpoint (seq, checkpoint_id, run_id, step_id, state_version, resume_token)
         select seq, 'checkpoint_' || seq, $1, $2, $3, $4 from issued
         returning ${COLUMNS}`,
        [input.runId, input.stepId, input.stateVersion, input.resumeToken],
      );

      const saved = rows[0];
      if (saved === undefined) {
        throw new Error("FORGE_CHECKPOINT_NOT_WRITTEN");
      }
      return toRecord(saved);
    },

    async load(checkpointId) {
      const { rows } = await pool.query<CheckpointRow>(
        `select ${COLUMNS} from forge_checkpoint where checkpoint_id = $1`,
        [checkpointId],
      );
      const found = rows[0];
      return found === undefined ? undefined : toRecord(found);
    },

    async listByRun(runId) {
      const { rows } = await pool.query<CheckpointRow>(
        `select ${COLUMNS} from forge_checkpoint where run_id = $1 order by seq`,
        [runId],
      );
      return rows.map(toRecord);
    },
  };
}
