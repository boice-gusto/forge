# Open defects from the 2026-08-07 review

Seven were proved with failing tests written against commit `2bda376`; the
tests are the `.ts.txt` files beside this one. They are `.txt` on purpose —
they *fail*, and a failing test in the suite is a broken build rather than a
record. Rename one to `.ts`, drop it in the package named below, and it will
go red until the defect is fixed. That is the point of keeping them.

Ranked by what they cost. None of these is fixed.

## 1. A thrown effect is retried into a no-op and the run reports SUCCEEDED

`packages/runtime/src/runtime.ts:870` writes `nodeId` to the effect ledger
*before* calling the sink. `packages/engine-memory/src/engine.ts:227`
classifies a throwing `perform` as retryable. The retry re-walks, hits
`if (ledger.includes(nodeId)) return` at line 852, and skips the node — so a
sink that threw leaves `status: SUCCEEDED` and
`performedEffects: ["publish"]`. **The audit trail records an action that
never happened.**

Moving the ledger write is not the fix on its own: `claimEffect` refuses the
second attempt, so the retry is a no-op either way. A thrown effect should be
**non-retryable** — fail the run, let it surface in `GET /v1/effects/unsettled`,
and let the gated redrive be the recovery. That is what the rest of the design
already says: losing one is recoverable, repeating one is not.

## 2. The dispatched effect is never checked against the approved effect

The binding covers run + node + effect + fingerprint. Enforcement at dispatch
covers **nodeId only** (`runtime.ts:1126` authorises a node; `engine.ts:214`
checks the node). Nothing compares the `effect` string reaching
`EffectSink.perform` to `approval.effect`, and nothing rehashes the stored IR —
so `hydrate`'s comment at `runtime.ts:563` ("a substituted artifact fails that
check") is not true. `ir.sideEffects` is not consulted at runtime either.

Needs write access to the run store, so it is not remotely exploitable. It is
still the specific claim the code makes about itself. Two cheap assertions
close it: compare `approval.effect` to the node's effect at dispatch, and
assert `persisted.artifact.fingerprint === persisted.record.fingerprint`.

## 3. A racing resume can open two spendable gates on one run

`advance` calls `approvals.request` (`runtime.ts:1026`) *before* the
concurrency-guarded `update` (`1053`), and the approval store has no revision.
Two workers on a redelivered `workflow.execute` both write an approval; one
then cedes. Rejecting the orphan fails a run whose live gate nobody decided,
and the live gate stays in the inbox forever.

The invariant survives — both gates bind the same action — but the operator's
model of the system does not. `rehydration.test.ts` calls this "the state that
voided an operator's decision once already" and guards `redrive` against it;
`advance` can still create it.

## 4. A redrive cannot tell a lost action from one in flight

`listUnsettled` has no minimum claim age, so a claim appears the instant it is
taken, and `redrive`'s guards pass for a run that is `RUNNING` with a dispatch
in progress. Approving that redrive dispatches the action twice. Two guards
close it: an age floor on the report, and refusing a redrive on a `RUNNING`
run.

## 5. A misspelled panel role silently shrinks the panel

`packages/panel/src/panel.ts:106` skips an unknown role with `continue`. A
typo turns a two-reviewer gate into a one-reviewer gate and reports nothing;
`resolveVerdict` fails closed only when *every* member is missing.

## 6. An `edit` decision's patch reaches nothing

`ApprovalDecision.edit.patch` is dropped by `approval-memory`'s `decide`, and
the reissued approval carries the original `effectHash` and effect. The
comment at `runtime.ts:1322` says amending the action forces a fresh decision;
nothing is amended. Safe today, misleading now, and a hole the moment somebody
wires the patch up without rebinding the hash. Implement it or delete `patch`
from the type.

## 7. The artifact fingerprint is not canonical

`packages/compiler/src/compiler.ts:463` sorts `sideEffects`,
`grantedCapabilities`, `nodes` and `edges` before hashing but not `roles`, and
sorts with `localeCompare` — collation, not bytes, and locale-dependent. Two
key orders, or two build hosts with different locales, hash one source to two
fingerprints. Fail-closed (a binding stops matching), so this is
reproducibility rather than safety. Fixing it invalidates every stored
binding.

---

# Two more, from the quality sweep. Also unfixed.

## 8. The `forge_intake` table is created nowhere

`createDurableStack` applies four schemas and not the intake one;
`applyIntakeLedgerSchema` is called only from `intake-postgres`'s own
conformance test. The first `POST /v1/intake/:channel` against Postgres dies
on *relation "forge_intake" does not exist*. The test that appears to cover
this asserts SQL text against a stubbed pool — it proves the query is right
and nothing proves the table exists. One line in `durable.ts`.

## 9. `listPendingFor` resolves `ANY_ROLE` differently in the two stores

`approval-memory` includes the principal in the set it checks; `approval-postgres`
checks `roles.includes(ANY_ROLE)` only. A principal named `*` sees every gate
locally and none in production. The conformance suite never passes the `roles`
argument at all, so the port's second parameter is entirely unexercised — on
the operator inbox, which is the safety path.
