# 013 — Testing Strategy

**Status:** Handbook (normative)  
**Audience:** All engineers; CI owners  
**Related:** [003-project-constitution](./research/RAW.md) · [014-security](./014-security.md) · [015-phases](./015-phases.md) · [016-demo-scenarios](./016-demo-scenarios.md)  
**Research:** [013-testing.research.md](./research/013-testing.research.md)

---

## 1. Purpose

Forge testing makes the project constitution **mechanically enforceable**. Tests are not an afterthought — they encode “Adapters at every boundary,” “Policies before permissions,” “Humans approve,” and “Compile, don’t configure.”

This document defines:

- Test taxonomy and tooling
- Layer-specific standards (unit → acceptance)
- Architecture fitness functions
- Contract and conformance suites
- CI topology
- Phase quality gates (RAW four gates + Forge extensions)

---

## 2. Goals & non-goals

### Goals

- Every constitution rule maps to at least one automated check.
- Default CI uses **mock provider** — no live LLM, no flake, no wallet drain.
- Architecture violations fail PRs as hard as unit test failures.
- Demo scenarios ([016](./016-demo-scenarios.md)) have automated acceptance paths.

### Non-goals

- 100% line coverage on thin adapters (focus on pure packages and invariants).
- Live provider tests in default CI (opt-in via `LIVE_PROVIDER=1`).
- Pact Broker before external plugin ecosystem exists (start with Zod contracts).

---

## 3. Constitution → enforcement map

| Constitution rule | Enforcement |
|-------------------|-------------|
| Adapters at every boundary | dependency-cruiser + eslint boundaries |
| Zod v4 at boundaries | Contract + boundary unit tests; reject unsafe parse |
| Compile, don’t configure | Compiler golden/snapshot tests |
| Policies before permissions | Integration: policy denies prompt override |
| Humans approve | Acceptance: gates cannot be skipped by model output |
| Disposable sandboxes | Testcontainers lifecycle tests |
| Never expose internals | Public API / package export tests |
| OTEL substrate; LangSmith via adapter | Arch test: no direct langsmith in core |

---

## 4. Tooling stack (locked)

| Layer | Tool | Notes |
|-------|------|-------|
| Unit / integration | **Vitest** (projects mode) | Native TS/ESM; Vitest 4 `projects` not deprecated workspaces |
| Monorepo orchestration | **pnpm workspaces + Turborepo** | Per-package `vitest run` in CI |
| E2E / UI / demos | **Playwright** | Multi-step approval flows |
| Architecture fitness | **dependency-cruiser** + eslint boundaries | CI hard fail |
| Containers | **Testcontainers for Node** | Redis, Postgres, OPA, sandbox image |
| Contracts | **Zod fixture suites** (Phase 0–2); Pact optional Phase 3+ | `@forge/contracts` package |
| Coverage | Vitest v8 + Turborepo artifact merge | Floors on critical packages |
| Security gate | Gitleaks + Trivy (+ Semgrep) | See [014-security](./014-security.md) |

### 4.1 Monorepo layout

```
apps/          → vitest.config.ts per app
packages/      → vitest.config.ts per package
vitest.shared.ts
vitest.config.ts   # projects: ['packages/*', 'apps/*']
```

**Rules:**

- CI always uses `vitest run` (never bare `vitest` — watch hangs Turborepo).
- Shared config in `vitest.shared.ts`; projects use `mergeConfig` / `extends`.
- File suffixes: `*.unit.test.ts`, `*.int.test.ts`, `*.contract.test.ts`, `*.arch.test.ts`, `*.e2e.test.ts`.

---

## 5. Test layers

### 5.1 Unit tests

**Scope:** Pure domain, compiler IR transforms, Zod schemas, policy input mappers, prompt renderers, adapter mappers (mocked ports).

**Standards:**

- No network, Docker, or real LLM.
- Table-driven tests for schema/compiler edge cases.
- Mock **ports**, not engine internals.
- Coverage floors: **high** on `workflow-compiler`, `policy`, `schemas`; lower on thin adapters.

**Must-cover examples:**

- Zod v4: `safeParse` only; invalid provider payloads → typed errors.
- Prompt assets: version pin + required variables enforced.
- Approval gate FSM: `pending → approved|rejected|expired`; no skip transitions.
- Public barrels do not re-export LangGraph/BullMQ types.

### 5.2 Integration tests

**Scope:** Port ↔ adapter with real infra where it matters.

| Integration | Strategy |
|-------------|----------|
| Queue / Redis | Testcontainers Redis |
| Checkpoints | Testcontainers Postgres |
| Sandbox | Testcontainers GenericContainer (forge-sandbox image) |
| Provider | Mock always; live Claude behind `LIVE_PROVIDER=1` opt-in |
| OPA | Testcontainers OPA or in-process WASM |
| OpenTelemetry | In-memory exporter; spans for compile → run → gate |

**Standards:**

- Pin image tags (`redis:7.4-alpine`, not `latest`).
- Suite `beforeAll` start / `afterAll` stop; `.withReuse()` local only.
- Timeouts ≥ 60s for container suites.
- Docker-required jobs **fail closed** if Docker unavailable — no silent skip.

### 5.3 Architecture / fitness tests

#### A. dependency-cruiser (CI hard fail)

Minimum rules:

1. `packages/core/**` ↛ `langgraph`, `@langchain/*`, `bullmq`, `@anthropic-ai/*`
2. `apps/ui/**` ↛ engine internals; `@forge/sdk` only
3. Plugins ↛ other plugins’ private internals
4. No circular deps across packages
5. Production code ↛ `*.test.ts` / fixtures
6. `examples/**` → public SDK only
7. `packages/**` ↛ `forge.gusto/**`, `examples/**`

#### B. ESLint boundaries

Mirror depcruise in editor via `eslint-plugin-boundaries` or `no-restricted-imports`. Ban `any`; ban deep cross-package relative imports.

#### C. Vitest architecture tests (semantic)

Examples depcruise cannot express:

- Compiled graph inserts approval nodes where manifest marks `requiresApproval`.
- Adapter registry rejects duplicate provider IDs.
- OpenFeature flags cannot widen capabilities beyond policy allowlist.
- Policy package has no import from prompt renderer for authz decisions.

**Fitness cadence:**

| Class | When |
|-------|------|
| Fast | Every PR: deps, forbidden imports, cycles |
| Medium | Nightly / phase gates: module size, API snapshot, license policy |
| Slow | Nightly: sandbox escape regression; live provider smoke (opt-in) |

### 5.4 Contract tests

#### Provider conformance (`@forge/provider-conformance`)

Every provider adapter must pass:

1. `initialize` / `health` / `shutdown` lifecycle
2. `invoke` emits Zod-validated events only
3. Tool proposals are capabilities, not grants
4. Cancellation mid-stream
5. Resume after human gate
6. Errors map to Forge codes (no vendor leakage)
7. No secret echo in logs/events

Ship **mock provider** as reference implementation.

#### Plugin conformance (`@forge/plugin-conformance`)

1. Manifest Zod parse
2. Declared tools ⊆ allowed capability classes
3. Cannot register tools outside declared scopes
4. Sandbox FS/network defaults applied
5. Version compatibility (`engines.forge`)
6. Untrusted plugin fixture: privilege escalation → denied

#### Versioning

- Schemas versioned (`ProviderEventV1`, …).
- Breaking changes require ADR + dual-run period.
- CI consumers test against **published contract package**, not private internals.

### 5.5 Workflow compiler tests

Treat compiler as a **deterministic product**.

| Category | Artifact |
|----------|----------|
| Lex/parse | Manifest fixtures |
| Validate | Error snapshots |
| Lowering | IR golden files |
| Emit | Adapter-level only; core never imports LangGraph |
| Idempotence | Same manifest → identical IR hash |
| Capability wiring | IR contains capability IDs from policy, not prompt text |
| Gate insertion | Structural IR tests for `requiresApproval` |
| Prompt binding | Reject inline magic strings |

**Anti-goals:** No LangGraph class names in core tests; no network/LLM; no company-specific workflow IDs in core fixtures.

### 5.6 Sandbox tests

| Environment | Use |
|-------------|-----|
| In-memory fake | Adapter interface unit tests |
| Docker Testcontainers | CI integration of sandbox port |
| gVisor / Firecracker | Staging / security regression (Linux-only) |

**Negative tests (required before sandbox GA):**

- Write outside workspace → denied
- Reach metadata IP / host network → denied
- Read uninjected env secrets → denied
- Fork bomb / CPU spin → cgroup kill / timeout

### 5.7 Demo acceptance tests

Black-box proofs aligned with [016-demo-scenarios](./016-demo-scenarios.md):

- Start workflow via public API / CLI
- Mock provider by default
- Exercise approval UI or API
- Resume; assert OTel spans + business outcome

**Harness:** Playwright (UI path) + Vitest/fetch (API path). Tag `@acceptance` / `@demo`. Run on `main` + nightly; PR subset if fast enough.

---

## 6. Universal quality gates (RAW four + extensions)

Every phase in [015-phases](./015-phases.md) ends with these gates:

### 6.1 RAW four gates

| Gate | Meaning | Typical enforcement |
|------|---------|---------------------|
| **Unit tests** | New code covered; contracts green | `turbo test --filter=...`; coverage on touched packages |
| **Architecture tests** | No boundary violations | `depcruise` + eslint + arch Vitest |
| **Performance thresholds** | Compiler/runtime budgets | Bench job; `budgets.json` p95 limits |
| **Security scan** | Secrets/vulns/licenses | Gitleaks + Trivy (+ Semgrep) |

### 6.2 Forge extensions (Phase 2+)

| Gate | Meaning |
|------|---------|
| **Contracts** | Provider + plugin conformance green |
| **Acceptance** | Phase demo scenarios automated and passing |

### 6.3 Exit criteria template

```text
Quality Gates
-------------
[ ] Unit: required suites pass; coverage floors met for changed packages
[ ] Architecture: depcruise + eslint boundaries + arch tests pass
[ ] Performance: budgets in budgets.json not exceeded
[ ] Security: secret scan clean; CRITICAL/HIGH vulns = 0 (or waived ADR)
[ ] Contracts: provider + plugin conformance green
[ ] Acceptance: phase demo scenarios automated and passing
```

---

## 7. Phase gate matrix

| Phase | Unit | Arch | Perf | Security | Extra |
|-------|------|------|------|----------|-------|
| **0 Research** | n/a | n/a | n/a | Threat model draft | ADRs complete |
| **1 Skeleton** | Package smoke | Forbidden imports on | Baseline compile budget | Gitleaks + license | `tsc` clean |
| **2 Providers + compiler** | Conformance required | Adapter isolation strict | Compiler golden perf | Container image scan | Testcontainers job |
| **3 Gates + policies** | Policy + gate FSM | Prompt ↛ permission import | Gate latency budget | Prompt-injection suite | Approval cannot skip |
| **4 Demo orgs** | — | examples → SDK only | Demo E2E time budget | ZAP baseline on UI | Playwright A1–A5 |
| **5 Gusto** | Company package tests | gusto ↛ core internals | — | Tenant isolation | G1–G2 acceptance |
| **6 UI + observability** | UI component tests | UI SDK-only | — | CSP header tests | Full taxonomy spans |
| **7 Production** | Mutation optional | Full fitness catalog | Load test queue | SBOM + signed artifacts | Chaos: kill sandbox mid-run |

---

## 8. CI topology

```text
PR (fast):
  lint + typecheck
  unit (turbo, no docker)
  architecture (depcruise + eslint)
  contract/conformance
  security: gitleaks + trivy fs

PR (docker):
  integration (testcontainers)
  sandbox negative tests (subset)

main / nightly:
  full acceptance (Playwright)
  perf budgets
  full image scan + SBOM
  prompt-injection / policy bypass suite
```

---

## 9. Observability in tests

- Assert **Forge** span names (`forge.policy.decide`, etc.), not LangSmith internals.
- LangSmith only in opt-in live tests behind adapter.
- In-memory OTEL exporter default for unit/integration.

---

## 10. Flake & quarantine policy

- Deterministic clocks (`vi.useFakeTimers` or `@sinonjs/fake-timers`).
- Seeded mock provider responses.
- Quarantined tests must be `@quarantine` tagged, tracked in issue, and **cannot** block phase exit without ADR.
- Sandbox escape suite may be nightly but **required** before sandbox GA exit.

---

## 11. Open questions

| ID | Question | Impact |
|----|----------|--------|
| T-1 | Turborepo vs Nx | CI cache layout |
| T-2 | In-process vs isolated plugins | Contract + sandbox tests |
| T-3 | Firecracker in v1 vs Docker-only | Security CI matrix |
| T-4 | Pact Broker vs Zod only | Plugin ecosystem |
| T-5 | Coverage floors per package | Gate strictness |
| T-6 | Live provider in CI | Cost, secrets, flake |
| T-7 | OpenFeature vs OPA decision split | Assertion ownership |

---

## 12. Recommendations summary

1. Standardize on **Vitest + Playwright + dependency-cruiser + Testcontainers** from Phase 1.
2. Treat architecture tests as **equal to unit tests**.
3. Ship **conformance packages** before external authors exist.
4. **Compiler golden IR** is the regression shield for “Compile, don’t configure.”
5. Phase gates always include **RAW four**; add contracts + acceptance from Phase 2–4.
6. Default CI = **mock provider**; live LLM opt-in only.
7. Defer Pact Broker; **do not** defer schema contracts.
