# Forge Program Specification

**Status:** Proposed — design approved; pending written-spec review

**Date:** 2026-08-02

**Scope:** The complete, phased path from the Phase 0 handbook to a production-ready, typed AI workflow platform. Each phase is independently runnable, demonstrable, and gated. This document is subordinate to `docs/MASTER_SPEC.md`, numbered handbook documents, and Accepted ADRs; an explicit user requirement in this specification supersedes an `ADOPT-LATER` recommendation in Phase 0 research.

## 1. Product outcome

Forge is a typed AI workflow platform. Organizations compose versioned manifests, workflows, prompts, skills, policies, and adapters into a compiled internal plan. The runtime performs intelligent work inside deterministic controls: policy, capability checks, sandboxing, durable approvals, queues, checkpoints, audit, and observability. Humans make final side-effect decisions.

The end-state proof is one core runtime running Acme and Gusto workflows by changing company packages, never by forking or importing company logic into core.

## 2. Non-negotiable constraints

1. **Compile, do not configure.** Workflows are typed manifests/code assets compiled to Forge IR and opaque `EnginePlan`; UI visualization is read-only.
2. **Extension, not replacement.** `examples/acme` and `forge.gusto` depend only on public `@forge/*` contracts. Core never imports them.
3. **Policies before permissions.** Prompt text, provider permissions, feature flags, and UI actions cannot grant capabilities or bypass a policy/approval decision.
4. **Vendor isolation.** LangGraph, BullMQ, ACP/ACPX, provider SDKs/CLIs, Docker clients, and LangSmith are private adapter details.
5. **Validated boundaries.** Zod v4 `safeParse` validates all external/config/queue/plugin/API input. Failures are typed diagnostics, never uncaught parsing exceptions.
6. **No secrets in artifacts.** Manifests, prompts, source, logs, telemetry, and browser DTOs carry configuration references only. Composition roots resolve secrets.
7. **Local-first and mock-first.** A clean checkout can run deterministic Acme demos with no provider API key. CI acceptance uses mocks only.
8. **Sandbox truthfulness.** A worktree isolates source trees, not trust. `sandbox=off` is a visibly trusted local mode; sandboxed tasks default to hardened Docker.
9. **Observable by default.** Structured Pino/SimPill logs, OpenTelemetry traces, metrics, and audit events share correlation identifiers and redact sensitive data.
10. **KISS.** One public contract per concern, dependency injection only in apps/tests, no abstractions without more than one real implementation or an ADR-locked port.
11. **Clients trigger workflows.** CLI, API, Jira, Slack, and Buzz normalize to one canonical `WorkflowRequest`; no client implements workflow logic.
12. **Requested, granted, observed.** Security, sandbox, provider, and resource UI surfaces distinguish requested capability from Forge grant and actual measured activity.
13. **Inheritance narrows, composition is explicit.** Prompt/workflow/skill inheritance may reuse versioned bases but cannot weaken schema, policy, capability, approval, or sandbox constraints. Teams and service catalog entries are typed configuration, not magic strings.
14. **Bounded execution.** Every provider, sandbox, queue, retrieval, judge, and connector operation has a timeout, explicit retry classification, rate limit/backpressure behavior, and circuit-breaker/degraded state where an external dependency can fail.

## 3. Layered architecture

```text
Company extensions (owned by Acme/Gusto)
  manifests | workflow definitions | skills | policies | prompts | fixtures | theme tokens
                                     |
                                     v  load + validate + capability closure
Public Forge contracts
  @forge/types | manifest | plugin-sdk | sdk | cli DTOs
                                     |
                                     v  compile
Private platform
  compiler -> IR -> opaque EnginePlan | runtime | approvals | policy | queues | telemetry
                                     |
                                     v  private adapters behind ports
Execution infrastructure
  mock | Claude CLI/ACP | Codex CLI/ACP | optional direct API
  Docker/worktrees | LangGraph/Postgres | BullMQ/Redis | OpenTelemetry
```

### 3.1 Package boundaries

| Layer | Required packages/surfaces | May depend on | Must not depend on |
|---|---|---|---|
| Public | `types`, `manifest`, `sdk`, `plugin-sdk`, `cli` DTOs | Zod, shared Forge types | engine, queue, provider, sandbox, company packages |
| Internal | compiler, IR, runtime, ports, policy, approvals | public contracts and ports | company packages except through registrations |
| Adapters | langgraph, queue, provider, sandbox, OTel/LangSmith | their port and vendor SDK | public exports |
| Deployables | API, worker, UI, CLI | public + internal composition | direct company internals except selected package entrypoint |
| Extensions | Acme and Gusto | public contracts only | core internals and each other |

## 4. Users and jobs to be done

| User | Job | Success condition |
|---|---|---|
| Platform engineer | Add a platform capability without coupling a company package or vendor into public API | Architecture fitness tests prove dependency direction and vendor isolation |
| Workflow author | Define/reuse a typed workflow from bounded primitives | Invalid artifacts fail at load/compile time with actionable diagnostics |
| Local developer | Run, inspect, and debug deterministic or CLI-backed workflows locally | One command starts dependencies; provider/sandbox mode is explicit and diagnosable |
| Operator/approver | Review an AI recommendation and decide a proposed side effect | Inbox shows exact effect, policy evidence, run timeline, prompt version; rejection causes zero effect |
| Security owner | Prove an untrusted model/plugin cannot escalate capabilities | Policy fails closed; approval binding and capability closure suites pass |
| Company extender | Add domain workflows/policies/prompts without fork | Gusto and Acme run through the same runtime and public extension contract |

## 4.1 Phase −1 and flagship vertical slice

Phase −1 is a no-code vision validation gate defined by handbook 017. Its output is a traceability table and accepted amendments, not runtime code. The first practical end-to-end slice is `engineering-feature`: a CLI/API request becomes a durable workflow, produces a read-only engineering brief, requires explicit approval before writes, executes in a declared sandbox/worktree with one of the two private SimPill ACP CLI providers, validates deterministically, runs structured judges, and emits a PR-ready patch/review artifact. It must demonstrate one follow-up resume, one security denial, one human approval, and one worker restart.

`direct-api` remains an opt-in future provider profile; V1 implements exactly `mock`, `claude-cli`, and `codex-cli`.

## 5. Workflow primitive model and scenario composition

### 5.1 Primitives

Every workflow is composed from a small, typed set:

| Primitive | Purpose | Required control |
|---|---|---|
| `skill` | Deterministic/tool-assisted or provider-assisted computation | declared input/output schemas and capability requests |
| `policy.check` | Authorize a requested action | OPA `allow/deny/obligations`; errors deny |
| `human.approve` | Bind a human decision to exact proposed effect | durable approval record, idempotent decision, expiry |
| `adapter.call` | External side effect or read | capability and policy decision before dispatch |
| `sandbox.task` | Execute isolated task | declared sandbox profile and policy-derived limits |
| `branch` / `parallel` | Deterministic control flow | compiler validates joins and reachable nodes |
| `checkpoint` / `resume` | Durable interruption/recovery | immutable run/checkpoint IDs, no queue lock across wait |
| `intake` | Normalize/validate external or local request | canonical schema, authenticated principal, idempotency key |
| `judge` | Produce structured quality verdict | deterministic/LLM/ensemble; no side-effect tools; error escalates to review |

### 5.2 Composition rule

New scenarios must reuse declared primitives and name their coverage. They may not create a parallel ad-hoc graph/permission mechanism. A scenario’s acceptance test asserts both its business outcome and its control-plane invariants.

| Scenario | Composition proof |
|---|---|
| A1 Campaign publish | compile + draft + policy obligation + approval + Slack fixture + audit |
| A2 Invoice review | classify + missing-capability deny + payment approval + audit |
| A3 Brand check | read-only capability closure, no side effect |
| A4 PR risk | sandbox task + checkpoint/resume + merge approval |
| A5 Acme meta demo | sequential cross-domain runs on one runtime |
| G1 Benefits inquiry | cited draft + PII/regulatory policy escalation + approval |
| G2 BenOps triage | dry-run + parameter-bound partial approval |
| G3 USP pack | multi-policy narrative workflow + brand/legal gate |
| G4 R&D isolation | sandbox + production-adapter deny + mock completion |
| G5 parity | Acme then Gusto through same CLI/runtime with manifest difference visible |

## 6. Provider model

All provider modes implement the private `ProviderPort`. Provider selection changes configuration, never a workflow definition, IR, public SDK type, policy decision, or approval protocol.

| Mode | Intended use | Credential source | Required proof |
|---|---|---|---|
| `mock` | Default local development and all CI | none | deterministic responses/events, fixture-controlled failures |
| `claude-cli` | Interactive local agent runs | existing local Claude CLI auth | ACP permission request is re-evaluated by Forge policy/approval |
| `codex-cli` | Interactive local agent runs | existing local Codex CLI auth | same workflow and provider conformance contract as Claude CLI |
| `direct-api` | Explicit unattended/production-like path | secret provider at composition root | opt-in only; key redaction and non-interactive retry/error behavior |

Requirements:

- `forge providers doctor` reports installed/authenticated CLI capabilities without printing credentials.
- Every run records provider ID/class, adapter version, model/config fingerprint, and resolved prompt version; logs never record raw prompts containing sensitive data or credential material.
- CLI permissions are a signal to request Forge authorization, not authorization itself.
- Provider conformance fixtures cover streaming event order, tool permission request, cancellation, transient failure, invalid response, and resume.
- A provider-switch test asserts identical compilation, DTO/schema validity, capability/policy behavior, and terminal control-flow class. It must **not** assert byte-identical natural-language output from live providers.
- V1 has `claude-cli` and `codex-cli` private adapters over `@simpill/acp-llm-cli`; provider profiles request capability sets and select from configured preference, health, concurrency, and policy. ACPX is not required by V1 and remains optional/private.

## 6.1 Canonical intake gateway

`WorkflowRequest` is the sole runtime intake DTO. It contains a versioned request ID, authenticated principal, idempotency/external reference, workflow type, title/description/business outcome, testable acceptance criteria, data classification, linked evidence resources, and optional requested workflow/profile. Zod validation rejects incomplete or unauthorized implementation requests; the prescribed alternative is a read-only discovery/remediation workflow that emits `EngineeringBrief` plus missing requirements and evidence references.

Intake determines whether the request is sufficiently specified; discovery determines likely affected resources; policy determines access; implementation performs work. Slack/Buzz messages are context, not an authoritative specification.

## 6.2 Team, service, profile, and inheritance configuration

Company extensions own versioned `TeamConfig`, `ServiceCatalogEntry`, `ProviderProfile`, `SandboxProfile`, and `IntakeProfile` assets. Resolution is deterministic: explicit request references → approved service catalog/ownership metadata → configured discovery evidence. Discovery can recommend a repository/service but never grants write, deploy, network, or secret access. Each overlay can only narrow platform constraints. Prompt/workflow inheritance resolves to a concrete ordered chain at compile time; cycles, ambiguous overrides, incompatible schemas, or security relaxation are compile diagnostics.

## 7. Prompt asset system

Prompts are company-owned versioned assets, not inline strings or permission rules.

```text
prompts/
  <domain>/
    <purpose>/
      v1.md                 # prompt body
      v1.meta.ts            # id, semver, schemas, allowed variables, sensitivity class
      v1.test.ts            # rendering, schema and injection-regression tests
```

Rules:

- `PromptAsset` includes immutable ID/version, input/output schema, allowed variables, sensitivity classification, and content fingerprint.
- Compile resolves every prompt reference to a concrete version and stores it in the run/audit record.
- A prompt linter rejects unbound variables, unversioned references, unsafe metadata, and duplicate IDs.
- Prompt content can propose an action but cannot define `requiredCapabilities`, alter policy, choose a sandbox profile, or disable an approval gate.
- UI shows a safe rendered preview and version/fingerprint only when the viewer is authorized; it never renders raw model HTML.

## 8. CLI, configuration, logging, and local development

### 8.1 CLI contract

The CLI uses Commander for parsing, Chalk for human-oriented terminal rendering, Pino/SimPill logger for structured logs, and a JSON output mode for automation.

| Command | Contract |
|---|---|
| `forge dev up` | Start API, worker, UI, Redis, Postgres, and local OTel collector; print health URLs and a correlation ID |
| `forge dev down` | Stop only Forge’s named local composition resources |
| `forge providers doctor` | Validate configured modes and show remediation, never secrets |
| `forge run --company <id> --workflow <id>` | Validate/compile/start a run; accepts `--provider`, `--sandbox`, `--json`, `--wait` |
| `forge demo run <scenario>` | Load deterministic fixture and execute documented happy/deny path |
| `forge approvals list|resolve` | List or resolve binding approvals; resolution requires decision, actor identity, and reason for reject |
| `forge inspect run <id>` | Show state, timeline, policy/approval events, safe diagnostics, and UI link |
| `forge validate --company <id>` | Load and compile-check manifests, workflows, capability closure, and configuration references without starting a run |
| `forge prompts check --company <id>` | Lint prompt IDs, versions, metadata, rendering bindings, and duplicate/fingerprint errors |
| `forge rerun --from <run-id>` | Start a new run pinned to the prior run's allowed artifact versions and safe replayable input; never reuse approval decisions |
| `forge workflow message <run-id> --text <text>` | Bind follow-up feedback to the existing run/checkpoint/provider session; rerun only impacted compiled steps |
| `forge workflow watch <run-id>` | Render timeline state from the same cursorable event API used by the browser |
| `forge workflow artifacts <run-id>` | List authorized, versioned artifact metadata and safe download/view references |

Exit-code policy: `0` completed; `1` operational failure; `2` invalid CLI/config/artifact input; `3` denied/rejected/expired; `4` waiting for approval. `--json` writes exactly one structured result to stdout; human output goes to stderr. Logs remain structured JSON by default and may use pretty rendering only in local interactive mode.

### 8.2 Configuration precedence

1. CLI flags (one run only)
2. Explicit process environment variables
3. `.env.local` (ignored; developer machine only)
4. checked-in local configuration/manifests
5. safe built-in defaults

Manifests contain config references, not secret values. Apps are the only composition roots that resolve config/secret references. `.env.example` documents every required key with safe values. A validated startup report identifies the source of non-secret values and the presence, not contents, of secret references.

### 8.3 Sandbox modes

| Mode | Availability | Semantics |
|---|---|---|
| `off` | explicit local development only | no security isolation; allowed only for trusted workflow/task/profile; CLI/UI labels it clearly |
| `docker` | local and CI for declared sandbox tasks | non-root, dropped capabilities, read-only root where possible, bounded CPU/memory/time, network deny by default, allowlisted mount/egress/credentials |
| `microvm` | future adapter | production path only after ADR/research and conformance suite |

Worktrees create per-run source workspaces. They do not replace Docker/microVM controls. Long approval waits checkpoint and destroy/clean sandbox resources by policy; a resume creates a fresh authorized lease when required.

The Docker adapter must never mount the host Docker socket, use host networking, inject ambient cloud credentials, or silently fall back to host execution when a sandbox is required. A required sandbox that cannot be created fails closed with a typed, actionable diagnostic.

### 8.4 Run, artifact, and replay contract

The API/worker boundary owns immutable run identity and append-only event ordering. A run records company/workflow versions, compiled artifact fingerprint, provider configuration fingerprint, safe input hash/reference, policy decisions, approval proposals/decisions, sandbox leases, and terminal outcome. Large or sensitive artifacts live in controlled artifact storage and are represented in events by redacted metadata and authorized references.

```text
start request -> validated Run record -> Queue job -> Worker execution -> append events
                                          |                                  |
                                          v                                  v
                                   idempotency key                    checkpoint / terminal outcome
                                          |
                                          v
                              duplicate request returns same Run reference
```

`rerun` creates a distinct run that pins prior artifact versions and accepts only replay-safe input. It does not copy approvals, privileged credentials, mutable external responses, or a dirty sandbox filesystem. Approval is requested again for every newly proposed effect.

## 9. UI/UX specification

### 9.1 Technology and boundaries

- `apps/ui` uses React, Tailwind CSS, and Shadcn/ui.
- Vercel AI Elements is added as editable, in-repo component source for streamed model output, citations, tool activity, and rich operator content; it is not an orchestration or authorization dependency.
- A modern accessible chart library renders duration, run outcome, queue lag, approval, and policy metrics from Forge DTOs.
- A modern React node/edge component renders the compiled workflow and live run state. It is strictly read-only: no drag/drop mutation, no graph persistence, and no alternative authoring surface.
- UI may import only public SDK DTOs/client contracts. It cannot import engine, queue, provider, sandbox, LangSmith, or company internals.
- The graph implementation disables node dragging, connecting, deletion, and mutable keyboard behavior; it exposes a semantic timeline/list alternative. Node/edge components, callbacks, and derived layout are memoized, and large graphs initially collapse completed subtrees.

### 9.2 Required surfaces

| Surface | User task | Required states |
|---|---|---|
| Approval inbox | find/review/decide on gated effects | pending, approved, rejected, expired, decision conflict, inaccessible |
| Approval detail | understand exact decision | recommendation labeled non-authoritative; policy reason; exact parameters/diff; evidence; prompt version; audit; approve/reject controls |
| Run inspector | diagnose a run | queued, running, waiting approval, retrying, completed, denied, rejected, failed, cancelled |
| Workflow/run graph | understand compiled path and live state | node status, retries, checkpoint, policy/gate/sandbox markers; keyboard-accessible summary alternative |
| Demo console | launch/replay scenario paths | fixture, provider, sandbox selection; happy/deny outcome; links to run/approval/audit |
| Local health/status | identify local prerequisites | API/worker/Redis/Postgres/OTel/provider readiness without secret disclosure |
| Control-plane overview | operate and capacity-plan Forge | workflows, agents, sandboxes, workers, queues, providers, MCP, policies, artifacts, approvals, audit |

### 9.3 UX and security requirements

- Approve actions display the effect and policy rationale before the control is enabled; reject requires a reason; all decisions are idempotency-bound to the proposed parameters/version.
- Never present model output as an authorized action or render raw model HTML.
- Browser receives least-privilege DTOs. Approval mutation uses authenticated actor identity, CSRF defenses, authorization, and audit logging.
- Use responsive layouts, visible focus styles, semantic labels, keyboard graph alternative, and axe-core CI checks from UI phase onward.
- CSP, secure headers, and sensitive field redaction are testable release requirements.
- Run inspector events use cursor-resumable server-sent events with REST snapshot recovery. The client de-duplicates event IDs, reconnects from the last cursor, and shows an explicit delayed/disconnected state; it does not poll high-volume run logs by default.
- Every detail surface shows **requested**, **granted**, and **observed** values. For example a sandbox displays its requested/granted resource/capability/network profile and measured CPU/memory/PID/disk/network/file activity, with sensitive values redacted. Administrative terminate, suspend, revoke, pause, retry, and quarantine actions require role authorization, confirmation, and immutable audit events.

### 9.4 Health and build metadata

Every deployable exposes `/health/live` (process alive), `/health/ready` (safe to accept work), and authenticated `/health` (version, git SHA, build time, uptime, dependency status). Every API response includes `X-Forge-Version`, `X-Forge-Git-SHA`, `X-Forge-Service`, and `X-Request-ID`. Liveness must not fail merely because a dependency is temporarily degraded; readiness does.

## 10. Incremental delivery roadmap

| Phase | Working deliverable | Visible demo | Exit gates |
|---|---|---|---|
| 0 | Handbook, ADRs, research | architecture/policy tabletop | document acceptance only |
| −1 | Vision validation | approved six-month traceability and flagship story | handbook 017 exit criteria |
| 1 | pnpm monorepo, package boundaries, CLI/API intake + run/artifact DTOs, config/logger, local `dev up`, UI health shell, health/build metadata | install/build/test; forbidden import fails; canonical request validates | unit, architecture, baseline budget, Gitleaks/license |
| 2 | manifest/compiler/IR, intake/discovery brief, mock+Claude CLI+Codex CLI adapters, Docker/worktree profiles, checkpoints, local OTel | flagship runs through read-only discovery and simulated resume | unit, architecture, compile budget, Trivy, provider contracts, API acceptance |
| 3 | OPA policy, capability closure, security SDK pipeline, approvals, audit, judges, queue/worker execution | flagship produces tested/reviewed patch; A1/A2 approve/reject/deny paths | exhaustive FSM/policy/judge tests, gate-bypass/injection security, acceptance |
| 4 | Acme package, full operator UI, graph/timeline/demo console | A1–A5 Playwright/API | UI a11y, CSP/CSRF/ZAP, demo performance, architecture |
| 5 | Gusto Benefits/BenOps and `forge.acme` company packages | G1/G2, partial approval | policy/PII tests, extension-boundary test, acceptance |
| 6 | redaction/dashboard hardening, LangSmith optional adapter, Gusto USP/R&D | G3/G4/G5 parity via CLI and UI | cardinality budget, R&D deny, redaction, acceptance |
| 7 | distribution, SBOM/signing, load/chaos/runbooks, staging | worker restart + pending approval; sandbox failure recovery | release/security/load/staging checklist |
| 8 | connector extensions | Jira/Slack/Buzz normalize to same `WorkflowRequest` | connector contract/E2E and core non-dependency tests |

Every phase ships: an artifact list, a human demo, automated acceptance coverage where applicable, a budget update, a security gate, documentation updates, and explicit next-phase entry criteria. No phase is marked complete based only on code existence.

## 11. Testing and release criteria

1. Unit tests exercise schemas, compiler diagnostics, run/approval state transitions, idempotency, policy mapping, redaction, config precedence, replay restrictions, and CLI exit/JSON contracts.
2. Architecture tests enforce company/core direction and forbidden vendor imports in public/UI packages.
3. Contract suites validate provider, plugin, sandbox, queue, and approval ports against mocks and real adapters where safe.
4. Integration suites use Testcontainers for Redis/Postgres/Docker-backed adapters.
5. Playwright/API acceptance implements A1–A5 and G1–G5; default runs use mocks, while CLI provider smoke tests are opt-in local jobs.
6. Security suites cover prompt injection, capability escalation, policy engine error, approval replay/parameter substitution, secret redaction, sandbox escape controls, and UI CSRF/CSP.
7. Phase 1 records reproducible baseline measurements for cold/warm `dev up`, CLI startup, empty compilation, API health, and UI first render. Subsequent phases set versioned p95 budgets from those baselines and track compile, policy decision, approval-open, SSE reconnect, scenario E2E, queue lag, worker concurrency, and trace-cardinality regression.
8. CI and releases produce lint/typecheck/test/fitness/scan results; Phase 7 adds SBOM, vulnerability policy, artifact signing, and staging smoke.
9. Security and resilience tests include bounded retry exhaustion, timeout/circuit-open/backpressure state, injection/secret detector failure, provider/sandbox/Redis partition, queue duplicate/stall recovery, and connector publication failure.

## 12. Risks and explicit decisions

| Risk | Control / decision |
|---|---|
| CLI adapters vary by local installation/auth | `providers doctor`, capability discovery, deterministic mock fallback, adapter conformance fixtures |
| `@simpill/acp-llm-cli` currently has Zod v3 peer constraints | normalize types at private adapter boundary; public Forge remains Zod v4 |
| Provider/API credentials leak through logs or sandboxes | composition-root secret resolution, redaction tests, ephemeral scoped injection only |
| UI graph becomes a configuration fork | read-only DTO renderer; authoring remains typed manifests; UI dependency fitness test |
| Live inspector overloads API or browser | cursor-resumable SSE, event DTO size/cardinality budgets, collapsed graph subtrees, snapshot recovery |
| Replay accidentally repeats a privileged effect | new run identity, replay-safe input only, no approval/credential/sandbox copying, fresh policy and gate |
| Docker mistaken for universal security | sandbox tier labels; policy/network/credential controls; microVM deferred behind a future ADR |
| Scenario copying hides regressions | primitive coverage declaration plus shared acceptance helpers and G5 parity contract |
| UI library churn | pin majors, wrap UI-specific integrations, maintain component and accessibility tests |

## 13. Definition of success

Forge is ready for production evaluation when all A1–A5 and G1–G5 scenarios pass in staging; the CLI can run Acme and Gusto through one runtime; provider switching does not change workflow source; all side effects are policy- and approval-controlled; the UI is evidence-first and accessible; logs/traces/audit correlate and redact; sandbox behavior is accurately labeled and enforced; and the release pipeline produces scanned, attributable artifacts.

## 14. CEO and engineering review resolution

### CEO review

- **Accepted:** Treat the scenario catalog as a composable product surface rather than a set of isolated demos. `validate`, prompt checks, and safe rerun create the workflow-author feedback loop needed between visible demos.
- **Accepted:** Make run history and replay a first-class operator outcome. A user can move from a surprising result to a reproducible, version-pinned new run without copying a graph or trusting stale approval.
- **Deferred:** Drag-and-drop workflow editing, workflow marketplace, multi-agent mesh/A2A, and proactive notifications. They do not improve the first proof that typed compilation plus human governance works.

### Engineering review

- **Accepted:** Provider equality means compile/control/schema/policy parity, not matching live-model text.
- **Accepted:** Document run/artifact/event ownership, queue idempotency, and cursor-resumable inspector delivery before implementation.
- **Accepted:** Make Docker's prohibited host access explicit and require fail-closed sandbox creation.
- **Accepted:** Make read-only graph behavior enforceable with immutable canvas settings, semantic fallback, and performance guardrails.
- **Accepted:** Establish measurements before hard p95 numbers; budgets tighten from recorded Phase 1 baselines.
