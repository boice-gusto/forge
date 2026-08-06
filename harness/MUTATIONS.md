# What was broken on purpose, and what caught it

A chaos test that passes the first time has not been tried. Each assertion in
`chaos.scenario.ts` and `disaster-recovery.scenario.ts` that claims an attack
landed was checked by removing the one thing it depends on and confirming the
opposite result. This is the record; the scratch scenario that produced it was
deleted, and every mutation below is reproducible from the description in a few
lines.

Two other agents own `apps/**`, `packages/**` and `docs/**` on this branch, so
none of these mutations edited product source. Where the guard is a database
constraint that turned out to be an advantage: mutating the constraint in the
live database proves the guarantee is enforced by Postgres and not by a check
in JavaScript that a second process would each hold its own copy of.

---

## A — the effect ledger's unique constraint

**Mutation.** In the running database, replace the guard with one that cannot
fire. The name is kept so `on conflict on constraint forge_run_effect_once`
still resolves; the columns become `(run_id, node_id, seq)`, and `seq` is the
table's own primary key, so every claim succeeds.

```sql
alter table forge_run_effect drop constraint forge_run_effect_once;
alter table forge_run_effect add constraint forge_run_effect_once
  unique (run_id, node_id, seq);
```

**Result.** Two processes resuming one decided gate:

```
effects=2 performed=["the copy","the copy"]
```

The customer-visible action fired **twice**, from two processes, on one
approval. `chaos.scenario.ts` → "two workers racing one decided gate" asserts
`effects` has length 1 and that the two sinks performed exactly one action
between them; both are red under this mutation.

Restoring the real constraint afterwards failed, which is the sharpest form of
the same statement:

```
could not create unique index "forge_run_effect_once"
Key (run_id, node_id)=(run_c780990a…, publish) is duplicated.
```

## B — the window between the claim and the action

**Mutation.** Remove `hangOnDispatch` from the harness worker, so the sink
performs instantly. Everything else — the park, the decision, the SIGKILL on the
`dispatching` announcement — is unchanged.

**Result.**

```
values=["intake","publish"]  claimedButUnperformed=[]
```

The kill now lands after the action rather than inside the window, and the
value row exists. `chaos.scenario.ts` → "the claim is durable and the action is
not" asserts the opposite of both, so it is red under this mutation. This is the
check that stops the claim-window tests being the trap this repository has
already found once — a kill that arrives after the work is done proves nothing,
and looks identical in every status-based assertion.

## C — the Postgres outage

**Mutation.** Do not stop the container. Keep the identical 8-second wait, so
the timing is otherwise the same.

**Result.**

```
values=["intake","prepare"]
```

The transform's value is pinned. `chaos.scenario.ts` → "Postgres dropped
mid-walk" asserts `prepare` is *absent*, which is only true because the store
was gone at exactly that write. Red under this mutation.

## D — the Redis outage

**Mutation.** Do not stop the container before the decision.

**Result.**

```
settled=true
```

`POST …/decision` returns immediately. The scenario asserts `settled === false`
— that the request never comes back — so it is red under this mutation, and the
hang is attributable to the outage rather than to anything else in the request
path.

## E — the disaster-recovery restore

**Not a deliberate mutation; observed on the first run of the drill.** Before
`restoreFrom` was reached, every query against the replacement database failed
with:

```
relation "forge_run" does not exist
```

The destruction is real: a new container, a new filesystem, no schema. That is
now asserted explicitly in the scenario's `beforeAll` via
`Inspector.schemaExists()`, before the restore runs, so a future change that
quietly stopped destroying the database would fail there rather than passing
every assertion afterwards against data that never went away.

---

## What was *not* mutated, and why

**Product source.** Two agents are actively editing `apps/api`,
`packages/runtime` and the SDK on this branch. The mutations that would be worth
running against product code, and what each should turn red:

| Mutation | Should go red |
|---|---|
| `runtime.ts` `perform()` — act before `claimEffect`, not after | The race test: two dispatches, or a claim row whose input disagrees with what was performed |
| `runtime.ts` `perform()` — drop the `ledger.includes(nodeId)` short-circuit | "a redrive does not perform the lost action a second time" |
| `runtime.ts` `reenterGate()` — drop the `bindsTo` check | Nothing in this harness. The gate-bypass suite in `packages/composition` owns that one |
| `queue-bullmq` `claim()` — give the operation key a TTL | "the queue will not deliver the resume again": the resume would be re-delivered and the run would recover, which is the behaviour that test currently proves *absent* |
| `run-store-postgres` `pinValue()` — remove `on conflict do nothing` | Nothing here directly; the durable-restart suites in `apps/worker` cover first-write-wins |
