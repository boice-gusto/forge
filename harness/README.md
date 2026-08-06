# harness

Load, chaos and disaster-recovery scenarios for Forge — Phase 7. Real `apps/api`
and `apps/worker` processes, Testcontainers Postgres and Redis, no fixed ports
and no credential anywhere but the environment and the containers themselves.

Nothing here is on the default test path. See **Running it** below.

---

## Why this lives at the top level and not in `packages/`

Three reasons, in order of how much they would have cost to work around.

1. **`tooling/assert-architecture.ts` scans `packages/`, `apps/`, `examples/`,
   `tooling/` and `scripts/`.** Adapters may only be bound in a composition
   root — `apps/api`, `apps/worker`, `packages/composition`. This harness binds
   them: it constructs durable stacks in child processes so it can supply an
   effect sink that can be slowed and observed. As `packages/loadtest` it would
   fail the architecture scan, and the only fixes would be to edit the scan's
   allowlist or to weaken the rule. Both are edits to files this work does not
   own, and one of them is a rule worth keeping.
2. **`vitest.config.ts` measures coverage over `packages/*/src/**` and
   `apps/*/src/**`.** A harness is not production source; being outside those
   globs means it can neither dilute a floor nor be held to one.
3. `harness/` says what it is.

The cost is one line: **`harness` is not matched by `pnpm-workspace.yaml`'s
globs (`packages/*`, `apps/*`, `examples/*`) and has to be added.** Until it is,
`link-deps.mjs` stands in for `pnpm install` by creating the symlinks pnpm would
create. Delete that file the day the workspace covers this directory.

## Why `*.scenario.ts` and not `*.test.ts`

The root suite uses Vitest's default `include`, which matches `.test.` and
`.spec.` only. The extension is the entire mechanism keeping a four-minute
container drill out of every contributor's inner loop — renaming a file here
puts it back in `pnpm test`.

## Running it

```sh
export DOCKER_HOST=unix://$HOME/.colima/<profile>/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock

node harness/link-deps.mjs        # until `harness` is in pnpm-workspace.yaml

pnpm exec vitest run --config harness/vitest.config.ts                       # all three
pnpm exec vitest run --config harness/vitest.config.ts test/load.scenario.ts # one
```

Knobs, all with defaults:

| Variable | Default | What it changes |
|---|---|---|
| `FORGE_LOAD_RUNS` | 100 | Runs started in the load scenario |
| `FORGE_LOAD_CONCURRENCY` | 10 | Requests in flight |
| `FORGE_LOAD_WORKERS` | 2 | `apps/worker` processes beside the control plane |
| `FORGE_LOAD_POLL_MS` | 20 | Sampling interval of the one status poller |
| `FORGE_LOAD_REPORT` | `./load-report.json` | Where the raw numbers are written |
| `FORGE_CHAOS_RACE_ROUNDS` | 6 | Repetitions of the two-worker race |
| `FORGE_CHAOS_FLEET_RUNS` | 8 | Runs in the control-plane/worker consistency check |

## What each file is for

| Path | Purpose |
|---|---|
| `test/load.scenario.ts` | N runs to their gates and out again; reports p50/p95/p99, asserts no latency budget |
| `test/chaos.scenario.ts` | Six ways to break a run in flight |
| `test/disaster-recovery.scenario.ts` | `pg_dump`, destroy the containers, restore, decide the gate in a new deployment |
| `src/worker-entry.ts` | A worker composed like `apps/worker`, with an observable effect sink |
| `src/resume-entry.ts` | One `runtime.resume` in its own process — the operator redrive the product does not expose |
| `src/park-entry.ts` | Creates a run and walks it to its gate, then exits |
| `src/inspect.ts` | Assertions read Postgres directly; some of the states that matter have no route |
| `src/docker.ts` | Containers on harness-chosen host ports, so one can be stopped and come back on the same address |

## The suite is red, and that is the result

Eight of the twelve chaos assertions pass. Four fail, each naming a defect
rather than a flake. They are written as assertions of the behaviour that
*should* hold, so each one turns green the day its cause is fixed and stays
green afterwards — none of them asserts the presence of a bug.

| Failing test | What it found |
|---|---|
| "the run a control plane serves is the run the store holds" | `Runtime.hydrate()` caches a `RunState` per process and never re-reads the store, so a control plane that created a run serves its `PENDING` record forever once a worker advances it |
| "a decision on a run another process advanced is not voided into a second gate" | The consequence: an operator's approval is recorded, the run then re-walks from that stale `PENDING`, and a **second** gate is opened over the same action. The decision is spent and nothing says so |
| "the decision is durable … and the resume lands exactly once when Redis returns" | A process whose Redis connection was severed never resumes consuming. The job is in the queue, the depth is 1, and nobody takes it |
| "a process that stopped consuming does not report itself ready" | `/health/ready` answers 200 on exactly that process. `QueuePort.health()` exists and nothing calls it |

`MUTATIONS.md` records what was deliberately broken to show that the eight
passing ones can fail.

## Two things to know before changing anything here

**A chaos test that passes the first time has not been tried.** Every kill in
`chaos.scenario.ts` asserts the state it left behind *before* it asserts a
recovery — a claim row with no matching value row, a transform marker with no
pinned value — because "the run recovered" is equally true of a kill that
arrived after the work was already done.

**There are no latency assertions.** Nobody has chosen a budget. `LOAD.md`
records what was measured and what it is worth; a threshold invented by the
person writing the load test is a threshold that gets deleted the first time it
fails.
