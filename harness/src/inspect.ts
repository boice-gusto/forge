import pg from "pg";

/**
 * The durable state, read straight out of Postgres.
 *
 * Every chaos assertion that matters is made here rather than through the API,
 * for two reasons. The control plane rehydrates a run before answering, so
 * asking it "what happened" can advance the very thing being measured. And the
 * question a chaos test needs answered — *was the effect claimed but never
 * performed?* — has no route: it is the difference between a row in
 * `forge_run_effect` and a row in `forge_run_value`, and only one of those is
 * visible from outside.
 */

export interface EffectRow {
  readonly nodeId: string;
  readonly effect: string;
  readonly input: unknown;
  readonly dispatchedAt: string;
}

export interface ValueRow {
  readonly nodeId: string;
  readonly produced: boolean;
  readonly value: unknown;
}

export class Inspector {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
    this.pool.on("error", () => {});
  }

  /**
   * Whether Forge has ever written to this database.
   *
   * The disaster drill needs to prove the replacement database is empty before
   * it restores into it, and "empty" there means the schema does not exist at
   * all — a query against `forge_run` errors rather than returning no rows.
   */
  async schemaExists(): Promise<boolean> {
    const { rows } = await this.pool.query<{ present: string | null }>(
      "select to_regclass('forge_run')::text as present",
    );
    return rows[0]?.present !== null;
  }

  async record(runId: string): Promise<Record<string, unknown> | undefined> {
    const { rows } = await this.pool.query<{ record: Record<string, unknown> }>(
      "select record from forge_run where run_id = $1",
      [runId],
    );
    return rows[0]?.record;
  }

  async effects(runId: string): Promise<readonly EffectRow[]> {
    const { rows } = await this.pool.query<{
      node_id: string;
      effect: string;
      input: unknown;
      dispatched_at: string;
    }>(
      `select node_id, effect, input, dispatched_at
         from forge_run_effect where run_id = $1 order by seq`,
      [runId],
    );
    return rows.map((row) => ({
      nodeId: row.node_id,
      effect: row.effect,
      input: row.input,
      dispatchedAt: row.dispatched_at,
    }));
  }

  async values(runId: string): Promise<readonly ValueRow[]> {
    const { rows } = await this.pool.query<{
      node_id: string;
      produced: boolean;
      value: unknown;
    }>(
      `select node_id, produced, value from forge_run_value
         where run_id = $1 order by node_id`,
      [runId],
    );
    return rows.map((row) => ({
      nodeId: row.node_id,
      produced: row.produced,
      value: row.value,
    }));
  }

  /** Every run the store holds at PENDING — created, never walked. */
  async pending(): Promise<readonly string[]> {
    const { rows } = await this.pool.query<{ run_id: string }>(
      "select run_id from forge_run where record->>'status' = 'PENDING'",
    );
    return rows.map((row) => row.run_id);
  }

  async effectsFor(runIds: readonly string[]): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      "select count(*)::text as count from forge_run_effect where run_id = any($1)",
      [runIds],
    );
    return Number.parseInt(rows[0]?.count ?? "0", 10);
  }

  /** Every effect row across every run — the global "how many actions fired". */
  async totalEffects(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      "select count(*)::text as count from forge_run_effect",
    );
    return Number.parseInt(rows[0]?.count ?? "0", 10);
  }

  async approvals(
    runId: string,
  ): Promise<
    readonly { approvalId: string; status: string; decidedAt?: string }[]
  > {
    const { rows } = await this.pool.query<{
      approval_id: string;
      status: string;
      decided_at: string | null;
    }>(
      `select approval_id, status, decided_at from forge_approval
         where run_id = $1 order by seq`,
      [runId],
    );
    return rows.map((row) => ({
      approvalId: row.approval_id,
      status: row.status,
      ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
    }));
  }

  /** When each of one run's effects was dispatched, and when it settled. */
  async settlement(runId: string): Promise<unknown> {
    const { rows } = await this.pool.query(
      `select node_id, dispatched_at, settled_at from forge_run_effect where run_id = $1`,
      [runId],
    );
    return rows;
  }

  /**
   * Runs holding an action claimed and never settled.
   *
   * The direct answer, from the column the product writes. Prefer it to
   * {@link claimedButUnperformed}, which infers the same thing from a missing
   * value row — a proxy that was the best available before effects recorded
   * their own completion, and which now reports a false positive for any
   * action that legitimately produces nothing.
   */
  async unsettled(): Promise<readonly string[]> {
    const { rows } = await this.pool.query<{ run_id: string }>(
      `select distinct run_id from forge_run_effect where settled_at is null`,
    );
    return rows.map((row) => row.run_id);
  }

  /**
   * A run whose approved effect was claimed and never carried out.
   *
   * There is no product surface for this. It is the signature a crash between
   * the durable claim and the action leaves behind, and an operator who cannot
   * see it has a run that will sit at RUNNING forever with a human's decision
   * spent on nothing.
   */
  async claimedButUnperformed(): Promise<readonly string[]> {
    const { rows } = await this.pool.query<{ run_id: string }>(
      `select distinct e.run_id
         from forge_run_effect e
         left join forge_run_value v
           on v.run_id = e.run_id and v.node_id = e.node_id
        where v.node_id is null`,
    );
    return rows.map((row) => row.run_id);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
