# ADR-010: Incident capture and the learning loop

- **Status:** Proposed
- **Date:** 2026-08-04
- **Deciders:** Forge architects
- **Evidence:** `packages/compiler` — `WF_UNTYPED_EDGE`, `WF_MISSING_APPROVAL` as the graduation examples

## Context

full-send ships a command, `/oof`, that turns a mid-run frustration into a
structured lesson: it reads the recent transcript, drafts a diagnosis, the
operator reviews it, and the insight is committed to a team library on `main`
where subsequent projects read it. Optionally it opens a fix pull request.

It works, and it is the most novel thing in that pipeline. It is also the one
capability that does not port to Forge unchanged, because it does two things at
once:

1. **Captures** that something went wrong.
2. **Changes** what happens next time, by landing prose that alters behaviour
   without a rebuild.

The second is precisely what a sealed, fingerprinted artifact exists to prevent.
Behaviour that can shift underneath a running pipeline is drift, and the
fingerprint is the mechanism that makes drift impossible. Porting `/oof`
literally would require punching a hole in the property the platform is built
around.

Doing nothing is also wrong. A pipeline that cannot learn from its own misfires
accumulates them, and "fix it silently" is the anti-pattern full-send correctly
identifies.

## Decision

**Separate capture from behaviour change. Capture is always on and is a
first-class runtime record; behaviour change is a versioned, reviewed edit to a
declaration.**

### Capture — an incident is the mirror of an approval

`IncidentPort` sits beside `ApprovalPort` with the same shape and durability:

- An **approval** records that a human authorised a behaviour at a point in a run.
- An **incident** records that a human rejected one.

An incident binds to `runId`, `checkpointId`, and `nodeId`, and carries the
asset versions the artifact had pinned at that point — prompt, role, policy
pack, judge, and the artifact fingerprint.

This is strictly better evidence than a transcript window. Forge already writes
durable checkpoints at node boundaries, so the diagnosis attaches to recorded
state rather than being reconstructed from a scrollback. It also makes an
otherwise impossible question answerable: *how many incidents does
`architect@2.3.0` have across every run?*

### Triage — the taxonomy comes free

Behaviour originates in a small number of declarations, so a misfire classifies
cleanly and routes to the file that actually owns it:

| Class | Routes to |
|---|---|
| prompt defect | the role or prompt asset — bump the version |
| graph defect | `workflow.yml` — an edge that should not exist |
| gate defect | `gates.yml` — a predicate that is too loose |
| policy defect | `policy/*.yml`, or a compiler bug |
| panel defect | `panel.yml` — reweight, or summon another lens |
| compiler gap | a shape that should never have compiled |

Triage is a `judge` node and therefore fails closed: an unclassifiable incident
escalates to a person rather than being filed.

### Landing — a version bump, never a live edit

A fix is a pull request against a declaration. Nothing commits without a human,
and **no running artifact mutates** — a run executes the artifact it was sealed
with, to completion. The fix applies at the next compile.

### The graduation path

The strongest outcome is the last row of the table. If a misfire was possible
because the graph permitted it, the fix is not a lesson but a new diagnostic,
and the mistake becomes unrepresentable for every company package.

This is already demonstrated rather than hypothesised. The canonical reported
misfire — *"it skipped the skeptic pass and planned straight off my framing"* —
is implemented in the prototype as `WF_BYPASSABLE_REQUIRED_NODE`, with the
bypassing edge as a fixture. A prose lesson depends on being read; a diagnostic
does not.

## Consequences

**Positive.** Capture is sharper: addressable, queryable, attributable to a
version. Fixes are reviewable and revertible. In-flight runs are immune to a
mid-flight change. Recurring misfires can be promoted into compiler checks,
which is a learning loop that closes permanently rather than repeatedly.

**Negative — and this is the real cost.** Forge is **slower to learn than
full-send**. `/oof` lands an insight on `main` and the next project benefits
immediately. This design requires a version bump, a review, and a recompile.
For a pipeline that opens pull requests and flips production flags, paying that
ceremony to prevent drift is the right trade, but it is a trade and it should
not be presented as a free win.

**No soft-guidance channel.** full-send's team library is prose a model reads as
context, which changes behaviour without a rebuild. Forge deliberately has no
equivalent. Nudging behaviour means bumping a prompt asset, which is heavier
than adding a paragraph. If a lighter channel is ever wanted, it needs its own
ADR and a clear answer for how it stays inside the fingerprint.

**Adoption risk.** A capture mechanism that feels slower than the one it
replaces gets used less. If incident volume drops after adoption, that is a
signal the ceremony is too high, not that the pipeline got better.

## Alternatives considered

**Port `/oof` literally, with a live team library.** Rejected: behaviour that
changes without a fingerprint change is exactly the drift the seal prevents, and
it would make a run non-reproducible.

**Capture only, no routing.** An incident log nobody triages is a backlog.
Rejected because the routing table is most of the value — it converts a
complaint into a specific file to edit.

**Treat incidents as ordinary tickets.** Loses the checkpoint binding and the
asset-version attribution, which are the two things that make this better than
what exists.

**Allow hot-patching a running artifact for severe cases.** Tempting for
incidents caught mid-run. Rejected for now: it reintroduces drift for the exact
population of runs that are already going wrong, which is the worst time to make
behaviour unreproducible. Restart against a new compile instead.

## References

- [006 — Runtime](../006-runtime.md) §4 core concepts, §6.4 `ApprovalPort`
- [007 — Workflow compiler](../007-workflow-compiler.md) §11 diagnostics catalog
- [011 — Observability](../011-observability.md) — audit events
- [ADR-009 — Agent roles](./009-agent-roles.md) — what an incident attributes to
- `packages/panel/` — `WF_BYPASSABLE_REQUIRED_NODE` and its fixture
