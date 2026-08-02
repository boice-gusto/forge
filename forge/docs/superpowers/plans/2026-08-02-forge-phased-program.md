# Forge Phased Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Forge incrementally from the documented Phase 0 baseline to a production-evaluable typed AI workflow platform, with a runnable demo and objective gates at every phase.

**Architecture:** Forge’s parent workspace (`/Volumes/BlackBox/GitHub/forge`) owns package management. Product code lives under `forge/packages`, `forge/apps`, and `forge/examples`; `forge.gusto` is a sibling extension. Typed manifests compile through private IR into a runtime with policy, approvals, providers, queues, sandboxing, and observability behind ports. UI and extensions consume public SDK DTOs only.

**Tech Stack:** pnpm 9, Node 20+, TypeScript, Zod v4, Turborepo, Biome, Vitest, dependency-cruiser, Testcontainers, LangGraph (private), BullMQ/Redis (private), Postgres, OPA Wasm, OpenTelemetry, Pino/SimPill utilities, Commander, Chalk, React, Tailwind, Shadcn/ui, Vercel AI Elements, React Flow.

## Global Constraints

- Public packages must never expose or transitively depend on LangGraph, BullMQ, provider/ACP/ACPX SDKs, Docker clients, or company packages.
- Use `safeParse` at HTTP, CLI, environment, manifest, queue, plugin, and adapter boundaries.
- Core never imports `forge.gusto` or `examples/acme`; extensions import only public `@forge/*` contracts.
- Policies decide capabilities and side effects; prompts, provider permissions, UI controls, and OpenFeature flags cannot authorize work.
- `provider=mock` is the default for demos and CI. Claude CLI/ACP, Codex CLI/ACP, and direct API are private adapters selected at composition root.
- `sandbox=off` is explicit trusted-local execution only. Sandbox-required work fails closed if Docker/microVM isolation cannot be created.
- CLI: Commander parsing, Chalk human output, Pino/SimPill structured/redacted logs, one-result `--json` stdout contract.
- UI: Tailwind + Shadcn/ui + in-repo Vercel AI Elements. The React Flow graph is read-only; disable node drag/connect/delete and provide a semantic timeline alternative.
- Every phase must pass unit, architecture, performance, and security gates; add contract and acceptance gates when the relevant surface exists.
- Preserve Phase 0 handbook and ADR precedence. A changed decision requires an ADR rather than a silent implementation deviation.
- Clients only trigger workflows. CLI/API/Jira/Slack/Buzz normalize to `WorkflowRequest` and never implement business workflow logic.
- V1 providers are `mock`, `claude-cli`, and `codex-cli` over private SimPill ACP adapters. Direct APIs and ACPX meshes are deferred private extensions.
- Every control-plane surface distinguishes requested, granted, and observed resource/capability state.

---

## Program dependency map

```text
P1 workspace + contracts + local dev
 └─> P2 compiler + runtime adapters + provider/sandbox/checkpoint
      └─> P3 policy + durable approvals + A1/A2 API proof
           ├─> P4 Acme + operator UI + A1-A5
           │    └─> P5 Gusto Benefits/BenOps + G1-G2
           │         └─> P6 observability/UI hardening + G3-G5 parity
           └─> P7 release, load, chaos, staging production evaluation
```

## Phase −1 — Vision validation (no runtime code)

**Exit demo:** a contributor can trace every planned package and dependency to a six-month product assertion, explain the Forge/Buzz boundary, and execute the flagship story as a test contract on paper.

- [ ] Accept handbook `017-vision-validation.md` and ADR-008 topology decision.
- [ ] Create a single traceability matrix from six-month assertions to package, phase, acceptance scenario, and exit gate.
- [ ] Promote `engineering-feature` as the flagship V1 scenario: intake → discovery brief → exact approval → sandbox/worktree → Claude/Codex CLI → tests → judges → PR-ready artifacts.
- [ ] Define all V1 negative paths: incomplete intake becomes read-only remediation; injection/secrets attempt denies; rejected/expired approval produces zero protected effect; worker restart resumes; repeated test failure terminates within bounded attempts.
- [ ] Confirm `forge.acme`, `forge.gusto`, and later `forge.buzz` are sibling extensions and that no core code may import them.

## What is deliberately not in this program

- Drag-and-drop workflow authoring: it conflicts with the typed compile model.
- A2A, an MCP server, provider mesh/ACPX orchestration, and a workflow marketplace: research after stable Forge workflow and plugin contracts.
- MicroVM implementation: a future `SandboxPort` adapter after a dedicated ADR and conformance suite.
- Real production Gusto credentials: only fixtures/mocks and stubbed private integration contracts before approved production integration work.
- Live-provider CI acceptance: provider credentials and nondeterministic prose do not belong in the default quality gate.

## Phase gates used by every phase

```text
[ ] Deliverables exist and are documented
[ ] Human demo works from a clean local checkout
[ ] Unit tests and required coverage pass
[ ] Architecture fitness tests pass
[ ] Performance baseline/budget passes
[ ] Gitleaks, Trivy/Semgrep, and license policy pass as applicable
[ ] Contract and acceptance tests pass as applicable
[ ] ADR/handbook changes are accepted; next phase entry is explicit
```

---

## Phase 1 — Monorepo skeleton, local developer loop, and contract foundations

**Exit demo:** `pnpm install && pnpm build && pnpm test` passes; `forge dev up` starts named local services; a CLI/API `WorkflowRequest` safely validates and returns a durable run reference; a deliberately forbidden import fails architecture CI.

### Target file structure

| Path | Responsibility |
|---|---|
| `package.json`, `pnpm-workspace.yaml`, `turbo.json` | workspace scripts, package topology, task graph |
| `forge/packages/types/src/*` | branded IDs, common `Result`, run/event/diagnostic DTOs |
| `forge/packages/intake/src/*` | canonical `WorkflowRequest`, readiness and discovery-remediation DTOs |
| `forge/packages/manifest/src/*` | Zod schemas and safe manifest loader contracts |
| `forge/packages/sdk/src/*` | public client/DTO exports only |
| `forge/packages/ports/src/*` | internal port interfaces with no vendor imports |
| `forge/packages/cli/src/*` | Commander root, `dev`, `providers`, `validate`, `prompts`, and run placeholders |
| `forge/packages/config/src/*` | environment/config-reference parsing and precedence |
| `forge/packages/observability/src/*` | Pino/SimPill logger facade, redaction, correlation context |
| `forge/apps/api/src/*`, `forge/apps/worker/src/*` | composition roots and health endpoints only |
| `forge/apps/ui/src/*` | React/Tailwind/Shadcn health/status shell |
| `forge/tooling/*` | Biome, Vitest, dependency-cruiser, TS shared configuration |
| `forge/infra/local/*` | named local compose/dev configuration for Postgres, Redis, OTel |
| `forge/.env.example` | safe documented configuration variables |
| `.github/workflows/ci.yml` | lint/typecheck/test/fitness/security pipeline |

### Task 1: Establish reproducible workspace tooling

**Files:**
- Modify: `package.json`, `pnpm-workspace.yaml`
- Create: `turbo.json`, `forge/tooling/{tsconfig.base.json,vitest.workspace.ts,dependency-cruiser.cjs,biome.json}`
- Test: `forge/tooling/architecture.test.ts`

**Produces:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:architecture`; workspace aliases are `@forge/*`.

- [ ] Define package globs for `forge/packages/*`, `forge/apps/*`, `forge/examples/*`, and `forge.gusto`; retain the parent as the single lockfile root.
- [ ] Add Turbo tasks where `build` depends on dependency builds, `test` has no output cache dependency, and `lint/typecheck` consume source/config inputs.
- [ ] Configure TypeScript strict mode, Node 20 baseline, ESM, path aliases, and Vitest workspace projects.
- [ ] Configure dependency-cruiser rules: public/UI packages cannot import adapter/vendor paths; `forge` cannot import company/example packages; extensions cannot import `@forge/*/internal`.
- [ ] Write a fixture test that introduces each forbidden import string and asserts the fitness command returns a diagnostic naming the rule.
- [ ] Run `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:architecture`; record tool versions and first-run timings in `docs/013-testing.md` or a Phase 1 baseline artifact.

### Task 2: Publish the minimal typed contract layer

**Files:**
- Create: `forge/packages/types/src/{ids.ts,result.ts,diagnostics.ts,run.ts,event.ts,index.ts}`
- Create: `forge/packages/manifest/src/{schemas.ts,loader.ts,index.ts}`
- Create: `forge/packages/sdk/src/index.ts`
- Test: `forge/packages/{types,manifest}/src/**/*.test.ts`

**Consumes:** workspace tooling.

**Produces:** `CompanyId`, `WorkflowId`, `RunId`, `ApprovalId`, `Diagnostic`, `ForgeEvent`, `RunSummary`, `safeLoadCompanyManifest`; public exports are vendor-free.

- [ ] Write failing schema tests for valid/minimal manifests, empty IDs, duplicate workflow IDs, unknown fields, and malformed JSON/YAML source.
- [ ] Define branded string IDs and discriminated DTOs for run lifecycle/event categories without engine checkpoint blobs, provider raw messages, or Rego source.
- [ ] Implement `safeLoadCompanyManifest(input): Result<CompanyManifest, Diagnostic[]>` using Zod v4 `safeParse`; return source path and remediation suggestion for errors.
- [ ] Add export-surface test that imports `@forge/sdk` and checks it does not expose internal/vendor module names.
- [ ] Run package tests and architecture tests.

### Task 2a: Add canonical intake and health/build contracts

**Files:**
- Create: `forge/packages/intake/src/{workflow-request.ts,readiness.ts,index.ts}`
- Modify: `forge/packages/types/src/{run.ts,event.ts,index.ts}`, `forge/packages/sdk/src/index.ts`
- Test: `forge/packages/intake/src/**/*.test.ts`

**Produces:** `WorkflowRequest`, `EngineeringBrief`, `IntakeDecision`, `BuildMetadata`, and health DTOs without client-specific schema leakage.

- [ ] Write failing tests for CLI/API-equivalent valid requests, duplicate external idempotency keys, anonymous principals, insufficient implementation requests, and an allowed discovery-only request.
- [ ] Implement safe parsing that returns an actionable `IntakeDecision`; never silently upgrades incomplete intake into write-capable implementation.
- [ ] Define health response DTOs with liveness/readiness/detail semantics and required version/git SHA/request-ID headers.
- [ ] Add public contract tests proving Jira/Slack/Buzz-specific fields cannot enter `WorkflowRequest` directly.

### Task 3: Define private ports and composition-root rules

**Files:**
- Create: `forge/packages/ports/src/{provider.ts,sandbox.ts,queue.ts,graph-engine.ts,policy.ts,approval.ts,checkpoint.ts,observability.ts,index.ts}`
- Create: `forge/packages/ports/README.md`
- Test: `forge/packages/ports/src/ports.contract.test.ts`

**Produces:** vendor-neutral internal interfaces and documented ownership boundaries.

- [ ] Define typed request/result shapes for each port with cancellation, correlation, idempotency, and typed-error fields where relevant.
- [ ] Explicitly state `ProviderPort` supports mock/ACP/direct API adapters without exposing CLI or ACP types.
- [ ] Define the `SandboxPort` failure contract: requested isolation cannot silently execute in host mode.
- [ ] Define `ApprovalPort` proposal and resolution contracts bound to run ID, policy decision, exact effect hash, expiry, actor, and idempotency key.
- [ ] Test that all port modules import only types and standard-library/allowed dependencies.

### Task 4: Implement config, logging, and redaction foundations

**Files:**
- Create: `forge/packages/config/src/{schema.ts,resolve.ts,index.ts}`
- Create: `forge/packages/observability/src/{logger.ts,redaction.ts,context.ts,index.ts}`
- Create: `forge/.env.example`
- Test: `forge/packages/{config,observability}/src/**/*.test.ts`

**Produces:** precedence resolver and a logger factory with `runId`, `traceId`, company/workflow IDs, and secret redaction.

- [ ] Write tests for CLI > process env > `.env.local` > checked-in config > defaults precedence, invalid environment values, and secret-reference presence reporting.
- [ ] Implement redaction for known secret key patterns and recursively redact sensitive fields before logs/events leave the process.
- [ ] Implement `createForgeLogger(context)` backed by Pino/SimPill utilities; emit JSON by default and prohibit raw prompt/provider payload logging.
- [ ] Add tests for nested objects, arrays, URLs with secret query values, and error cause objects.
- [ ] Validate `.env.example` contains no real credential and documents mock-first defaults.

### Task 5: Build the Phase 1 CLI contract

**Files:**
- Create: `forge/packages/cli/src/{main.ts,program.ts,output.ts,commands/dev.ts,commands/providers.ts,commands/validate.ts,commands/prompts.ts,commands/run.ts}`
- Test: `forge/packages/cli/src/**/*.test.ts`

**Produces:** Commander CLI with `dev up/down`, `providers doctor`, `validate`, `prompts check`, and typed unavailable placeholders for runtime-only commands.

- [ ] Write command tests asserting usage, `--json` single-result stdout, human output on stderr, and exit codes `0–4` defined by the SPEC.
- [ ] Implement `forge providers doctor` with mock readiness in Phase 1 and non-failing “not installed/not configured” diagnostics for Claude CLI, Codex CLI, and direct API.
- [ ] Implement `forge validate` and `forge prompts check` against manifest/prompt stubs, returning exit code `2` for invalid artifacts.
- [ ] Implement `forge dev up/down` as wrappers around named local composition resources; reject ambiguous or broad teardown targets.
- [ ] Use Chalk only at the presentation boundary; snapshot test ANSI-free JSON and normalized human summaries.

### Task 6: Add local composition roots and UI status shell

**Files:**
- Create: `forge/apps/api/src/{main.ts,health.ts}`, `forge/apps/worker/src/{main.ts,health.ts}`
- Create: `forge/apps/ui/src/{main.tsx,app.tsx,components/local-status.tsx,styles.css}`
- Create: `forge/infra/local/compose.yaml`
- Test: `forge/apps/{api,worker,ui}/src/**/*.test.tsx`

**Produces:** local health endpoints, worker/API startup validation, Tailwind/Shadcn initialized UI shell, local status page.

- [ ] Define `/health/live`, `/health/ready`, and authenticated `/health`; liveness reports process state only, readiness fails when dependencies prevent safe work, detailed health reports version/git SHA/build time/dependency states.
- [ ] Add `X-Forge-Version`, `X-Forge-Git-SHA`, `X-Forge-Service`, and `X-Request-ID` headers at API middleware boundary.
- [ ] Start only Redis, Postgres, and OTel collector as named infrastructure resources; API/worker/UI run as managed dev processes with explicit health checks.
- [ ] Render each dependency state and provider doctor result in the UI, including unavailable/error/refresh states and no secret values.
- [ ] Add component tests for loading, ready, unavailable, and redacted diagnostic state; add one Playwright smoke test for the health page.

### Task 7: Add CI, security, and baseline enforcement

**Files:**
- Create: `.github/workflows/ci.yml`, `forge/budgets.json`, `forge/scripts/measure-phase1.mjs`
- Modify: root scripts and developer README files
- Test: CI-equivalent local commands and measurement output fixture

**Produces:** required checks and a versioned Phase 1 baseline for cold/warm startup, CLI startup, empty compile stub, API health, and UI first render.

- [ ] Add ordered CI jobs: install with frozen lockfile, lint, typecheck, unit, architecture, secret scan, license policy; Docker/Testcontainers remains Phase 2.
- [ ] Make baseline script write stable JSON with machine/runtime metadata and percentile samples; do not invent fixed SLOs before data exists.
- [ ] Add a regression test that rejects a missing baseline field or a threshold increase without an ADR/reference note.
- [ ] Run clean-checkout instructions and record exact verification output in Phase 1 handoff docs.

### Phase 1 verification checklist

- [ ] `pnpm install && pnpm build && pnpm test && pnpm test:architecture` succeeds.
- [ ] `forge dev up`, UI/API/worker health checks, and `forge dev down` work without touching unrelated containers/processes.
- [ ] `forge providers doctor --json` reports mock ready and optional provider remediation without secrets.
- [ ] Deliberate public-vendor and core-company imports fail CI.
- [ ] Logger/redaction, CLI JSON/exit code, config precedence, and health UI paths have passing tests.

---

## Phase 2 — Compiler, providers, sandbox, queue, checkpoint, and local trace proof

**Depends on:** Phase 1 exit.

**Exit demo:** a typed Acme fixture compiles manifest → IR → opaque plan, executes on mock and both ACP CLI modes by composition-root switch, creates a checkpoint, and resumes; Docker work runs in a disposable worktree/container with OTEL trace.

**Implementation workstreams:**

1. `compiler` and `ir`: define `defineWorkflow`, deterministic validation/diagnostics, content fingerprints, golden IR fixtures, capability closure, prompt pins, `IntakeNode`, and structured `JudgeNode`.
2. `adapters-langgraph` and `runtime`: lower sealed IR to a private engine plan, persist/checkpoint lifecycle, run state machine, typed events.
3. `provider-mock` and `provider-acp`: conformance suite first; then `@simpill/acp-llm-cli` private mapping for exactly Claude/Codex selection and session resume. Defer direct API/ACPX mesh.
4. `sandbox-mock`, `sandbox-worktree`, `sandbox-docker`: versioned Zod sandbox profiles, intersected platform/company/team/workflow/skill grants, hardened Docker, no host socket/network/env inheritance, disposable leases, Testcontainers contract suite.
5. `queue-memory`, `queue-bullmq`, and `checkpoint-postgres`: in-memory deterministic V1 path first; workload-class queues and BullMQ flows only for deterministic fan-out; idempotent job dispatch; workers checkpoint and acknowledge before approval waits; context propagates API → queue → worker → sandbox.

**Phase 2 test matrix:** compiler golden/idempotence/invalid graph; provider event/cancel/malformed-response/conformance and Claude/Codex session resume; profile narrowing/secret/env/path/symlink/network deny; provider parity of compile/schema/control/policy rather than prose; Docker-required fail-closed and cleanup; duplicate job/worker restart; OTEL parent context; p95 compile and sandbox provisioning baselines.

---

## Phase 3 — OPA policy, durable approvals, and API acceptance

**Depends on:** Phase 2 stable ports and checkpoint lifecycle.

**Exit demo:** A1 marketing and A2 finance run through API. A policy error denies; an ungranted capability denies; approval/reject/expiry/replay behavior is durable and produces the correct side-effect count.

**Implementation workstreams:**

1. Security SDK + OPA Wasm policy adapter: deterministic injection/secret scanners, optional detector port research, capability/tool/output validation, `{ principal, action, resource, context } → { allow, obligations[] }`, default deny, decision ID, cache/budget measurement, OpenFeature cannot widen grant.
2. Approval service/state machine: pending/approved/rejected/expired/cancelled, exact-effect hash binding, actor/auth contract, idempotent resolution, resume enqueue.
3. API/event contract: authenticated run/approval endpoints, append-only event cursor, artifact metadata/redacted references, SSE snapshot/reconnect contract.
4. Flagship fixtures: `engineering-feature` plus A1/A2, follow-up message resume, bounded classify/repair/revalidate loop, prompt-injection/capability-bypass/secret-denial, approval parameter-substitution, duplicate-click, worker-restart, and expired-gate tests.

**Phase 3 verification:** exhaustive state transition tests, OPA malformed/broken policy fail-closed, approval audit trace, exactly-zero side effect after deny/reject/expiry, A1/A2 API acceptance, policy and gate latency budgets.

---

## Phase 4 — Acme package and operator UI

**Depends on:** Phase 3 stable SDK DTOs.

**Exit demo:** a marketing lead runs A1 from the demo console, reviews an evidence-first approval, approves or rejects, and observes the live timeline and read-only graph. A1–A5 pass on API and Playwright using mock provider.

**Implementation workstreams:**

1. `forge.acme` extension: company/domain manifests, prompts, policy fixtures, adapters, Marketing/Finance/Design/Engineering workflows, `engineering-feature` fixtures, reusable scenario helpers.
2. UI foundation: Tailwind tokens, Shadcn components, in-repo AI Elements (`message`, `sources`, `tool`, `snippet` only where their behavior matches Forge DTOs), dark/light state, CSP-safe rendering.
3. Operator surfaces: approval inbox/detail, run inspector, timeline, prompt/artifact viewer, demo console, local health, and requested/granted/observed control-plane views for workflows, agents, sandboxes, workers, queues, providers, policies, artifacts, and audit.
4. Read-only graph: React Flow/AI Elements Canvas only as a renderer; `nodesDraggable=false`, `nodesConnectable=false`, `nodesDeletable=false`, mutation handlers absent, keyboard/list fallback, memoized layout/collapsed completed subtrees.
5. Live delivery: cursor-resumable SSE, event-ID de-duplication, snapshot recovery, disconnected/delayed state, backoff, bounded event DTOs.

**Phase 4 verification:** component/a11y tests, Playwright A1–A5, graph invariant tests, SSE reconnect and out-of-order event tests, CSRF/CSP/ZAP checks, demo E2E budget.

---

## Phase 5 — Gusto extension proof: Benefits and BenOps

**Depends on:** Phase 4 company-loader and UI contracts.

**Exit demo:** G1 regulated-topic escalation and G2 dry-run/partial approval complete in the same runtime with no Gusto import in core.

**Implementation workstreams:** Gusto manifest/package loader, Benefits domain prompts/policy/fixtures, BenOps dry-run/selection-bound approval/adapters, theme tokens, architecture/tenant isolation tests, G1/G2 acceptance.

**Verification:** partial approval cannot execute excluded actions; PII fields redact in browser/logs/trace; extension conformance passes; Acme regression demos remain green.

---

## Phase 6 — Observability hardening and cross-company parity

**Depends on:** Phase 5.

**Exit demo:** G3/G4/G5 pass. CLI runs Acme then Gusto in one process with provider/sandbox configuration visible; R&D denies production adapter but succeeds on mocks; optional LangSmith enables only through a flag/adapter.

**Implementation workstreams:** complete Forge event taxonomy and dashboards, redaction/retention policy, optional LangSmith adapter, USP/R&D workflows and policy packs, provider/sandbox parity dashboard, scenario/replay UX hardening.

**Verification:** trace cardinality and event-size budgets; LangSmith sensitive-field deny; G4 prod deny; G5 same-runtime acceptance; sandbox/resource leak suite.

---

## Phase 7 — Production evaluation and release operations

**Depends on:** Phase 6.

**Exit demo:** staged API/worker release, pending approval survives worker restart, sandbox kill is audited and recoverable, release artifact has SBOM/signature/scan evidence, all scenario suites pass in staging.

**Implementation workstreams:** package/container distribution decision and CI publish pipeline, SBOM/Syft, signing/Cosign if ADR accepted, vulnerability policy, load test and queue-worker sizing, chaos drills, production OTel deployment, SSO/step-up auth ADR/implementation, incident/runbook/alert ownership.

**Verification:** staging smoke A1–A5/G1–G5, p95 queue/run/approval SLOs from budgets, security scan/vulnerability SLA, load/chaos reports, rollback procedure rehearsed.

## Phase 8 — Jira, Slack, and Buzz connector extensions

**Depends on:** Flagship CLI/API scenario and `WorkflowRequest` contract are production-evaluable.

**Exit demo:** a signed Buzz room event, a Jira webhook, and a Slack mention each normalize through a thin extension adapter to the same canonical request; the unchanged workflow runs and returns redacted progress/artifact references to the source.

**Implementation workstreams:** `forge.buzz` signature verification/deduplication/identity mapping/room mapping/publication; Jira/Slack intake adapters; connector queue with retry/backpressure; connector E2E; strict core-does-not-import-extension fitness tests. Buzz's optional ACP harness is an integration research spike only, not a Forge durability dependency.

---

## Cross-phase failure-mode contract

| Failure | Required behavior | Test layer |
|---|---|---|
| malformed manifest/provider/queue payload | reject at boundary with typed diagnostic; no side effect | unit + contract |
| policy engine error | deny, emit redacted decision failure, do not invoke adapter | unit + integration |
| provider malformed/empty/refusal/timeout | typed event; bounded retry only where safe; terminal actionable failure | provider contract + integration |
| duplicate API/job/approval request | return same run/decision or conflict; exactly-once effect via idempotency | integration + acceptance |
| approval expiry/restart | terminal expired/audited or resume from durable state; no stale effect | integration + chaos |
| Docker unavailable when required | fail closed; no host fallback | sandbox contract |
| SSE disconnect/replay | client resumes by cursor, de-duplicates, displays stale state | UI integration + Playwright |
| live provider output differs | schema/control policy tests still pass; no byte-for-byte prose comparison | conformance/eval |

## Parallelization plan

| Lane | Modules | Dependency |
|---|---|---|
| A | workspace tooling, CI, architecture rules | none |
| B | types, manifest, SDK DTOs | A aliases/config |
| C | config, observability logger/redaction | B context IDs |
| D | CLI | B + C |
| E | API/worker/UI health shells, local infra | B + C |

Launch A, then B. Launch C after B; once C is merged, launch D and E in parallel worktrees. Phase 2 begins only after all Phase 1 lanes merge and its exit checklist is green. Do not parallelize compiler and runtime lowering until IR types/fingerprinting are accepted.

## Plan self-review

- **Spec coverage:** all reviewed requirements map to a phase: provider modes (P2), CLI/config/logger/local dev (P1), sandbox (P2), policy/HITL (P3), Shadcn/Tailwind/AI Elements/read-only graph (P4), scenarios (P3–P6), observability/performance (P1 onward), production distribution (P7).
- **Scope:** this is a program plan, not a single PR. Phase 1 is the only immediately executable unit; each later phase has a concrete exit demo and must receive its own task-level implementation plan after the preceding gate passes.
- **Placeholder scan:** no TODO/TBD placeholders; later phases intentionally specify implementation workstreams and verification because exact source files can only be responsibly fixed after their prerequisite packages/contracts exist.
- **Consistency:** vendor isolation, typed compile model, mock-first tests, policy precedence, and extension dependency direction are repeated deliberately as enforceable constraints.

## Execution handoff

Begin with **Phase 1 only**. Its success is the ability to build, test, validate boundaries, start the local loop, and expose stable contracts for Phase 2. Do not implement a later-phase adapter, UI surface, or company workflow before its predecessor exit gate passes.
