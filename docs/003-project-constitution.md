# 003 — Project Constitution

**Status:** Normative — **never violate without explicit ADR supersession**  
**Audience:** All contributors, implementation agents, reviewers  
**Last updated:** 2026-08-02  
**Related:** [001-vision](./001-vision.md) · [004-architecture](./004-architecture.md) · [005-research-workflow](./005-research-workflow.md) · ADRs in `docs/adrs/`

---

## Purpose

This document is Forge's **constitution**: engineering standards, architectural invariants, and explicit prohibitions that apply to every line of code, every ADR, and every demo. Violations are defects—not style preferences. CI and architecture tests enforce what can be automated; reviewers enforce the rest.

When constitution and convenience conflict, **constitution wins** until an ADR explicitly supersedes a rule with dated rationale.

---

## Non-goals

This document does **not**:

- Describe package layout (see [004-architecture](./004-architecture.md)).
- Replace ADRs for technology choices.
- List every ESLint rule (tooling encodes subsets).
- Grant exceptions for "temporary" hacks—use throwaway spikes in Phase 0 only ([005](./005-research-workflow.md)).

---

## Identity principles (embedded)

These eight principles from RAW are **constitutional**. Every spec and ADR must align.

| # | Principle | Constitutional implication |
|---|-----------|----------------------------|
| 1 | **Compile. Don't Configure.** | No public hand-wiring of LangGraph, BullMQ, or provider clients |
| 2 | **Deterministic Infrastructure. Intelligent Execution.** | Infra behavior is declared and tested; LLMs only in agent nodes |
| 3 | **Extension over Replacement.** | Company logic in packages; core never imports `forge.gusto` or `examples/*` |
| 4 | **Adapters at Every Boundary.** | Vendor code only in `adapters-*` packages |
| 5 | **Prompts are Versioned Assets.** | No inline production prompts; semver + immutable IDs |
| 6 | **Policies before Permissions.** | OPA Wasm decides; prompts never authorize |
| 7 | **Humans own the final decision.** | Side effects require human approval unless policy explicitly allows |
| 8 | **Research before Implementation.** | Phase 0 complete before Phase 1 production code |

---

## Engineering standards (full constitution list)

The following rules are **mandatory** for all Forge core and company packages.

### Language and types

| Rule | Requirement |
|------|-------------|
| **Strong TypeScript** | Strict mode; explicit return types on public APIs |
| **No `any`** | Use `unknown` + narrowing or typed generics |
| **Branded IDs** | `WorkflowId`, `RunId`, `CompanyId`—not raw strings |
| **Exhaustive unions** | Discriminated unions for IR nodes, job types, run statuses |
| **No magic strings** | Constants module or branded literals |
| **No magic numbers** | Named constants with units and rationale |

### Validation and boundaries

| Rule | Requirement |
|------|-------------|
| **Zod v4 at every boundary** | HTTP, queue payloads, manifest load, sandbox IPC, env parsing |
| **Safe parsing only** | `safeParse` / Result types—no `parse` that throws on untrusted input |
| **Typed workflows** | Input/output schemas on every workflow |
| **Typed skills** | Capability declarations + I/O schemas |
| **Typed policies** | Policy pack schemas; evaluation inputs typed |
| **Typed prompts** | Prompt assets with version and variable schemas |
| **Typed provider interfaces** | `ProviderPort` only—no vendor types in callers |

### Architecture

| Rule | Requirement |
|------|-------------|
| **KISS** | Simplest design that satisfies requirements |
| **SOLID** | Single responsibility per package; interface segregation on ports |
| **Clean Architecture** | Dependencies point inward |
| **Ports & Adapters** | Domain/runtime depends on port interfaces only |
| **Dependency Injection** | Constructor injection at composition roots |
| **Composition over inheritance** | Prefer factory modules over deep class hierarchies |
| **Adapters at every boundary** | See [004](./004-architecture.md) port table |

### Configuration and secrets

| Rule | Requirement |
|------|-------------|
| **Env only for secrets** | API tokens, webhook secrets, DB passwords |
| **Config for everything else** | Feature defaults, adapter endpoints, org config refs |
| **Version everything** | Workflows, prompts, skills, policies, compiler, artifacts |
| **Feature flags** | OpenFeature for rollout only—not authz ([ADR-007](./adrs/007-policy.md)) |

### Resilience and operations

| Rule | Requirement |
|------|-------------|
| **Timeouts** | Every external call and agent step |
| **Circuit breakers** | Provider and adapter calls per [PACKAGE-EVIDENCE](./research/PACKAGE-EVIDENCE.md) |
| **Retry policies** | Declared in IR; separate transport vs workflow retry |
| **Rate limiting** | API and provider-facing endpoints |
| **Structured logging** | `@simpill/logger.utils` patterns |
| **OpenTelemetry** | All runs and steps emit spans ([ADR-006](./adrs/006-observability.md)) |
| **LangSmith through adapters** | Never direct import in domain |

### Security

| Rule | Requirement |
|------|-------------|
| **Security headers** | API responses per `014-security.md` |
| **CSP** | UI deployables |
| **Secret scanning** | CI pipeline |
| **SBOM generation** | Release artifacts |
| **License validation** | Dependency allowlist |
| **Vulnerability scanning** | CI blocking on critical CVEs |
| **Human approval gates** | Side effects default to RequireApproval |
| **Policies before permissions** | OPA Wasm fail closed ([ADR-007](./adrs/007-policy.md)) |

### Development workflow

| Rule | Requirement |
|------|-------------|
| **Worktrees** | Isolated dev branches for parallel agent work |
| **Disposable sandboxes** | Untrusted execution via `SandboxPort` ([ADR-003](./adrs/003-sandbox.md)) |
| **Research before implementation** | [005-research-workflow](./005-research-workflow.md) |

---

## What not to build (never-build list)

The following are **explicitly forbidden**. PRs that introduce these are rejected without debate.

### Public API prohibitions

| Never | Rationale |
|-------|-----------|
| **Expose LangGraph publicly** | Vendor coupling; violates Compile + Adapters |
| **Expose BullMQ publicly** | Queue is transport, not workflow API |
| **Expose Claude-specific APIs** | Provider is swappable ([ADR-005](./adrs/005-provider.md)) |
| **Expose ACPX publicly** | Optional private mesh only |
| **Expose `@simpill/acp-llm-cli` publicly** | Provider harness is adapter-internal |
| **Expose provider-specific models as required API** | Map via config/adapters |
| **Expose raw checkpoint blobs** | Forge Run/progress concepts only |
| **Expose EnginePlan structure** | Opaque brand ([ADR-002](./adrs/002-workflow-engine.md)) |
| **Expose LangGraph interrupt APIs to UI/SDK** | Map to Forge approval gates |

### Core content prohibitions

| Never | Rationale |
|-------|-----------|
| **Hardcode company logic in core** | Extension over Replacement |
| **Hardcode repository names** | Company config refs |
| **Hardcode Jira projects** | Company config refs |
| **Hardcode Slack channels** | Company config refs |
| **Import `forge.gusto` from core** | Dependency direction ([ADR-001](./adrs/001-monorepo-layout.md)) |
| **Import `examples/*` from core** | Demo is consumer, not dependency |

### Authorization prohibitions

| Never | Rationale |
|-------|-----------|
| **Let prompts determine permissions** | Policies before Permissions |
| **Let LLMs bypass deterministic gates** | Humans own final decision |
| **Use OpenFeature as sole authz** | Flags ≠ policy ([ADR-007](./adrs/007-policy.md)) |
| **Trust CLI permission handler alone** | Wire to Forge PolicyPort + ApprovalPort |

### Process prohibitions

| Never | Rationale |
|-------|-----------|
| **Skip Phase 0 research for significant features** | Research before Implementation |
| **Merge "temporary" core forks for company** | Use company package |
| **Commit secrets to manifests or repo** | Env/secret manager only |
| **Use `process.env` checks scattered in domain** | Config objects + FeatureFlagPort |

---

## Normative rules (operational)

### NR-1: Boundary parsing

Every ingress point implements:

```typescript
const result = Schema.safeParse(untrustedInput);
if (!result.success) {
  return failWithDiagnostic(result.error); // stable error code
}
```

No exceptions for "internal" queue messages—workers are a trust boundary.

### NR-2: Dependency direction

```
@forge/sdk | manifest | types | plugin-sdk
  ↛ adapters-* | runtime | compiler | ir | vendor packages

forge.gusto | examples/acme
  → @forge/* (public only)

core packages
  ↛ forge.gusto | examples/*
```

Enforced by `dependency-cruiser` ([004](./004-architecture.md)).

### NR-3: Composition roots

Only `apps/api`, `apps/worker`, `apps/ui`, and test harnesses may:

- Instantiate adapters
- Read secrets from environment
- Wire concrete `QueuePort`, `GraphEnginePort`, etc.

### NR-4: Compiler purity

`@forge/compiler` must not import network adapters, Redis, LLM clients, or call `Date.now()` for control flow. Fingerprints must be reproducible for identical inputs.

### NR-5: Approval durability

When run enters `AWAITING_APPROVAL`:

1. Persist checkpoint and approval record
2. Ack queue job (release worker)
3. Emit observability event
4. Never hold BullMQ lock across human time ([ADR-004](./adrs/004-queue.md))

### NR-6: Policy fail-closed

On `PolicyPort` error, timeout, or Wasm failure: **Deny**. Log structured error. Never default to Allow.

### NR-7: Prompt resolution

Workflows reference prompts by ID + semver range. Compiler resolves to immutable prompt version at compile time. Runtime does not fetch "latest" prompt silently.

### NR-8: Capability closure

Before compile completes, verify every skill's `requiredCapabilities[]` is satisfiable given registered policy packs and plugin declarations. Unsatisfied capability → compile error.

---

## Technology constitution (ADR-locked)

These ADRs are constitutional for technology selection:

| ADR | Locked choice |
|-----|---------------|
| [ADR-001](./adrs/001-monorepo-layout.md) | pnpm workspace; core / examples / forge.gusto layout |
| [ADR-002](./adrs/002-workflow-engine.md) | LangGraph internal; opaque EnginePlan |
| [ADR-003](./adrs/003-sandbox.md) | SandboxPort; Docker MVP; Testcontainers CI |
| [ADR-004](./adrs/004-queue.md) | BullMQ internal; ForgeJob DTOs |
| [ADR-005](./adrs/005-provider.md) | `@simpill/acp-llm-cli` harness; mock provider |
| [ADR-006](./adrs/006-observability.md) | OpenTelemetry substrate |
| [ADR-007](./adrs/007-policy.md) | OPA Wasm PolicyPort |

Deviating requires superseding ADR with migration plan.

---

## Rationale

### Why a constitution separate from architecture?

Architecture describes structure; constitution describes **inviolable behavior**. Agents optimize for "make it work." Constitution prevents local optima (re-export LangGraph "for convenience") that destroy long-term extension.

### Why list "what not to build"?

Forbidden patterns are cheaper to enforce proactively than to remove after SDK consumers depend on them. The never-build list is the negative space of the vision ([001](./001-vision.md)).

### Why Zod v4 everywhere?

Untyped boundaries caused seven of the problem themes in [002](./002-problem-statement.md). Schema validation is the cheapest deterministic gate before policy and HITL.

---

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| "Guidelines" without enforcement | Agents ignore; drift guaranteed |
| Lint-only (no architecture tests) | Cannot catch transitive vendor imports |
| Runtime-only validation | Failures too late; no compile-time closure |
| Prompt-based guardrails | Not auditable; violates Policies before Permissions |
| Single "AGENTS.md" instead of constitution | Insufficient detail for 150+ page spec |

---

## Enforcement

| Mechanism | Phase | Enforces |
|-----------|-------|----------|
| TypeScript `strict` | 1 | No implicit any |
| ESLint `@typescript-eslint/no-explicit-any` | 1 | No any |
| dependency-cruiser | 1 | Import boundaries |
| Custom architecture tests | 1 | Public ↛ vendor |
| Zod boundary tests | 2 | NR-1 |
| Policy deny integration tests | 4 | NR-6, never-build authz |
| Demo acceptance (016) | 5+ | HITL, extension, compile |

Constitution violations **block merge** regardless of feature completeness.

---

## Acceptance criteria

Constitution is **accepted** when:

- [ ] Full engineering standards list from RAW is present (this document § Engineering standards).
- [ ] Full never-build list from RAW is present (this document § What not to build).
- [ ] All eight identity principles are embedded with implications.
- [ ] NR-1 through NR-8 are testable.
- [ ] ADR-001 through ADR-007 referenced as technology constitution.
- [ ] Enforcement table maps to phases in `015-phases.md`.
- [ ] No rule contradicts [004-architecture](./004-architecture.md).

---

## Amendment process

1. Open issue describing constitution conflict.
2. Author ADR with alternatives, tradeoffs, migration cost.
3. Update **003** explicitly (date + changelog section below).
4. Update architecture tests and handbook cross-links.
5. Require principal engineer approval—not drive-by PR.

### Changelog

| Date | Change |
|------|--------|
| 2026-08-02 | Initial constitution from RAW + ADR-001–007 |

---

## Agent checklist (pre-PR)

Before opening a PR, confirm:

- [ ] No `any`, no magic strings/numbers in new code
- [ ] Zod safeParse at new boundaries
- [ ] No vendor imports outside adapters
- [ ] No company-specific logic in `packages/@forge/*`
- [ ] No prompt text granting permissions
- [ ] No env reads in domain/runtime (config injection only)
- [ ] ADR exists for new technology
- [ ] Tests include deny/fail-closed path where applicable

**When uncertain:** stop and read [005-research-workflow](./005-research-workflow.md)—do not guess.
