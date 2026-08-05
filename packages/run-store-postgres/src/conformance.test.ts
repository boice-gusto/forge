import {
  containerRuntimeAvailable,
  describeRunStoreConformance,
} from "@forge/store-conformance";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe } from "vitest";

import { applyRunStoreSchema } from "./schema.js";
import { createPostgresRunStore } from "./store.js";

const POSTGRES_IMAGE = "postgres:16-alpine";
/** A cold image pull is slow; a hung container should still fail, not wait. */
const CONTAINER_START_TIMEOUT_MS = 240_000;

const dockerAvailable = await containerRuntimeAvailable("run-store-postgres");

describe.skipIf(!dockerAvailable)("run-store-postgres", () => {
  let container: StartedPostgreSqlContainer;
  let admin: pg.Pool;
  const pools: pg.Pool[] = [];
  let namespaces = 0;

  /**
   * A pool with no error listener crashes the process when the server hangs
   * up on an idle client, which is exactly what stopping the container does.
   * The database going away during teardown is not a test result.
   */
  function track(pool: pg.Pool): pg.Pool {
    pool.on("error", () => {});
    pools.push(pool);
    return pool;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    admin = track(
      new pg.Pool({ connectionString: container.getConnectionUri() }),
    );
  }, CONTAINER_START_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    await container?.stop();
  });

  function poolFor(schema: string): pg.Pool {
    return track(
      new pg.Pool({
        connectionString: container.getConnectionUri(),
        options: `-c search_path=${schema}`,
        max: 5,
      }),
    );
  }

  describeRunStoreConformance({
    name: "run-store-postgres",
    async create() {
      // Each store gets its own schema, so "an empty store" means the same
      // thing here as a new Map does for the memory adapter.
      namespaces += 1;
      const schema = `forge_conformance_${namespaces}`;
      await admin.query(`create schema if not exists ${schema}`);

      const pool = poolFor(schema);
      await applyRunStoreSchema(pool);

      return {
        store: createPostgresRunStore(pool),
        // A second pool onto the same schema shares nothing but the database,
        // which is exactly what a second worker process has.
        async peer() {
          return createPostgresRunStore(poolFor(schema));
        },
      };
    },
  });
});
