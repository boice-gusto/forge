# @forge/approval-postgres

`ApprovalPort` (006 §6.4) over Postgres. Durable human gates: a pending
approval survives a worker restart, which is what `AWAITING_APPROVAL` being
first-class durable state actually requires.

## Wiring

The adapter takes a `pg.Pool`; the composition root owns the connection and
therefore the credential. **No connection string, host, or password appears in
this package.**

```ts
import { Pool } from "pg";
import { createFixedClock, createSequentialIds } from "@forge/ports";
import { applyApprovalSchema, createPostgresApprovalStore } from "@forge/approval-postgres";

const url = process.env.FORGE_DATABASE_URL;
if (url === undefined) throw new Error("FORGE_DATABASE_URL is not set");

const pool = new Pool({ connectionString: url });
await applyApprovalSchema(pool); // idempotent; safe on every boot
const approvals = createPostgresApprovalStore(pool, clock, ids);
```

## Schema

One table, one sequence, stated in `src/schema.ts` as `APPROVAL_SCHEMA_SQL`.
It is idempotent (`create … if not exists`), so `applyApprovalSchema` can run
on every boot, or an operator can apply the same SQL with `psql`. Object names
are unqualified, so the schema is chosen by `search_path` — one database can
host more than one Forge deployment.

There is deliberately no migration framework. When the table needs to change,
that is the moment to add one, not before.

## Why the constraints matter

Single use is enforced by the database, not by application code:

```sql
update forge_approval set … where approval_id = $1 and status = 'PENDING'
```

Postgres re-evaluates that predicate under the row lock, so of two API
processes delivering a decision at the same instant exactly one writes and the
other reads back the decision that stands. A check-then-write in JavaScript
does not survive two processes; the conformance suite's race test fails against
one.

The table also refuses, at the row level, a status outside the five the port
declares, a terminal gate with no decider or timestamp, and a reason attached
to anything but a rejection.

## Tests

`src/conformance.test.ts` runs `@forge/store-conformance` against a real
Postgres started with Testcontainers. With no container runtime reachable the
suite **skips loudly** and the adapter is unverified — see the CI notes in the
repository root for the job that must run it.
