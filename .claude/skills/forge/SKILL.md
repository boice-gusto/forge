---
name: forge
description: Compile, run, and gate Forge workflows. Use when asked to run a Forge workflow, inspect why a workflow will not compile, understand a diagnostic code (WF_*), decide a pending approval, or add a node kind, role, or policy rule. Also use before editing anything under packages/ir, packages/compiler, or packages/runtime, because those carry invariants that are easy to break silently.
---

# Forge

A typed workflow platform. Workflows are **compiled** into a sealed, fingerprinted
artifact; deterministic infrastructure surrounds intelligent steps; humans own
anything that reaches a customer.

The whole point is that safety properties are **checked, not remembered**. Your job
when working in this repository is to keep them checkable — never to route around a
check because it is inconvenient.

## The one rule

**A side effect cannot reach a customer without a human decision bound to that exact
action.** Everything below exists to make that true mechanically. If a change would
make it merely conventional again, stop and say so.

## Driving it

```sh
# compile a workflow to a sealed artifact, or get diagnostics
pnpm --filter @forge/cli exec tsx src/main.ts workflow compile --input <file> [--json]

# compile and execute until it finishes or reaches a gate
pnpm --filter @forge/cli exec tsx src/main.ts workflow run --input <file> [--json]

# other commands
... validate --input <manifest>     # company manifest
... providers doctor                # provider availability
... dev up | dev down               # declared local stack only
```

`--json` gives exactly one JSON object on stdout. Exit codes: `0` success,
`1` unavailable or run failed, `2` invalid artifact, `3` usage, `4` internal.

A CLI run is in-process. It does **not** resume across invocations — use the API when
a gate needs a real decision.

### Input file

A bare workflow source works, or wrap it to supply policy and capabilities:

```json
{
  "workflow": { "id": "...", "version": "1.0.0", "nodes": [...], "edges": [...] },
  "capabilities": ["docs.write"],
  "environment": "production",
  "policy": {
    "grants": ["docs.write", "slack.write"],
    "rules": [{ "id": "...", "action": "slack.post", "environment": "production",
                "decision": "require-approval", "reason": "...", "approvers": ["..."] }]
  }
}
```

See `examples/acme/workflows/campaign-brief.json` for a complete one that exercises
every node kind.

### API

```
POST /v1/workflows/compile                                  → public surface or diagnostics
POST /v1/runs                                               → 201 run record
GET  /v1/runs/:runId                                        → run record
GET  /v1/runs/:runId/approvals                              → pending gates
POST /v1/runs/:runId/approvals/:approvalId/decision         → approve | reject | edit | timeout
```

Authorisation is `Bearer <admin token>`. **The principal comes from the authenticated
caller, never from the body.** Do not add a `principal` field to a request payload —
that is the exact mistake the boundary exists to prevent.

## Reading a diagnostic

Eight codes, all in `docs/007-workflow-compiler.md` §11. The ones that carry real
meaning:

| Code | What it actually means |
|---|---|
| `WF_MISSING_APPROVAL` | An effect can be reached without passing the approval that names it. Either a path bypasses the gate, or no gate lists this node in `gates`. |
| `WF_CAPABILITY_UNBOUND` | A role wants a capability outside `grantedCapabilities`, or one it forbids itself. |
| `WF_UNTYPED_EDGE` | A branch arm is unlabelled, uses an undeclared `conditionId`, or a declared condition has no arm. |
| `WF_UNDECLARED_EFFECT` | A node causes an effect missing from `sideEffects[]`. |
| `WF_UNKNOWN_ROLE` | A node names a role that is not declared. |
| `WF_CYCLE`, `WF_DUPLICATE_NODE`, `WF_UNKNOWN_REF` | Graph structure. |

**Fix the declaration, not the check.** If `WF_MISSING_APPROVAL` fires, add the gate
or add the node to an existing gate's `gates` list. Do not delete the effect
declaration to silence it, and do not add a policy exemption without saying why.

## Invariants you must not break

Each of these has a test. If you find yourself changing one of those tests to make a
change pass, that is the signal to stop.

- **An approval authorises one action.** The binding hashes run + node + effect +
  artifact fingerprint. A generic approval upstream does not authorise an unrelated
  effect later.
- **Policy is consulted before a human.** A denied action never creates an approval.
- **Decisions are single-use.** Deciding twice is a no-op; a rejected approval cannot
  later be approved.
- **Effects dispatch exactly once.** A resumed attempt re-walks pre-interrupt nodes,
  so the effect ledger is what prevents a repeat.
- **An expired gate is not a slow yes.** It times out.
- **An edit authorises nothing.** It reissues the gate on the amended action.
- **Everything fails closed.** Policy evaluator errors deny. Judge errors escalate.
  An unmatched action denies by default.

## Layering

Dependencies point inward, and `tooling/assert-architecture.ts` enforces it.

```
apps/*  →  runtime, compiler  →  ports, ir  →  types
                ↑
        adapters (engine-memory, policy-memory, approval-memory, checkpoint-memory)
```

- Public packages — `sdk`, `manifest`, `types`, `plugin-sdk` — must not import
  `runtime`, `compiler`, `ir`, or any adapter.
- Core must never import a company extension (`forge.gusto`, `forge.acme`).
- Adapters are bound only in composition roots: `apps/api`, `apps/worker`, and
  `packages/composition` for the local stack.

**Core is generic. Company packages are specific.** Core owns the role *contract*; a
company package owns the *roster*. If you are about to put a benefits or payroll term
in `packages/`, it belongs in a company repository instead.

## Verifying

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm test:architecture
pnpm security:secrets && pnpm security:licenses && pnpm measure:phase1
```

All seven must exit `0` — that is exactly what CI runs, in that order. Run the whole
sequence before claiming a change is done; `pnpm test` alone has passed while
`typecheck` was broken.

## Where to look

| Question | File |
|---|---|
| What is Forge, and the non-negotiables | `docs/MASTER_SPEC.md`, `docs/003-project-constitution.md` |
| Node kinds, diagnostics, fingerprinting | `docs/007-workflow-compiler.md` |
| Run lifecycle, approvals, retry layers | `docs/006-runtime.md` |
| Layer model and package map | `docs/004-architecture.md` |
| Roles and panels | `docs/adrs/009-agent-roles.md` |
| Misfire capture | `docs/adrs/010-incident-capture.md` |
| What phase gates what | `docs/015-phases.md` |
