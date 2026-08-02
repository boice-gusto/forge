# Research Notes → `013-testing.md`

**Status:** Phase 0 research (pre-implementation)  
**Audience:** Spec authors / principal engineers  
**Sources:** Forge `RAW.md` constitution, Vitest/Turborepo docs (2025–2026), dependency-cruiser, Testcontainers Node, Pact JS, OWASP agent testing guidance  
**Last updated:** 2026-08-02

---

## 1. Purpose & Spec Contract

`013-testing.md` must define a **test pyramid + fitness functions + phase gates** that make Forge’s non-negotiables mechanically enforceable:

| Constitution rule | How tests enforce it |
|---|---|
| Adapters at every boundary | Architecture tests forbid core → LangGraph/BullMQ/Claude SDK imports |
| Zod v4 at boundaries | Contract + boundary unit tests; reject unsafe parse |
| Compile, don’t configure | Compiler golden/snapshot tests |
| Policies before permissions | Security-oriented integration tests (policy denies prompt override) |
| Humans approve | Acceptance tests that gates cannot be skipped by model output |
| Disposable sandboxes | Testcontainers / sandbox lifecycle tests |
| Never expose internals | Public API surface / package export tests |

**Done for the spec** means: every test layer has tooling, ownership, CI placement, pass/fail criteria, and phase rollout.

---

## 2. Recommended Tooling (TS Monorepo)

### 2.1 Core stack (recommended)

| Layer | Tool | Why |
|---|---|---|
| Unit / most integration | **Vitest** (projects mode) | Native TS/ESM, fast, Vite ecosystem; Vitest 4 uses `projects` (workspaces deprecated) |
| Monorepo orchestration | **pnpm workspaces + Turborepo** | Per-package `vitest run` in CI for cache; root Vitest projects for local DX |
| E2E / UI / demo flows | **Playwright** | Stable for UI + multi-step human-approval demos |
| Architecture fitness | **dependency-cruiser** + **eslint-plugin-boundaries** (or `no-restricted-imports`) | CI graph rules + in-editor feedback |
| Optional ArchUnit-style | **ArchUnitTS / ts-arch** (evaluate) | Call-pattern fitness as Vitest tests |
| Contract (SDK) | **Pact JS** *or* **Zod fixture suites** (see §4) | Provider/plugin SDK stability |
| Containers / infra deps | **Testcontainers for Node** | Real Redis/Postgres/queue/sandbox images |
| Coverage | Vitest coverage (v8) + Turborepo artifact merge in CI | Gate on critical packages first |
| Types as tests | `tsc --noEmit` + **publint** / **@arethetypeswrong/cli** on public packages | Export surface hygiene |
| Perf gates | Vitest bench *or* tiny custom scripts + CI thresholds | Compiler + hot-path budgets |
| Security scan (test gate) | Trivy + Gitleaks + Semgrep/CodeQL | See `014-security` — invoked as quality gate |

### 2.2 Hybrid Vitest layout (actionable)

```
apps/          → package-level vitest.config.ts  (CI: turbo test)
packages/      → package-level vitest.config.ts
vitest.shared.ts
vitest.config.ts   # projects: ['packages/*', 'apps/*'] for local `pnpm test:projects`
```

**Rules:**
- CI scripts must use `vitest run` (never bare `vitest` — watch hangs Turborepo).
- Shared config in `vitest.shared.ts`; projects do **not** inherit root `test` options automatically — use `mergeConfig` / `extends`.
- Tag suites: `*.unit.test.ts`, `*.int.test.ts`, `*.contract.test.ts`, `*.arch.test.ts`, `*.e2e.test.ts`.

### 2.3 Alternatives considered

| Choice | Reject for Forge unless… |
|---|---|
| Jest | Already on Vitest path; migration cost for little gain |
| Cypress | Prefer Playwright for multi-tab approval + API fixtures |
| Full Pact Broker early | Overkill until external plugin ecosystem exists — start with Zod contracts in-repo |
| Docker Compose-only integration | Use as escape hatch; prefer Testcontainers for ephemeral CI |

**UNKNOWN:** Final monorepo tool (Turborepo vs Nx). Recommendation assumes Turborepo; Nx equivalent: target caching + project graph lint.

---

## 3. Test Layers

### 3.1 Unit tests

**Scope:** Pure domain, compiler IR transforms, Zod schemas, policy input mappers, prompt template renderers, adapter mappers (with mocks).

**Standards:**
- No network, no Docker, no real LLM.
- Prefer table-driven tests for schema/compiler edge cases.
- Mock **ports**, never mock implementation details of engines Forge wraps.
- Coverage gate: start **high on pure packages** (`workflow-compiler`, `policy`, `schemas`); lower on thin adapters.

**Must-cover examples:**
- Zod v4: `safeParse` only; invalid provider payloads rejected with typed errors.
- Prompt assets: version pin + required variables.
- Approval gate state machine: pending → approved/rejected/expired; no skip transition.
- Public package barrels do not re-export LangGraph/BullMQ types.

### 3.2 Integration tests

**Scope:** Port ↔ adapter wiring with real infra where it matters.

| Integration | Strategy |
|---|---|
| Queue / Redis | Testcontainers Redis |
| Persistence / checkpoints | Testcontainers Postgres (if used) |
| Sandbox lifecycle | Testcontainers GenericContainer *or* local Docker sandbox image |
| Provider adapters | Mock provider always; live Claude CLI behind `LIVE_PROVIDER=1` opt-in |
| OPA / policy engine | Testcontainers OPA *or* in-process WASM client |
| OpenTelemetry | In-memory exporter assertions (spans for compile → run → gate) |

**Standards:**
- Pin image tags (`redis:7.4-alpine`, not `latest`).
- Suite-level `beforeAll` start; `afterAll` stop; optional `.withReuse()` locally.
- Timeouts ≥ 60s for container suites; isolate flaky suites from unit job.
- Fail closed if Docker unavailable in CI job that requires it (don’t silently skip).

### 3.3 Architecture / fitness tests

**Goal:** Prevent “accidental coupling” that violates ports & adapters.

#### A. dependency-cruiser (CI hard fail)

Enforce at minimum:

1. `packages/core/**` ↛ `langgraph`, `@langchain/*`, `bullmq`, `@anthropic-ai/*`, provider CLIs  
2. `apps/ui/**` ↛ engine internals; only public SDK  
3. Plugins ↛ other plugins’ internals  
4. No circular deps across packages  
5. Production code ↛ `*.test.ts` / fixtures  
6. `examples/**` may depend on public SDK only  

#### B. ESLint boundaries (editor feedback)

- `eslint-plugin-boundaries` or `no-restricted-imports` mirroring depcruise rules.
- Ban `any`; ban deep relative imports across packages (`../../other-pkg`).

#### C. Vitest architecture tests (semantic)

Examples that depcruise cannot express well:

- Compiled workflow graph always inserts approval nodes where manifest marks `requiresApproval`.
- Adapter registry rejects duplicate provider IDs.
- Feature flags (OpenFeature) cannot widen capability sets beyond policy allowlist. **UNKNOWN:** exact OpenFeature vs OPA split — test the invariant regardless of engine.

**Fitness function classes (from industry practice):**
- Fast (every PR): dependency direction, no forbidden imports, no cycles.
- Medium (nightly / phase gates): module size budgets, public API snapshot, SBOM license policy (cross-link security).
- Slow: sandbox escape regression suite, live provider smoke.

---

## 4. Contract Tests — Provider SDK & Plugin SDK

### 4.1 Why contracts matter for Forge

Forge’s extension model means **third-party (or company) providers/plugins must not break the runtime**. Contracts protect:

- Provider SDK: stream/event shapes, tool-call proposals, resume/cancel, error taxonomy.
- Plugin SDK: skill registration, tool descriptors, capability declarations, lifecycle hooks.

### 4.2 Recommended approach (phased)

| Phase | Approach |
|---|---|
| Phase 0–2 | **Zod schema fixtures as contracts** — golden JSON + schema versions in `packages/contracts` |
| Phase 3+ | Add **Pact** if plugins become independently versioned/deployed services |
| Always | **Conformance suite** package: `@forge/provider-conformance`, `@forge/plugin-conformance` |

### 4.3 Provider conformance suite (actionable)

Every provider adapter **must** pass:

1. `initialize` / `health` / `shutdown` lifecycle  
2. `invoke` returns Zod-validated events only  
3. Tool-call proposals are **capabilities**, not grants (policy still required)  
4. Cancellation mid-stream  
5. Resume after human gate  
6. Error mapping to Forge error codes (no Claude-specific leakage)  
7. No secret echo in logs/events  

Ship a **mock provider** as the reference implementation of the contract.

### 4.4 Plugin conformance suite

1. Manifest Zod parse  
2. Declared tools ⊆ allowed capability classes  
3. Plugin cannot register tools outside declared scopes  
4. Sandbox FS/network defaults applied  
5. Version compatibility matrix (`engines.forge`)  
6. Untrusted plugin fixture: attempts privilege escalation → denied  

### 4.5 Contract versioning

- Schemas versioned (`ProviderEventV1`, …).  
- Breaking changes require ADR + dual-run period.  
- CI: consumer packages run against **published contract package**, not private internals.

**UNKNOWN:** Whether plugins are in-process modules, WASM, or separate processes — contract shape depends on this ADR. Spec should require process isolation decision before finalizing plugin contract tests.

---

## 5. Workflow Compiler Tests

Treat the compiler as a **deterministic product**, not a helper.

### 5.1 Test categories

| Category | Description | Artifact |
|---|---|---|
| Lex/parse | Manifest YAML/JSON → AST | Fixtures |
| Validate | Unknown nodes, missing approvals, bad refs | Error snapshots |
| Lowering | AST → IR (engine-agnostic) | IR golden files |
| Emit | IR → LangGraph (or other) **only inside adapter** | Adapter-level tests; core must not import emitter targets |
| Idempotence | Same manifest + versions → identical IR hash | Hash assert |
| Capability wiring | Skills/tools attached per policy, not prompt text | IR contains capability IDs from policy |
| Gate insertion | Human gates inserted for high-impact actions | Structural IR tests |
| Prompt binding | Versioned prompt asset IDs only | Reject inline magic strings |
| Snapshot stability | Golden IR under `testdata/` | Review on intentional change |

### 5.2 Property / fuzz (recommended later)

- Random valid manifests → compile succeeds; IR validates against Zod IR schema.  
- Mutation testing on validator (optional, Phase 3+).

### 5.3 Anti-goals for compiler tests

- Do **not** assert LangGraph node class names in core tests.  
- Do **not** require network/LLM.  
- Do **not** embed company-specific workflow IDs in core fixtures (those live in `examples/acme`, `forge.gusto`).

---

## 6. Sandbox & Testcontainers Strategies

### 6.1 Layers of sandbox testing

| Environment | Isolation | Used for |
|---|---|---|
| Unit fake sandbox | In-memory FS / stub exec | Adapter interface tests |
| Docker Testcontainers | Shared-kernel container | Local/CI integration of sandbox **port** |
| Hardened container / gVisor | Stronger syscall boundary | Staging / security regression |
| Firecracker microVM | Hardware isolation | Production untrusted code (**UNKNOWN:** Forge v1 scope) |

### 6.2 Testcontainers patterns for Forge

1. **Infra containers:** Redis, Postgres, OPA, mock SMTP, etc.  
2. **Sandbox-under-test:** Build `forge-sandbox` image in CI; start via `GenericContainer` with:
   - read-only rootfs where possible  
   - dropped caps  
   - no Docker socket mount  
   - network egress allowlist fixture  
   - tmpfs workdir  
3. **Worktree isolation tests:** create temp git repo + worktree; assert agent cannot write outside worktree root.  
4. **Disposable guarantee:** after run, container removed; no volume reuse across tenants in test (except explicit reuse flag for local speed).

### 6.3 Negative tests (security-relevant; own in 013 + 014)

- Attempt write outside workspace → denied.  
- Attempt reach metadata IP / host network → denied.  
- Attempt read env secrets not explicitly injected → denied.  
- Infinite fork / high CPU → cgroup kill / timeout.  

### 6.4 CI requirements

- Dedicated job with Docker.  
- Cache images.  
- Quarantine: sandbox escape tests may be nightly if slow — but **must** be required before any “sandbox GA” phase exit.

**UNKNOWN:** Whether macOS CI runners can run Firecracker (typically no — Linux/KVM). Spec should state Firecracker tests are Linux-only; Darwin uses Docker sandbox substitute.

---

## 7. Demo Scenario Acceptance Tests

Align with `016-demo-scenarios.md` / Acme + Gusto examples.

### 7.1 Definition

Acceptance tests are **black-box proofs** that a demo milestone works end-to-end:

- Start workflow from public API / CLI  
- Exercise provider adapter (mock by default)  
- Hit human approval UI or API  
- Resume  
- Observe OTel spans / structured logs  
- Assert final business outcome  

### 7.2 Recommended harness

- **Playwright** for UI approval path.  
- **Vitest + supertest/fetch** for API-only demos.  
- Fixture orgs: `examples/acme/**` manifests checked into repo; tests load them as data.  
- Tag `@acceptance` / `@demo`; run on main + nightly; subset on PR if fast enough.

### 7.3 Minimum Acme acceptance matrix (example)

| Scenario | Assert |
|---|---|
| Engineering PR review workflow | Compiles; mock provider proposes; human approve; merge action gated |
| Finance spend request | Policy denies over-limit without approval; approval allows once |
| Marketing content draft | Prompt version pinned; no secret in output |
| Provider switch | Same workflow IR runs on mock ↔ second mock provider |

### 7.4 Gusto customization acceptance

- Company package extends via plugin/manifest only (no core fork).  
- Architecture test: `forge.gusto` ↛ private core internals.  
- Demo: Benefits/BenOps flow proves extension model.

### 7.5 Flake control

- Deterministic clocks (`@sinonjs/fake-timers` or Vitest fake timers).  
- Seeded mock provider responses.  
- No live LLM in default acceptance CI.

---

## 8. Quality Gates Per Phase (from RAW)

Every phase ends with **Deliverables / Demo / Quality Gates / Exit Criteria**.

### 8.1 Universal four gates (RAW)

| Gate | Meaning for Forge | Typical enforcement |
|---|---|---|
| **Unit tests** | New code covered; contracts green | `turbo test --filter=...`; coverage thresholds on touched packages |
| **Architecture tests** | No boundary violations | `depcruise` + eslint boundaries + arch Vitest |
| **Performance thresholds** | Compiler/runtime budgets | Bench job; fail if p95 compile > N ms for fixture set |
| **Security scan** | Secrets/vulns/licenses | Gitleaks + Trivy (+ Semgrep); see 014 |

### 8.2 Suggested phase progression

| Phase | Unit | Arch | Perf | Security | Extra |
|---|---|---|---|---|---|
| **0 Research** | n/a code | n/a | n/a | Doc threat model draft | Research + ADRs complete |
| **1 Skeleton** | Packages smoke | Forbidden import rules on | Baseline compile budget recorded | Secret scan + license allowlist | `tsc` clean |
| **2 Providers + sandboxes + compiler** | Conformance suites required | Adapter isolation strict | Compiler golden perf | Container image scan | Integration Testcontainers job |
| **3 Human gates + policies** | Policy unit + gate FSM | Policy cannot be imported from prompts package incorrectly | Gate latency budget | Red-team prompt-injection suite (automated) | Acceptance: approval cannot skip |
| **4 Demo orgs** | — | examples depend on public SDK only | Demo E2E time budget | ZAP baseline on UI | Playwright demos green |
| **5 Production readiness** | Mutation/fuzz optional | Full fitness catalog | Load test queue/runtime | Full SBOM + signed artifacts | Chaos: kill sandbox mid-run |

### 8.3 Exit criteria template (paste into 015-phases)

```
Quality Gates
-------------
[ ] Unit: all required suites pass; coverage floors met for changed packages
[ ] Architecture: depcruise + eslint boundaries + arch tests pass
[ ] Performance: budgets in budgets.json not exceeded
[ ] Security: secret scan clean; CRITICAL/HIGH vulns = 0 (or waived ADR)
[ ] Contracts: provider + plugin conformance green
[ ] Acceptance: phase demo scenarios automated and passing
```

---

## 9. Observability & Test Telemetry

- Tests should assert **Forge** span names/attributes, not LangSmith internals.  
- LangSmith access only via adapter — architecture test forbids direct SDK in core.  
- Prefer OpenTelemetry in-memory exporter in unit/int tests; optional LangSmith sink in opt-in live tests.

---

## 10. CI Topology (actionable sketch)

```
PR:
  lint + typecheck
  unit (turbo, no docker)
  architecture (depcruise + eslint)
  contract/conformance
  security: gitleaks + trivy fs (fast)

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

## 11. Spec Outline Recommendation for `013-testing.md`

1. Goals & non-goals  
2. Test taxonomy & naming  
3. Tooling & monorepo layout  
4. Unit standards  
5. Integration & Testcontainers  
6. Architecture fitness functions (rules catalog)  
7. Provider/plugin contract & conformance  
8. Workflow compiler test strategy  
9. Sandbox test strategy  
10. Demo acceptance tests  
11. Performance budgets  
12. Phase quality gates & exit criteria  
13. CI topology  
14. Flake / quarantine policy  
15. Open questions / ADRs required  

---

## 12. Open Questions (mark in spec)

| ID | Question | Impact |
|---|---|---|
| T-1 | Turborepo vs Nx? | CI caching layout |
| T-2 | In-process vs isolated plugins? | Contract + sandbox tests |
| T-3 | Firecracker in v1 or Docker-only? | Security + CI matrix |
| T-4 | Pact Broker vs Zod contracts only? | Plugin ecosystem maturity |
| T-5 | Coverage floors per package? | Gate strictness |
| T-6 | Live provider tests in CI? | Secrets, cost, flake |
| T-7 | OpenFeature vs OPA ownership of which decisions? | What to assert where |

---

## 13. Recommendations (principal summary)

1. **Standardize on Vitest + Playwright + dependency-cruiser + Testcontainers** from Phase 1.  
2. **Treat architecture tests as equal to unit tests** — they encode “Adapters at every boundary.”  
3. **Ship conformance packages** for provider/plugin SDKs before external authors exist.  
4. **Compiler golden IR** is the core regression shield for “Compile, don’t configure.”  
5. **Phase gates always include the RAW four**; add contracts + acceptance as Forge-specific fifth/sixth gates from Phase 2–4.  
6. **Default CI = mock provider**; live LLM is opt-in.  
7. Defer Pact Broker until plugins are independently deployed; do not defer **schema contracts**.
