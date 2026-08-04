# Prototype — config compiler

**Status:** research prototype · not the compiler
**Phase:** 0 (permitted by the `Research → ADR → Benchmark → Prototype → Tests → Implementation` pipeline in [MASTER_SPEC](../../../MASTER_SPEC.md) §6)
**Evidence for:** [ADR-009](../../adrs/009-agent-roles.md), [ADR-010](../../adrs/010-incident-capture.md)

## Why this exists

Three claims were being made in design documents and slide decks without anything
behind them:

1. A side effect that can reach a customer cannot compile without an approval gate.
2. A role cannot hold a capability that policy has not granted.
3. A required node cannot be bypassed.

Those are either mechanically checkable or they are marketing. This prototype
settles it. It loads the YAML configuration model, runs the checks, and either
emits a sealed artifact with a fingerprint or refuses with structured
diagnostics.

## Run it

```sh
node --test compile.test.mjs
```

Twenty tests, no dependencies, no network. The compiler honours the purity rule
in MASTER_SPEC §7: no HTTP, no queue, no model, no clock, no filesystem writes.
Reading fixtures happens in the test, not in the compiler.

## What is proven

| Diagnostic | What it catches |
|---|---|
| `WF_MISSING_APPROVAL` | a path reaches a side effect without passing the approval that names it |
| `WF_CAPABILITY_UNBOUND` | a role requires a capability outside the static policy closure, or one it forbids itself |
| `WF_UNKNOWN_ROLE` | a node or panel references a role that is not declared |
| `WF_BYPASSABLE_REQUIRED_NODE` | a node marked required can be skipped on some path to a terminal |
| `WF_UNDECLARED_EFFECT` | an effect node causes something absent from `sideEffects[]` |
| `WF_CYCLE` | the step graph contains a dependency cycle |

Also proven:

- **Fingerprints are deterministic** and move when any declaration changes —
  a role weight, a workflow version, or the compiler version itself.
- **Panels compose from predicates.** A docs-only change draws two reviewers; a
  change touching `namedCredentials/` and declaring a backfill draws four, two
  of them with veto rights.
- **Verdicts fail closed.** A missing or errored vote resolves to `review`,
  never to `pass`. A blocking role voting `fail` overrides quorum.

`WF_BYPASSABLE_REQUIRED_NODE` is the interesting one. The real reported misfire
that motivated it — *"it skipped the skeptic pass and planned straight off my
framing"* — is not a lesson to write down here. It is a compile error, and
`fixtures/broken/bypassable.workflow.yml` is that exact shape.

## Layout

```
src/yaml.mjs      minimal YAML subset loader, zero dependencies
src/compile.mjs   the checks, the artifact, the fingerprint
src/panel.mjs     summon predicates, glob matching, weighted quorum, verdicts
fixtures/valid/   a config that compiles
fixtures/broken/  one file per failure mode, each a one-edge or one-line delta
```

## What this is not

- **Not the compiler.** No IR, no engine lowering, no `EnginePlan`, no sealed
  artifact store. The output object is a stand-in shaped like the real one.
- **Not a runtime.** Nothing executes, checkpoints, or approves.
- **Not a YAML implementation.** The loader supports the subset these fixtures
  use and throws on anything else, which is deliberate — a parse failure is a
  real signal rather than a silent gap.

## What it changes

Before this, the statement "Forge is design-complete and pre-implementation"
was true without qualification. It is now more precise: the *runtime* is
unimplemented and still gated behind the phase exit criteria, but the central
safety claim is no longer only asserted — it runs, and it fails builds.
