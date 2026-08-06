# Status

**Updated:** 2026-08-06 · branch `feat/ports-roles-capability` · 79 commits ahead of `main`

What is actually built, what is not, and why. [015-phases.md](./015-phases.md) is
the plan; this is the ledger. Where the two disagree, this file is the one that
was checked against the repository.

**Scale:** 41 packages, 3 apps, 1,350 unit tests (98.7% statements / 91.3%
branches) plus 24 resilience scenarios against real containers. Ten CI steps —
`lint`, `typecheck`, `test`, `test:coverage`, `test:packaging`,
`test:architecture`, `test:security`, `security:secrets`, `security:licenses`,
`measure:phase1` — and a separate `resilience` job, which costs minutes and
needs Docker, so it fails on its own terms rather than inside `verify`.

---

## Done

| Area | State |
|---|---|
| **Compiler** | 11 node kinds, 9 diagnostics, capability closure, fingerprinting; judge verdicts and branch arms route, and an arm-less verdict stops the run |
| **Runtime** | Full lifecycle, approvals with expiry/edit/timeout, exactly-once effects, retry as an attempt counter |
| **Data plane** | Nodes produce and consume values, pinned per run so a resume cannot reroute under a decision already made |
| **Durability** | Postgres run store, checkpoints, approvals and run events; BullMQ queue. A run survives the process that started it, including one with an `agent` before its gate, and **survives an API restart** |
| **Async start** | `POST /v1/runs` persists and enqueues, 202 + `Location`. `POST …/decision` does the same, so no route walks a graph inside a request. The consumer is bound in both persistence modes, so both routes are one code path |
| **Live events** | `GET /v1/runs/:runId/events` streams SSE off the durable history, resumable by `Last-Event-ID`. The tail re-authenticates each pass, because a stream outlives the credential that opened it |
| **Resilience** | `harness/` — load, chaos and disaster recovery against real Postgres and Redis, killing them mid-run on purpose, and a sandbox container destroyed under a live lease |
| **`apps/api` refuses to be mistaken for production** | Its guard was `NODE_ENV === "production"` — opt-in, so an unset value sailed past. The allowance is the opt-in now, and it announces what it simulates |
| **One trace per run, across processes** | The run record carries a W3C `traceparent`, so the process that creates a run, the worker that walks it and whoever resumes it after a decision all record in one trace. Sampling travels with it |
| **Optimistic concurrency** | `RunStorePort.update()` presents the revision it read. A stale write is refused rather than applied, and the runtime cedes to whoever got there first instead of failing a job |
| **Lost effects are findable, and recoverable** | An action claimed and never seen to finish is reported at `GET /v1/effects/unsettled`, and `POST /v1/runs/:runId/effects/:nodeId/redrive` opens a *gate* on performing it again — it never performs it |
| **A worker binds real things, or refuses to start** | The company's effect sink, a Docker sandbox for the profiles it declares, and a real model. Each was a stand-in wired into the production composition root |
| **Adapters resolve at boot** | A company's adapter modules are imported when the deployment starts, not at the first gated action — the effect sink, the transform table, and anything else a company binds |
| **Policy** | OPA Wasm behind `PolicyPort` (ADR-007), Rego compiled ahead of time and committed. Policy resolves from the deployment's company package, never from a request |
| **Provider** | `@forge/provider-anthropic` on the real SDK with an injectable transport; retryable classification is table-driven |
| **Sandbox** | A scope the work runs inside, with a Docker adapter: no host mounts, zero capabilities, non-root, read-only rootfs |
| **Identity** | `IdentityPort` with a development binding, real role membership, and authority checked on the decision itself |
| **Observability** | 011 taxonomy, OTLP export, one trace per run, redaction proved against the exporter |
| **Extension** | Plugin SDK, company loader, packed public surface proven from outside the workspace |
| **Intake (Phase 8, begun)** | `@forge/intake` — one canonical `WorkflowRequest` every channel produces, a connector contract that puts verification before deduplication before normalisation, and two conformance suites: one a connector proves itself against, one a ledger does. `@forge/connector-slack` implements the first; `@forge/intake-postgres` the second, so a fleet deduplicates rather than each process deduplicating for itself. `POST /v1/intake/:channel` turns a signed delivery into a run that stops at its gate like any other |
| **Company packages** | `examples/acme`; `forge.gusto` G1–G5 on packed artifacts with no core source |

Seven conformance suites — provider, store, queue, sandbox, policy,
observability and event store — so a memory implementation and a real one
cannot drift apart without one of them failing.

## Not done, with reasons

| Gap | Why |
|---|---|
| **No LangGraph engine** | ADR-002, deliberately amended rather than left open. The engine carries Forge's own semantics — sandbox scoping, arm pruning, the data plane's short-circuit — and moving those into a vendor's execution model would put the invariants beyond this repository's tests |
| **Two concurrent walks in one process still share a `RunState`** | The queue delivers once, so this needs a redelivery *and* a coincidence. Reads no longer touch it, which was the reachable half |
| **No deadline on enqueue** | A job that is never taken is indistinguishable from one taken slowly |
| **Four `forge.gusto` scenarios are `todo`** | Held open by a test that goes red the day the API stops ignoring `environment`, so they cannot rot quietly |
| **Phase 8 not started** | Phase 7 is done and found four production defects; 8 is next |

## Next, in order

1. **Phase 8, continued.** Intake, a durable ledger, one connector and the
   route all exist. Still to come: Jira and Buzz, redacted progress and
   artifact summaries published *back* to the originating system, and the
   outage property — a connector being down must not lose canonical Forge
   state.
2. **A third cause for the `queue-bullmq` flake.** "Subscribing twice is
   refused" has now gone red three times. Two causes are found and fixed — a
   test budget shorter than the adapter's close budget, and a suite that
   leaked every queue it made. A third remains, seen once as a 76ms failure
   that is neither of those. Three consecutive clean full runs afterwards, so
   it is rare; it is written down rather than called fixed.

---

### What Phase 7 and the work after it found

Four defects, each reaching production behaviour, none visible to the unit
suite:

- **An operator's approval was silently voided into a second gate.** `hydrate()`
  cached run state per process and never re-read the store, so once the decision
  route enqueued, the resume re-walked from the start and opened a *new*
  approval. Observed: approval #1 `APPROVED`, approval #2 `PENDING`,
  `effects=[]`, run back at `AWAITING_APPROVAL`. A human decided, and the
  decision bought nothing.
- **A Redis outage permanently stopped a process consuming.** BullMQ emits
  `ioredis:close` when it has *given up*; nothing recreated the worker. A blip
  became a stalled queue.
- **That process answered `/health/ready` with 200 throughout.** Both apps
  hard-coded `{ queue: "healthy" }`. `QueuePort.health()` existed and nothing
  called it.
- **`health()` and `close()` both hung when Redis was gone.** The producer runs
  `maxRetriesPerRequest: null` so an enqueue survives a blip — which means a
  command issued during an outage *buffers* rather than rejecting. Unbounded,
  that turns a readiness probe into a timeout, and turns a SIGTERM drain into a
  SIGKILL that drops the telemetry explaining the outage.

### Three stand-ins in the production composition root

Found one after another, each while fixing the last, and all the same shape:
a development default wired into `createDurableStack`, which is what
`apps/worker` runs.

- **The effect sink did nothing.** `async perform() { return undefined }`. The
  worker walked every run, passed every gate, recorded every effect as
  dispatched, and performed none of them. A human approves, the audit log says
  the action went out, and nothing went anywhere.
- **The sandbox was the in-memory one.** A step declaring `forge.node-ts` —
  declaring it in the compiled artifact, which is the entire basis on which a
  workflow may handle untrusted content — ran against a `Map`, in the worker's
  own process, with the worker's filesystem and the worker's network.
- **The provider was the mock.** An agent step produced a canned completion,
  which flowed into a gate, was shown to a human as the thing they were
  approving, and was dispatched as a real side effect. Every part of that chain
  worked as designed; only the content was fictional.

A worker now binds each for real or refuses to start, with a named environment
variable for a deployment that genuinely wants a stand-in. The refusal
immediately caught the resilience harness using the mock provider without
saying so — which is what it is for.

### A signature checked against the wrong bytes

The intake route computed its digest over `JSON.stringify(request.body)` —
because Fastify had already parsed the body, and nothing said so. `JSON.parse`
followed by `JSON.stringify` does not round-trip, so that verifies against
something the sender never signed.

Every test passed. All of them used compact fixtures, where the two happen to
agree — which is precisely what lets the mistake reach production, where the
first pretty-printed body or unicode escape fails to verify and looks like a
Slack problem. It was found by sabotaging the raw-body handling, watching
nothing go red, and then writing the fixture that could tell the difference.

The route now keeps the raw string in its own Fastify plugin scope, and a
signed pretty-printed body is a test.

### A wait that waited for nothing

The redrive was reported here as *known broken* for a day: driven through real
processes it left the run at its gate with the claim unsettled and the approved
action apparently lost. It was not broken. The harness's `settle()` counts
`AWAITING_APPROVAL` as settled, so calling it on a run already at a gate
returns immediately, having waited for a state the run never left — and the
assertions then ran before the enqueued resume had done anything.

Worth recording for two reasons. It is the same family as the vacuous checks
below, seen from the other side: a helper that cannot fail to return is as
misleading as an assertion that cannot fail. And the failure it produced was a
*convincing* one — every symptom pointed at the feature under test, and the
instinct to trust that reading is what makes this kind of bug expensive.

And one more, found by adding optimistic concurrency and watching a durable
restart go intermittently red:

- **A status poll could strand a walking run.** `loadRun` went through
  `hydrate`, which adopts the store's copy into the shared `RunState`. Right
  for a process about to walk a run; wrong for one answering
  `GET /v1/runs/:runId`. A poll landing mid-walk read the record a moment
  before the walk's write committed and wrote that older revision back over
  it — and the walk's next transition then failed a conflict against work it
  had done itself. The run stopped at RUNNING and stayed there, with nothing
  in any log to say why. A read is now a read.

---

## What this codebase has learned the hard way

**Twelve checks were found that could not fail.** Each was written to answer a
question, passed immediately, and was never asked to fail again:

- `test:architecture` never opened a source file — it tested hand-written strings.
- `security:secrets` read only tracked paths, so a secret in a new file passed
  and was caught on the *next* run, once it was already in history.
- `security:licenses` failed only on an empty inventory; AGPL would have passed.
- A PII test asserted against the recorder that was doing the redacting.
- A double-dispatch test drove the run to SUCCEEDED first, so a redelivered job
  hit the terminal short-circuit and never reached the node it was guarding.
- `policy-memory`'s fail-closed test used a flag that returned the deny straight
  from `decide()`, bypassing the `catch` it existed to prove. The catch was dead
  code.
- An event-ordering test gave every record the same timestamp, so ordering by
  clock instead of sequence still passed — a stable sort preserves insertion
  order on equal keys. It needed a *backwards-running* clock.
- A composition-level PII test passed with redaction disabled, because the
  runtime emits no attribute the scrubber touches.

Two more passed for accidental reasons: a sandbox isolation test whose fixture
node sorted before the sandbox node, so partitioning was never exercised; and a
wire test that opened and closed one span with the same probe, so redacted
closing attributes overwrote unredacted opening ones.

One was **suspected and turned out to be sound** — the gate-bypass PII
assertion, which fails only when the runtime leaks *and* redaction misses. It
reads hollow until you break both. Suspicion is not evidence either way, which
is the same point from the other side.

**Every one was found by deliberately breaking the implementation and checking
that the named test failed.** None would have been found by adding more tests.
That practice is expected of any substantial change here, and it is worth more
than the coverage floors.

A related trap, seen twice: a fixture whose values can collide by chance. A PII
needle of `82000` matched a nanosecond timestamp and failed a run for a reason
unrelated to redaction — a test that can fail for the wrong reason is only a
little better than one that cannot fail at all.

The eleventh was written *this week, by the author of this file*, while fixing
the health probe — a test that a subscriber which has stopped consuming reports
unavailable. It passed. It also passed with the consumer check replaced by
`return { available: true }`, because closing the queue breaks the ping first
and the run never reaches the line under test. It was deleted rather than kept,
and `queue.ts` now says in place that the term is not independently falsifiable
and why.

The twelfth arrived a day later, from the same author, guarding the new
lost-effect report: "a deployment with nothing outstanding reports nothing." It
started a run and stopped at its gate, so no effect was ever claimed and the
list was empty for a reason that had nothing to do with settlement — it passed
with the runtime's `settleEffect` call deleted. It now drives a run that
actually dispatches. Knowing the trap is not the same as being immune to it,
twice over.

Two authorisation holes were found the same way — an orphaned node dispatching
an ungated effect, and a decision route that authenticated the caller but never
checked they were among the gate's approvers.
