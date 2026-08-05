# @forge/checkpoint-postgres

`CheckpointStorePort` (006 §6.3) over Postgres. Forge-level checkpoint metadata
only — engine state blobs stay inside the engine adapter, so nothing here knows
what a graph is.

## Wiring

The adapter takes a `pg.Pool`; the composition root owns the connection and
therefore the credential. **No connection string, host, or password appears in
this package.**

```ts
import { Pool } from "pg";
import {
  applyCheckpointSchema,
  createPostgresCheckpointStore,
} from "@forge/checkpoint-postgres";

const url = process.env.FORGE_DATABASE_URL;
if (url === undefined) throw new Error("FORGE_DATABASE_URL is not set");

const pool = new Pool({ connectionString: url });
await applyCheckpointSchema(pool); // idempotent; safe on every boot
const checkpoints = createPostgresCheckpointStore(pool);
```

## Schema

One table and one sequence, stated in `src/schema.ts` as
`CHECKPOINT_SCHEMA_SQL`. It is idempotent (`create … if not exists`), so
`applyCheckpointSchema` can run on every boot, or an operator can apply the
same SQL with `psql`. Object names are unqualified, so the schema is chosen by
`search_path`.

The sequence supplies both the ordering key and the checkpoint id, drawn once
per insert, so `listByRun` returning oldest-first is a fact about the row
rather than about the clock of whichever process wrote it.

## Tests

`src/conformance.test.ts` runs `@forge/store-conformance` against a real
Postgres started with Testcontainers. With no container runtime reachable the
suite **skips loudly** and the adapter is unverified.
