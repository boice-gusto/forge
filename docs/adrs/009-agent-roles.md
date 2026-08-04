# ADR-009: Agent roles as first-class assets

- **Status:** Proposed
- **Date:** 2026-08-04
- **Deciders:** Forge architects
- **Evidence:** `packages/compiler` (capability closure, `WF_CAPABILITY_UNBOUND`) and `packages/panel` (composition, weighted fail-closed verdicts)

## Context

Agentic pipelines in production — full-send being the working example inside
Gusto — run a roster of named working agents: architect, PM, designer,
cx-advocate, domain-qa, launch-coordinator, and specialty roles. Reviews happen
as concurrent sign-offs on artifact pull requests, performed by a panel of those
same agents.

In that implementation a role is a skill file: a prompt plus a tool list. Three
properties follow from that, and all three are problems Forge already has
machinery to solve:

1. **A role's authority is whatever its tools allow.** "The designer cannot
   merge code" is a property of how the skill was written, upheld by care rather
   than by a check.
2. **The review panel is a constant.** A nine-member panel reviews a
   one-line documentation change and a credentials change identically.
3. **A role has no version.** "Which architect reviewed this?" has no answer
   beyond whatever was on `main` that day, so a regression after an edit is
   invisible.

Forge's constitution already says capabilities are closed at compile time,
prompts are versioned assets, and policy decides authorisation. Roles are
currently the gap where those three rules are not applied.

## Decision

**A role is a first-class, versioned asset declared in `roles/*.yml`, and the
platform owns the contract while the company package owns the roster.**

A role declaration has up to three faces, and the workflow selects which is in
use at a given node:

| Face | Meaning | Lowers to |
|---|---|---|
| `produce` | authors an artifact | an `agent` IR node |
| `review` | a lens on the review panel | a `judge` ensemble member |
| `approve` | maps to a human approver group | `approval` node approvers |

The same declaration therefore serves the architect that writes the
architecture section and the architect that reviews a build. Roles that only
review, or only approve, simply omit the other faces.

Three further rules:

**Capabilities are declared and closed.** A role states `requires` and may state
`forbids`. Requiring anything outside the static policy closure is
`WF_CAPABILITY_UNBOUND`; requiring something the role forbids itself is the same
code with a distinct message. This makes "the designer cannot hold merge rights"
a compile error rather than a convention.

**Panels compose from predicates, not from a constant.** `panel.yml` declares a
standing roster plus summonable specialty roles, each carrying a `summon.when`
predicate over the changed paths or the declarations a change makes. This is the
routing model `CODEOWNERS` already applies to human reviewers, extended to the
agent panel. Panel size becomes a consequence of what changed.

**Verdicts are weighted and fail closed.** Each reviewing role carries a
`weight`; a role may be `blocking`, in which case its `fail` overrides quorum. A
missing or errored vote resolves to `review` — never to `pass`.

## Consequences

**Positive.** Role authority becomes checkable before anything runs. Panels
scale with risk instead of being uniformly heavy or uniformly thin. Roles are
pinned into the artifact, so a review is attributable to a semver, and — with
ADR-010 — an incident rate per role version becomes a real quality signal.
Company packages add roles without touching core.

**Negative.** Another declaration file to maintain, and another way for a
predicate to be wrong. A summon predicate that is too narrow silently omits a
reviewer, which is a quieter failure than an over-broad one; `panel.yml` should
be reviewed as security-relevant configuration.

**Cost of the CODEOWNERS parallel.** Reviewer routing and summon predicates are
two hand-maintained lists that can drift apart, exactly as `CODEOWNERS` and
`labeler.yml` already drift in `Gusto/sfdc`. Keeping them in step is an
operational obligation, not something the compiler can check.

## Alternatives considered

**Roles as prompts only.** Simplest, and what full-send does today. Rejected
because it leaves capability closure unenforceable, which is the specific gap
this ADR exists to close.

**Roles as code (a class per role).** Maximum flexibility, but it puts company
domain logic on the implementation side of the boundary that ADR-008 draws, and
makes a role unfingerprintable.

**A fixed panel with configurable membership.** Simpler than predicates, but
keeps the constant-size problem: someone must remember to add the security
reviewer, which is the failure mode being designed out.

**Folding panel composition into a separate ADR.** Considered and rejected — the
panel is meaningless without roles and roles are under-motivated without the
panel, so they are decided together.

## References

- [003 — Project constitution](../003-project-constitution.md) — policies before permissions; prompts are versioned assets
- [007 — Workflow compiler](../007-workflow-compiler.md) §5 IR taxonomy, §10 judge nodes
- [009 — Plugin SDK](../009-plugin-sdk.md) §7 capability model and closure
- [ADR-007 — Policy](./007-policy.md) — fail-closed evaluation
- [ADR-008 — Extension repository topology](./008-extension-repository-topology.md) — core generic, company specific
- `packages/panel/` — working proof of the three checks
