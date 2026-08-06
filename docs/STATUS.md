# Status

**Updated:** 2026-08-06 · branch `feat/ports-roles-capability` · 61 commits ahead of `main`

What is actually built, what is not, and why. [015-phases.md](./015-phases.md) is
the plan; this is the ledger. Where the two disagree, this file is the one that
was checked against the repository.

**Scale:** 41 packages, 3 apps, 1,282 tests, 98.6% statements / 91.4% branches.
Ten CI steps: `lint`, `typecheck`, `test`, `test:coverage`, `test:packaging`,
`test:architecture`, `test:security`, `security:secrets`, `security:licenses`,
`measure:phase1`.

---

## Done

| Area | State |
|---|---|
| **Compiler** | 11 node kinds, 9 diagnostics, capability closure, fingerprinting; judge verdicts and branch arms route, and an arm-less verdict stops the run |
| **Runtime** | Full lifecycle, approvals with expiry/edit/timeout, exactly-once effects, retry as an attempt counter |
| **Data plane** | Nodes produce and consume values, pinned per run so a resume cannot reroute under a decision already made |
| **Durability** | Postgres run store, checkpoints, approvals and run events; BullMQ queue. A run survives the process that started it, including one with an `agent` before its gate, and **survives an API restart** |
| **Async start** | `POST /v1/runs` persists and enqueues, 202 + `Location`. The consumer is bound in both persistence modes, so the route is one code path |
| **Policy** | OPA Wasm behind `PolicyPort` (ADR-007), Rego compiled ahead of time and committed. Policy resolves from the deployment's company package, never from a request |
| **Provider** | `@forge/provider-anthropic` on the real SDK with an injectable transport; retryable classification is table-driven |
| **Sandbox** | A scope the work runs inside, with a Docker adapter: no host mounts, zero capabilities, non-root, read-only rootfs |
| **Identity** | `IdentityPort` with a development binding, real role membership, and authority checked on the decision itself |
| **Observability** | 011 taxonomy, OTLP export, one trace per run, redaction proved against the exporter |
| **Extension** | Plugin SDK, company loader, packed public surface proven from outside the workspace |
| **Company packages** | `examples/acme`; `forge.gusto` G1–G5 on packed artifacts with no core source |

Seven conformance suites — provider, store, queue, sandbox, policy,
observability and event store — so a memory implementation and a real one
cannot drift apart without one of them failing.

## Not done, with reasons

| Gap | Why |
|---|---|
| **`POST …/decision` still walks inline** | 006 §10.3 would have it enqueue. Nothing about durability needs it — the ledgers are written as the walk proceeds — and `waitForRun` is general enough to absorb the change when wanted |
| **No SSE** | 012 §4.3. The history is durable now, so a stream has something real to tail; the transport is the remaining work |
| **No LangGraph engine** | ADR-002, deliberately amended rather than left open. The engine carries Forge's own semantics — sandbox scoping, arm pruning, the data plane's short-circuit — and moving those into a vendor's execution model would put the invariants beyond this repository's tests |
| **No Playwright** | The UI is covered by Vitest and sits inside the coverage floors rather than excluded from them. Worth revisiting for flows a component test cannot express |
| **Four `forge.gusto` scenarios are `todo`** | Held open by a test that goes red the day the API stops ignoring `environment`, so they cannot rot quietly |
| **Phases 7–8 not started** | Load, chaos and DR. Durability, identity, isolation and telemetry are the precondition, not the thing |

## Next, in order

1. **SSE for run events.** The history is durable; the transport is not.
2. **Enqueue the decision**, so no route walks a graph inside a request.
3. **W3C trace context on the run record**, so a run resumed in another process continues its trace rather than starting a new one.
4. **Phase 7** — load, chaos, disaster recovery.
5. **Playwright**, for the flows a component test cannot reach.

---

## What this codebase has learned the hard way

**Ten checks were found that could not fail.** Each was written to answer a
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

Two authorisation holes were found the same way — an orphaned node dispatching
an ungated effect, and a decision route that authenticated the caller but never
checked they were among the gate's approvers.
