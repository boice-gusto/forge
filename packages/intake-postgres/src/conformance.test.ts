import { describeIntakeLedgerConformance } from "@forge/intake/ledger-conformance";
import { containerRuntimeAvailable } from "@forge/store-conformance";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe } from "vitest";

import {
  applyIntakeLedgerSchema,
  createPostgresIntakeLedger,
} from "./ledger.js";

const POSTGRES_IMAGE = "postgres:16-alpine";
/** A cold image pull is slow; a hung container should still fail, not wait. */
const CONTAINER_START_TIMEOUT_MS = 240_000;

const dockerAvailable = await containerRuntimeAvailable("intake-postgres");

describe.skipIf(!dockerAvailable)("intake-postgres", () => {
  let container: StartedPostgreSqlContainer;
  let admin: pg.Pool;
  const pools: pg.Pool[] = [];
  let namespaces = 0;

  /**
   * A pool with no error listener takes the process down when the server hangs
   * up on an idle client, which is exactly what stopping the container does.
   * The database going away during teardown is not a test result.
   */
  function track(pool: pg.Pool): pg.Pool {
    pool.on("error", () => {});
    pools.push(pool);
    return pool;
  }

  /**
   * One connection each, released quickly. Pools live until `afterAll`, so
   * they scale with the size of the suite rather than with what any test
   * needs — and the run-store suite has already run this database out of its
   * hundred once.
   */
  function poolFor(schema: string): pg.Pool {
    return track(
      new pg.Pool({
        connectionString: container.getConnectionUri(),
        options: `-c search_path=${schema}`,
        max: 1,
        idleTimeoutMillis: 250,
      }),
    );
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    admin = track(
      new pg.Pool({ connectionString: container.getConnectionUri() }),
    );
  }, CONTAINER_START_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
    await container?.stop();
  });

  describeIntakeLedgerConformance({
    name: "intake-postgres",
    // The reason this adapter exists. Two handles here are two pools onto one
    // database, which is what two control planes have.
    sharedAcrossProcesses: true,
    async create() {
      namespaces += 1;
      const schema = `forge_intake_conformance_${namespaces}`;
      await admin.query(`create schema if not exists ${schema}`);
      const pool = poolFor(schema);
      await applyIntakeLedgerSchema(pool);

      return {
        ledger: createPostgresIntakeLedger(pool),
        async peer() {
          return createPostgresIntakeLedger(poolFor(schema));
        },
      };
    },
  });
});
