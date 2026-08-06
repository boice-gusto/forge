# Load — what was measured, and what it is worth

Measured 2026-08-06 on branch `feat/ports-roles-capability` by
`harness/test/load.scenario.ts`. **No budget is asserted anywhere.** Nobody has
chosen one for Forge, and a threshold invented by the person writing the load
test is a threshold that gets deleted the first time it fails. These are
observations; turning one into a commitment is a decision for whoever owns the
SLO.

---

## The measurement

One `apps/api` process, real `examples/acme` policy, Testcontainers Postgres 16
and Redis 7 on the same host. Each run: `POST /v1/runs` → the run reaches a
`slack.post` gate → `POST …/approvals/:id/decision` → the effect ledger records
one dispatch. Three timings per run:

| Name | From | To |
|---|---|---|
| **start** | request sent | `202 Accepted` returned |
| **gate visible** | `POST /v1/runs` sent | the run first *observed* at `AWAITING_APPROVAL` |
| **decide accepted** | decision sent | the route returns |
| **decide → dispatch** | decision sent | the run first *observed* at `SUCCEEDED` |

All figures in milliseconds.

### 100 runs, 10 concurrent — three consecutive repetitions

| measurement | n | min | p50 | p95 | p99 | max | mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| start | 100 | 3.4 | 4.9 | 40.2 | 42.3 | 42.8 | 8.4 |
| gate visible | 100 | 55.0 | 162.3 | 254.0 | 256.6 | 256.9 | 159.7 |
| decide accepted | 100 | 3.1 | 4.6 | 8.1 | 8.6 | 8.7 | 4.9 |
| decide → dispatch | 100 | 28.0 | 162.3 | 257.6 | 279.4 | 279.6 | 157.2 |

| measurement | n | min | p50 | p95 | p99 | max | mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| start | 100 | 3.8 | 5.3 | 41.0 | 42.9 | 43.2 | 8.8 |
| gate visible | 100 | 62.4 | 160.3 | 248.3 | 249.7 | 250.2 | 157.4 |
| decide accepted | 100 | 3.2 | 5.0 | 8.9 | 9.7 | 10.0 | 5.3 |
| decide → dispatch | 100 | 18.9 | 151.7 | 255.9 | 257.6 | 258.7 | 155.5 |

| measurement | n | min | p50 | p95 | p99 | max | mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| start | 100 | 3.7 | 4.7 | 29.2 | 31.2 | 34.7 | 7.2 |
| gate visible | 100 | 34.6 | 166.6 | 243.4 | 261.7 | 262.2 | 159.8 |
| decide accepted | 100 | 3.3 | 4.7 | 8.0 | 8.6 | 8.6 | 5.0 |
| decide → dispatch | 100 | 29.6 | 168.0 | 282.1 | 283.3 | 283.6 | 170.2 |

Throughput: **1 080–1 320 runs/s accepted**, **263–299 runs/s to their gates**,
**141–150 runs/s end to end**. Whole fleet in 665–709 ms of wall clock.

### 500 runs, 25 concurrent

| measurement | n | min | p50 | p95 | p99 | max | mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| start | 500 | 5.0 | 8.0 | 13.7 | 51.4 | 52.7 | 10.2 |
| gate visible | 500 | 75.8 | 717.6 | 1210.2 | 1253.4 | 1254.5 | 712.0 |
| decide accepted | 500 | 4.6 | 7.2 | 9.5 | 10.8 | 11.5 | 7.4 |
| decide → dispatch | 500 | 35.1 | 774.4 | 1371.6 | 1415.8 | 1439.5 | 775.0 |

2 391 runs/s accepted, 341 runs/s to their gates, 163 runs/s end to end,
3 076 ms wall.

---

## What the shape says

**Accepting a run and recording a decision are both fast and flat.** Both are a
handful of Postgres writes and one enqueue, and both stay under 10 ms at p95
whether the fleet is 100 runs or 500. Neither route holds a request across a
graph walk, which is the property `POST /v1/runs` and — as of this branch —
`POST …/decision` were changed to have; these numbers are what that change
bought.

**The two queue-mediated timings are queue depth, not work.** 5× the runs, ~4.4×
the p50 for gate-visible and ~4.8× for decide-to-dispatch, while throughput to
the gate is flat at ~300 runs/s. That is a single consumer draining a backlog:
every run's latency is essentially its position in the queue divided by the
service rate. It is *not* a statement about how long one run takes — the
minimum, 34–76 ms, is closer to that.

**Nothing here measures real work.** The bound effect sink performs nothing, the
sandbox is the memory adapter, the provider is the mock, and the workflow is
four nodes. A production workflow's cost is dominated by the model call and the
connector, neither of which is present. What these numbers describe is the
**control plane and the durability machinery** — Postgres round trips, BullMQ
delivery, rehydration, the effect ledger.

---

## What would have to be true for these to matter

1. **A chosen budget.** Someone has to say what a run reaching its gate is
   allowed to cost, and separately what an operator clicking *approve* is
   allowed to wait for. Those are different SLOs with different owners: the
   first is a pipeline property, the second is a human-facing one.
2. **A worker fleet that works.** Every figure above was taken with
   `FORGE_LOAD_WORKERS=0`, meaning the control plane consumed its own queue.
   That is a supported topology, but it is not the one a deployment scales.
   Adding `apps/worker` processes currently breaks correctness — see
   `harness/test/chaos.scenario.ts`, "a control plane and a worker fleet on one
   queue" — so *horizontal* throughput has not been measured at all. The
   flat ~300 runs/s ceiling is the ceiling of one consumer; whether it
   multiplies is unknown.
3. **A real sink and a real provider.** With those bound, the queue-mediated
   latencies will be dominated by them, and the numbers here become the floor
   rather than the measurement.
4. **A machine anyone else can reproduce.** These were taken on one developer
   laptop under Colima, with Postgres, Redis, the API and the test runner all
   competing for the same cores. A number from that machine is not a number
   from a deployment.

## What was not controlled for

- **Sampling bias, upward, up to 20 ms.** `gate visible` and `decide → dispatch`
  end at a *poll*, not at an event: one `GET /v1/runs` every `FORGE_LOAD_POLL_MS`
  (default 20). One poller rather than one per run, because 100 pollers at 20 ms
  would be 5 000 req/s of instrument against the thing being measured. The bias
  is not corrected for — a correction would be a model of the error rather than
  a measurement of it. `apps/api` now serves SSE at `/v1/runs/:id/events`; a
  future version of this harness should subscribe instead and drop the bias
  entirely.
- **Cold start.** Every phase runs once, in one process, with no warm-up. The
  `start` p95 of ~40 ms against a p50 of ~5 ms is almost certainly JIT and pool
  warm-up in the first few requests.
- **Container overhead.** Postgres and Redis are on the loopback interface
  through Docker's network stack, not on a socket and not on another host.
  Real network latency is absent; container networking overhead is not.
- **Coordinated omission.** Requests are issued by a bounded worker pool, so a
  slow response delays the next request rather than letting a backlog build at
  the intended arrival rate. Tail latencies are therefore understated in the
  classic way. This is a closed-loop measurement, not an open-loop one.
- **One workflow.** Four nodes, one gate, one effect, a payload of one short
  string. Nothing about branch pruning, judges, sandboxes, retries or large
  payloads is exercised.

## Reproducing

```sh
export DOCKER_HOST=unix://$HOME/.colima/<profile>/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
node harness/link-deps.mjs
FORGE_LOAD_RUNS=100 FORGE_LOAD_CONCURRENCY=10 \
  pnpm exec vitest run --config harness/vitest.config.ts test/load.scenario.ts
```

The raw numbers, including per-phase wall clock, are written to
`FORGE_LOAD_REPORT` (default `./load-report.json`).
