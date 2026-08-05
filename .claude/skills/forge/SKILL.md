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

# load a company package and list what it contributes
... company inspect --company <dir>

# compile and run a workflow a company registered, gated by its own policy
... workflow run --company <dir> --workflow <id>

# other commands
... validate --input <manifest>     # company manifest
... providers doctor                # provider availability
... dev up | dev down               # declared local stack only
```

`--json` gives exactly one JSON object on stdout. Exit codes: `0` success,
`1` unavailable or run failed, `2` invalid artifact, `3` usage, `4` internal.

Streams follow the exit code: a successful result is on stdout, a failure is on
stderr. Do not send a success to stderr — `forge workflow run > run.txt` would
capture nothing, which is how it behaved until it was noticed.

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

`panel`, `review.votes` and `changedPaths` are also accepted. Panels compose from
`changedPaths`, so a specialty role only joins when its predicate matches. `votes` is
a local stand-in until a review adapter exists — without it a judge node fails closed.

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

Nine codes; eight are in `docs/007-workflow-compiler.md` §11 and `WF_UNREACHABLE_NODE` was added after a red-team pass found that graph shape could bypass a gate. The ones that carry real
meaning:

| Code | What it actually means |
|---|---|
| `WF_MISSING_APPROVAL` | An effect can be reached without passing the approval that names it. Either a path bypasses the gate, or no gate lists this node in `gates`. |
| `WF_CAPABILITY_UNBOUND` | A role wants a capability outside `grantedCapabilities`, or one it forbids itself. |
| `WF_UNTYPED_EDGE` | A branch or judge arm is unlabelled, uses an undeclared `conditionId`/verdict, or a declared condition/verdict has no arm. |
| `WF_UNDECLARED_EFFECT` | A node causes an effect missing from `sideEffects[]`. |
| `WF_UNKNOWN_ROLE` | A node names a role that is not declared. |
| `WF_UNREACHABLE_NODE` | A node has no path from the input node. A dead node cannot be gated, so it is refused rather than reasoned about. |
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
- **Execution follows edges.** A node with no path from the input node is not
  executed. Both the compiler and the engine enforce this independently —
  either layer alone once let an orphaned effect run.
- **A verdict is decided once per run.** A judge is a model call, not a pure
  function, and a resumed attempt re-walks the nodes before the interrupt. The
  verdict ledger pins it, so the route cannot change underneath a decision a human
  already made. Without it a run could report SUCCEEDED having dispatched nothing,
  after an operator explicitly approved the effect.
- **Everything fails closed.** Policy evaluator errors deny. A judge that errors,
  returns a verdict it declared no arm for, or has no votes stops the run. An empty
  panel is never a pass. An unavailable sandbox stops the walk — there is no host
  fallback. An unmatched policy action denies by default.
- **Retry is an attempt, not a state.** A retryable node failure increments the
  attempt up to the highest `maxAttempts` declared on any node; the run stays RUNNING.

## Judge routing

A judge may declare `verdicts: ["pass","fail","review"]`; each declared verdict is
carried by an outgoing edge labelled `conditionId: <verdict>`, exactly like a
branch. The node says *which* verdicts route, the edge says *where* — one source of
truth rather than a `Record<verdict, target>` that can disagree with the edge list.

Omit `verdicts` and the older, narrower rule applies: only `pass` continues.

Either way a verdict with no arm **stops the run** — it never falls through onto the
pass path. A judge that throws is not converted into a `review` verdict, because an
infrastructure failure must not be indistinguishable from a considered escalation.

Gate analysis is condition-agnostic, so an arm cannot launder a bypass: an effect
reachable through a verdict arm still needs an approval that names it, and
`WF_MISSING_APPROVAL` fires if it does not have one.

## Company packages

A company package is a directory with `forge.company.json` naming its domains,
plugins, policy packs, and adapter bindings. `examples/acme` is a working one —
read it before writing another.

```
loadCompany(root, hostCapabilities)   →  registerPlugins  →  compile  →  run
```

- A plugin gets a `PluginContext` with five registries and nothing else. No
  engine, queue, provider, or IR handle — `009 §12` lists what must never appear
  in company code, and the architecture scan enforces it against real files.
- **`spec.capabilities` is a request.** It is intersected with the host ceiling,
  never added to it. A package that could widen its own grant by editing its own
  manifest would not have a ceiling.
- A policy pack's `grants` are checked against that ceiling like any other
  claim. This is the load-bearing one: without it a company could grant itself
  anything.
- Everything crossing the boundary is deep-frozen. `readonly` is erased at
  runtime, and a red-team pass reached `prod.write` on a `kb.read` host twice by
  mutating a live reference — once on `hostCapabilities`, once on an entry
  returned by `all()`.
- Registration fails closed and reports every fault, not just the first. There
  is no partial registration: a half-loaded company is one whose policy packs
  may not have loaded.

New diagnostic codes: `PLUGIN_INVALID`, `PLUGIN_DUPLICATE_ID`,
`PLUGIN_CAPABILITY_ESCALATION`, `PLUGIN_VERSION_INCOMPATIBLE`,
`PLUGIN_REGISTER_FAILED`, `COMPANY_MANIFEST_UNREADABLE`,
`COMPANY_PLUGIN_UNRESOLVED`, `COMPANY_PLUGIN_INVALID`.

## Layering

Dependencies point inward, and `tooling/assert-architecture.ts` enforces it.

```
company packages  →  plugin-sdk, manifest, types, sdk      (public only)
                            ↑
apps/*  →  company, runtime, compiler  →  ports, ir  →  types
                            ↑
        adapters (engine-memory, policy-memory, approval-memory, checkpoint-memory)
```

- Public packages — `sdk`, `manifest`, `types`, `plugin-sdk` — may import
  public packages **only**, stated as a closed set so a new internal package is
  forbidden by default.
- Company packages are bound by the same rule, plus the vendor list in 009 §12.
- The scan reads every `from`, `import`, `import()` and `require` in
  `packages/`, `apps/`, `examples/`, `tooling/` and `scripts/`, and normalises a
  relative specifier to the package it lands in — `../../runtime/src/index.js`
  is treated as `@forge/runtime`. Until this existed, `test:architecture` only
  checked hand-written strings and would have passed with the repo in full
  violation.
- Core must never import a company extension (`forge.gusto`, `forge.acme`).
- Adapters are bound only in composition roots: `apps/api`, `apps/worker`, and
  `packages/composition` for the local stack.

**Core is generic. Company packages are specific.** Core owns the role *contract*; a
company package owns the *roster*. If you are about to put a benefits or payroll term
in `packages/`, it belongs in a company repository instead.

## Verifying

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage
pnpm test:architecture && pnpm test:security
pnpm security:secrets && pnpm security:licenses
pnpm measure:phase1
```

All nine must exit `0` — that is exactly what CI runs, in that order. Run the whole
sequence before claiming a change is done; `pnpm test` alone has passed while
`typecheck` was broken.

`pnpm test:security` is the adversarial suite: it tries to reach an effect without a
gate, reuse or forge an approval, escalate a capability, and steer a decision from
workflow content. It is the standing regression for the red-team pass that once found
an orphaned effect running ungated — treat a failure there as a real hole, not a
flaky test.

`pnpm lint` runs Biome's recommended rules plus `noExplicitAny`, not formatting
alone. `pnpm test:coverage` enforces per-package floors, highest on `compiler` and
`runtime` — a new package cannot arrive untested, and a regression is reported
against the package that caused it rather than diluted into a global average.

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
| Plugin SDK, company model, capability closure | `docs/009-plugin-sdk.md` |
