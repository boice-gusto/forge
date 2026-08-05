# Status

**Updated:** 2026-08-05 · branch `feat/ports-roles-capability` · 53 commits ahead of `main`

What is actually built, what is not, and why. [015-phases.md](./015-phases.md) is
the plan; this is the ledger. Where the two disagree, this file is the one that
was checked against the repository.

**Scale:** 35 packages, 3 apps, 1,015 tests, 98.4% statements / 89.9% branches.
Ten CI steps: `lint`, `typecheck`, `test`, `test:coverage`, `test:packaging`,
`test:architecture`, `test:security`, `security:secrets`, `security:licenses`,
`measure:phase1`.

---

## Done

| Area | State |
|---|---|
| **Compiler** | 11 node kinds, 9 diagnostics, capability closure, fingerprinting. Judge verdicts and branch arms route; a verdict with no arm stops the run |
| **Runtime** | Full lifecycle, approvals with expiry/edit/timeout, exactly-once effects, retry as an attempt counter |
| **Data plane** | Nodes produce and consume values; outputs pinned per run so a resume cannot reroute under a decision already made |
| **Durability** | Postgres run store, checkpoints and approvals; BullMQ queue; **a run survives the process that started it**, including one with an `agent` before its gate |
| **Sandbox** | A scope the work runs inside, not a flag. Docker adapter with no host mounts, zero capabilities, non-root, read-only rootfs |
| **Identity** | `IdentityPort` with a development binding; real role membership; **authority checked on the decision itself**, not only when filtering an inbox |
| **Extension** | `@forge/plugin-sdk`, company loader, packed public surface proven from outside the workspace |
| **Observability** | 011 span taxonomy, OTLP exporter, redaction proved against the exporter |
| **Operator UI** | Approval inbox and run inspector, stating the exact binding being authorised |
| **Company packages** | `examples/acme` and `forge.gusto` (G1–G5, 76 tests, runs on packed artifacts with no core source) |

Five adapter families answer a shared conformance suite — provider, store,
queue, sandbox, observability — so a memory and a real implementation cannot
drift.

---

## Not done, with reasons

| Gap | Why it is still open |
|---|---|
| **`apps/api` does not use the durable stack** | Needs a decision, not wiring: `runs.ts` builds a **new stack per request policy**, which with Postgres is a new pool and Redis connection per request. Either policy resolves from the company package, or it becomes a per-request `PolicyPort` behind one stack |
| **`GET /v1/runs` lists nothing after a restart** | Enumerates the API's in-process map. `RunStorePort` needs a `list`; left out rather than guessed at |
| **No real model provider** | ADR-005 names `@simpill/acp-llm-cli`, which is not on npm. `provider-mock` and `provider-replay` are deterministic. A git dependency needing a binary and an API key cannot be what a CI conformance gate runs against |
| **No OPA policy adapter** | ADR-007. `policy-memory` is the only implementation |
| **No LangGraph engine** | ADR-002. `engine-memory` was a stand-in and is still the engine |
| **Run events are a snapshot, not SSE** | 012 §4.3. There is no producer behind it yet, and the timeline is per-process |
| **No Playwright** | The UI is covered by Vitest instead, which is why it is inside coverage rather than excluded |
| **Two vocabularies for one taxonomy** | `WorkflowNode` in `@forge/types`, `IrNode` in `@forge/ir`, currently aliases. Safe to collapse now |
| **Four `forge.gusto` scenarios are `todo`** | Backed by `control-plane-gaps.test.ts`, which goes red the day the API stops ignoring `environment` — so they cannot rot quietly |

---

## Next, in order

1. **Decide how `apps/api` gets its policy**, then bind the durable stack. Unblocks durable reads, durable cancel, and the four Gusto todos.
2. **`RunStorePort.list`**, so a restart does not empty the run list.
3. **A real provider** — either resolve ADR-005's dependency or amend the ADR to name one that exists.
4. **OPA behind `PolicyPort`** (ADR-007), with the conformance-suite treatment.
5. **Collapse `WorkflowNode`/`IrNode`.** No agent holds `packages/runtime` now.
6. **Trace hierarchy.** Every span is currently a root; `ObservabilityPort` carries no context. Needs an ALS-backed context in the runtime.
7. **SSE run events**, once a producer exists.
8. **LangGraph engine** (ADR-002), or amend the ADR to bless `engine-memory`.
9. **Playwright**, if the UI's Vitest coverage is judged insufficient.
10. **`docs/015-phases.md` exit criteria** should be reconciled against this file.

---

## What this codebase has learned the hard way

Five checks were found that **could not fail**. Each was written to answer a
question, passed immediately, and was never asked to fail again:

- `test:architecture` never opened a source file — it tested hand-written strings.
- `security:secrets` read only tracked paths, so a secret in a new file passed
  and was caught on the *next* run, once it was already in history.
- `security:licenses` failed only on an empty inventory; AGPL would have passed.
- A PII test asserted against the recorder that was doing the redacting.
- A double-dispatch test drove the run to SUCCEEDED first, so a redelivered job
  hit the terminal short-circuit and never reached the node it was guarding.

Two more passed for accidental reasons: a sandbox isolation test whose fixture
node sorted before the sandbox node, so partitioning was never exercised; and a
wire test that opened and closed one span with the same probe, so redacted
closing attributes overwrote unredacted opening ones.

**All seven were found by deliberately breaking the implementation and checking
that the named test failed.** None would have been found by adding more tests.
That practice is now expected of any substantial change here, and it is worth
more than the coverage floors.

Two authorisation holes were found the same way — an orphaned node dispatching
an ungated effect, and a decision route that authenticated the caller but never
checked they were among the gate's approvers.
