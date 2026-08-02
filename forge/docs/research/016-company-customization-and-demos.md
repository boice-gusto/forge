# Research: Company Customization Model & Demo Scenarios

> Status: Phase 0 research notes  
> Feeds: `000-overview`, `002-problem-statement`, `009-plugin-sdk`, `015-phases`, `016-demo-scenarios`  
> Principles: Extension over Replacement · Compile Don't Configure · Policies before Permissions · Humans Approve, AI Recommends

---

## 1. Separation of Concerns: `forge` vs `forge.gusto`

### 1.1 One-sentence rule

**`forge` is the generic AI workflow runtime. `forge.gusto` is a company package that extends it. Acme is a living demo org that proves the generic framework works without company-specific code.**

### 1.2 Ownership matrix

| Concern | Lives in `forge` (core) | Lives in `examples/acme` | Lives in `forge.gusto` |
|---|---|---|---|
| Workflow compiler | ✓ | | |
| Runtime / engine adapters (LangGraph behind ports) | ✓ | | |
| Provider SDK (Claude, mock, …) | ✓ | | |
| Sandbox / queue / observability abstractions | ✓ | | |
| Plugin SDK + manifest schema | ✓ | | |
| Typed policy engine (capabilities, approval gates) | ✓ | | |
| Prompt asset registry (versioned, typed) | ✓ interfaces | demo prompts | company prompts |
| Generic skills (summarize, classify, draft, search) | ✓ reusable | uses | may wrap / compose |
| Domain workflows (campaign brief, invoice review) | | ✓ | |
| Domain workflows (benefits enrollment, BenOps) | | | ✓ |
| Org manifests (depts, channels, repos, Jira) | | ✓ | ✓ |
| Company policies (PII, benefits data, SOC2) | | illustrative | ✓ production-shaped |
| Company adapters (Gusto APIs, Slack workspaces) | | mock adapters | ✓ real + mock |
| Branding / UI theming | theme tokens only | Acme theme | Gusto theme |
| Hardcoded Slack channels / Jira projects / repo names | **NEVER** | config only | config only |

### 1.3 What core MUST provide

1. **Compile path** — Manifest + typed workflow definitions → compiled graph for the underlying engine. Orgs never hand-wire graphs.
2. **Plugin load path** — Discover, validate (Zod), register, version plugins. Fail closed on schema violations.
3. **Capability model** — Skills declare required capabilities; policies grant/deny; prompts never expand capabilities.
4. **Approval protocol** — First-class human gates: recommend → await approval → execute side effects.
5. **Ports** — Providers, sandboxes, queues, stores, telemetry, feature flags — all behind interfaces.
6. **Company package contract** — A documented, versioned interface that `forge.gusto` (and future `forge.<org>`) implements.

### 1.4 What core MUST NOT contain

- Gusto (or any real company) business rules, domain nouns, or org structure
- Hardcoded repository names, Jira projects, Slack channels, team IDs
- Provider-specific public APIs (LangGraph, BullMQ, Claude SDK, ACPX leak through)
- Permission decisions derived from prompt text
- Fork-friendly “copy this repo and customize” guidance — only extension

### 1.5 What `forge.gusto` IS

A **company extension package** that depends on `@forge/*` packages and contributes:

```
forge.gusto/
  package.json                 # depends on @forge/runtime, @forge/plugin-sdk, …
  forge.company.json           # company manifest root
  domains/
    benefits/
    benops/
    usp/
    r-and-d/
  plugins/                     # company-specific plugins
  adapters/                    # Gusto system adapters (ports implemented)
  policies/                    # typed policy packs
  prompts/                     # versioned prompt assets
  workflows/                   # typed workflow definitions (compiled by core)
  skills/                      # typed skills (domain)
  fixtures/                    # demo data + mock backends
  demos/                       # acceptance demo scripts / playwright specs
```

### 1.6 What `examples/acme` IS

A **generic living demo organization** that ships *inside* the Forge monorepo (or as `examples/acme`) to prove:

- Same runtime, different manifests → different department workflows
- Marketing / Finance / Design / Engineering are first-class generic domains
- A new company can copy the *pattern* of Acme (not fork Forge) to start

Acme is not a second runtime. It is configuration + plugins + fixtures.

### 1.7 Dependency direction (non-negotiable)

```
forge.gusto ──depends──► forge (packages)
examples/acme ──depends──► forge (packages)
forge ──never depends──► forge.gusto | examples/acme
```

Architecture tests must fail if core imports company or example packages.

### 1.8 Content for `000-overview.md`

**Product definition (draft):**  
Forge is a typed AI workflow runtime that compiles manifests, plugins, skills, and policies into deterministic infrastructure with intelligent execution. Organizations extend Forge; they never fork it. Humans approve; AI recommends.

**Identity principles to elevate:**
1. Compile. Don't Configure.
2. Deterministic Infrastructure. Intelligent Execution.
3. Extension over Replacement.
4. Adapters at Every Boundary.
5. Prompts are Versioned Assets.
6. Policies before Permissions.
7. Humans own the final decision.
8. Research before Implementation.

**Two proof points:**
- **Acme** — generic framework works for any org shape
- **Gusto** — real company customization without forking

---

## 2. Company Configuration Model

### 2.1 Mental model (layers)

```
┌─────────────────────────────────────────────────────────┐
│  Company Package (forge.gusto / examples/acme)          │
│  manifests · plugins · workflows · skills · policies    │
│  prompts · adapters · fixtures                          │
└───────────────────────────┬─────────────────────────────┘
                            │ load + validate (Zod)
┌───────────────────────────▼─────────────────────────────┐
│  Forge Plugin SDK + Company Loader                      │
│  resolve deps · version check · capability binding      │
└───────────────────────────┬─────────────────────────────┘
                            │ compile
┌───────────────────────────▼─────────────────────────────┐
│  Workflow Compiler                                      │
│  typed graph · approval gates · policy hooks · prompts  │
└───────────────────────────┬─────────────────────────────┘
                            │ execute
┌───────────────────────────▼─────────────────────────────┐
│  Runtime (ports)                                        │
│  provider · sandbox · queue · store · otel · approvals  │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Artifact types (typed, versioned)

Every company artifact is:

| Artifact | Typed with | Versioned | Validated at |
|---|---|---|---|
| Company manifest | Zod schema `CompanyManifest` | semver + content hash | load time |
| Domain manifest | Zod `DomainManifest` | semver | load time |
| Workflow definition | Zod `WorkflowDefinition` | semver | compile time |
| Skill | Zod `SkillDefinition` | semver | register time |
| Policy pack | Zod `PolicyPack` | semver | register time |
| Prompt asset | Zod `PromptAsset` | semver + immutable id | resolve time |
| Plugin | Zod `PluginManifest` + SDK interface | semver | register time |
| Adapter binding | Zod `AdapterBinding` | pin to package version | boot time |

**Rule:** No magic strings for artifact IDs. Constants + branded types. Safe parse only (`safeParse` / Result).

### 2.3 Manifest hierarchy (proposed)

```yaml
# forge.company.json (conceptual; final format ADR-bound)
apiVersion: forge.company/v1
kind: Company
metadata:
  id: gusto                    # branded CompanyId
  name: Gusto
  version: 0.1.0
spec:
  domains:
    - ref: domains/benefits
    - ref: domains/benops
    - ref: domains/usp
    - ref: domains/r-and-d
  plugins:
    - package: "@forge.gusto/plugin-benefits"
      version: "^0.1.0"
  policyPacks:
    - ref: policies/pii
    - ref: policies/benefits-data
    - ref: policies/human-approval-defaults
  adapters:
    slack: { binding: "@forge.gusto/adapter-slack", configRef: config/slack }
    jira:  { binding: "@forge.gusto/adapter-jira",  configRef: config/jira }
  featureFlags:
    provider: openfeature     # via adapter
  defaults:
    approvalRequiredFor:
      - side_effect.write
      - external.api.call
      - pii.export
```

Domain manifest adds workflows, skills, channel/repo *config refs* (not hardcoded IDs in code).

### 2.4 Plugin model (feeds `009-plugin-sdk.md`)

**Plugin = versioned contribution unit** that may register:

- Workflows
- Skills
- Policies
- Prompt assets
- Adapter implementations (for company ports)
- UI contributions (optional, later phases)
- Demo fixtures

**SDK surface (research target):**

```ts
// Conceptual — finalize in ADR + 009-plugin-sdk
interface ForgePlugin {
  readonly manifest: PluginManifest; // Zod-validated
  register(ctx: PluginContext): void | Promise<void>;
}

interface PluginContext {
  workflows: WorkflowRegistry;
  skills: SkillRegistry;
  policies: PolicyRegistry;
  prompts: PromptRegistry;
  adapters: AdapterRegistry;
  // NO direct LangGraph / BullMQ / Claude access
}
```

**Plugin rules:**
1. Plugins cannot escalate capabilities beyond what the host grants.
2. Plugins cannot bypass approval gates.
3. Plugins receive only ports/adapters — never engine internals.
4. Plugin manifests declare `requiredCapabilities[]` and `providedCapabilities[]`.
5. Core validates capability closure before compile.

### 2.5 Typed workflows

A workflow definition is data + typed nodes, not ad-hoc code wiring:

- `id`, `version`, `domain`, `inputSchema`, `outputSchema`
- `nodes[]` with kinds: `skill` | `policy.check` | `human.approve` | `adapter.call` | `branch` | `parallel` | `compile.child`
- `sideEffects[]` explicitly declared (compiler enforces gates)
- `promptRefs[]` — only versioned prompt assets
- `failurePolicy`, `timeouts`, `retries` as structured config

Compiler produces an opaque compiled workflow. Public API never exposes LangGraph types.

### 2.6 Typed skills

Skills are reusable, capability-bounded units:

- Input/output Zod schemas
- Required capabilities (e.g. `docs.read`, `slack.post`, `benefits.member.read`)
- Optional sandbox requirement
- Prompt refs + deterministic tools
- Idempotency / timeout metadata

**Skills do not grant permissions.** They *request* capabilities; policies decide.

### 2.7 Typed policies

Policies evaluate before any privileged action:

```
Request(action, resource, actor, context)
  → PolicyEngine.evaluate(policyPacks)
  → Allow | Deny | RequireApproval(reason, approverRoles)
```

Policy packs are versioned, testable, and not prompt-authored. Prompts may *explain* a recommendation; they never *authorize* it.

**Default company packs (Gusto-shaped):**
- `human-approval-defaults` — side effects require approval
- `pii` — PII classification + export controls
- `benefits-data` — member/benefits data access
- `change-management` — USP / prod-adjacent changes
- `research-sandbox` — R&D isolation (no prod adapters)

### 2.8 Config vs secrets

| Kind | Storage | Examples |
|---|---|---|
| Config | company config files / config service | channel *names as refs*, project keys as refs, feature flags |
| Secrets | env / secret manager only | API tokens, webhook secrets |
| Identity | IdP / org directory adapter | approver roles, team membership |

Never put secrets in manifests. Never put org-specific IDs in core.

### 2.9 Content for `002-problem-statement.md`

**Problem:** Organizations adopting AI workflows today fork frameworks, hardcode tools into prompts, and conflate model suggestions with authorization. The result is unmaintainable, insecure, and non-portable automation.

**Forge's answer:** A compile-time, typed, policy-gated runtime. Companies ship packages of manifests/plugins. The same runtime executes Acme marketing and Gusto BenOps without forking.

**Non-goals (explicit):**
- Not a prompt playground
- Not a LangGraph wrapper with a thin coat of paint
- Not a per-company fork model
- Not “agent can do anything the model asks”

### 2.10 Content for `009-plugin-sdk.md` (outline to flesh in Phase 0)

1. Goals / non-goals  
2. Plugin lifecycle (discover → validate → register → compile → execute)  
3. Manifest schema (Zod)  
4. Registries & contribution points  
5. Capability model & closure checking  
6. Versioning & compatibility policy  
7. Testing plugins (unit + contract + architecture tests)  
8. Forbidden APIs (engine leak list)  
9. Company package layout convention  
10. Reference plugins: Acme marketing + Gusto benefits  

---

## 3. Demo Scenarios

### 3.1 Demo design rules

Every demo must prove at least one principle and be **acceptance-testable**:

1. Same runtime, different company package  
2. Extension (no fork)  
3. Human approval before side effects  
4. Policy deny/approve path (not prompt-controlled)  
5. Compile from manifests (no hand-wired public graphs)  
6. Switch provider (e.g. Claude ↔ mock) without workflow rewrite  

Each scenario includes: **User story → Flow → Acceptance demo script → Exit criteria**.

---

### 3.2 Acme (generic framework)

#### A1 — Marketing: Campaign brief → draft assets → human approve → publish request

**User story:**  
As an Acme marketing lead, I want Forge to draft a campaign brief and social copy from a product launch brief, then wait for my approval before posting a *publish request* to Slack.

**Flow:**
1. Load `examples/acme` company manifest, domain `marketing`
2. Compile workflow `marketing.campaign-brief`
3. Skill: extract goals/audience; Skill: draft copy (prompt asset `acme.marketing.draft.v1`)
4. Policy: `external.publish` → RequireApproval
5. Human approves or rejects in UI
6. On approve: adapter `slack.post` with config ref `acme.marketing.launch-channel` (fixture)

**Acceptance demo:**
- [ ] `forge demo acme marketing.campaign-brief` completes with mock provider
- [ ] Rejection path leaves no Slack fixture call
- [ ] Approval path records audit event + one fixture post
- [ ] Switching provider to mock mid-config still compiles/runs same workflow

**Proves:** Compile · Human approve · Adapters · Prompt assets

---

#### A2 — Finance: Invoice anomaly review

**User story:**  
As an Acme finance analyst, I want Forge to flag anomalous invoices and recommend actions, but never approve payments without a human.

**Flow:**
1. Ingest fixture invoices
2. Skill: classify anomalies
3. Policy: `finance.payment.initiate` always RequireApproval (or Deny in demo mode)
4. Human decision recorded; AI recommendation attached as evidence, not authority

**Acceptance demo:**
- [ ] Demo shows recommendation ≠ authorization (policy log)
- [ ] Attempted skill call without capability fails closed
- [ ] Audit trail includes policy decision id + prompt asset versions

**Proves:** Policies before permissions · Humans own decision

---

#### A3 — Design: Brand asset checklist + critique

**User story:**  
As an Acme designer, I want Forge to check a design handoff against brand rules and produce a critique report without mutating design files.

**Flow:**
1. Read-only design fixture
2. Skill: checklist against `acme.design.brand-rules.v1`
3. No write capabilities granted → any write attempt denied by policy

**Acceptance demo:**
- [ ] Report produced; zero write adapter calls
- [ ] Capability closure test in CI

**Proves:** Capability model · Deterministic checks + intelligent critique

---

#### A4 — Engineering: PR risk summary + merge recommendation

**User story:**  
As an Acme eng lead, I want a PR risk summary and merge recommendation, with merge action gated by approval.

**Flow:**
1. Fixture PR + CI results
2. Skills: summarize diff, map to risk rubric
3. Policy: `vcs.merge` → RequireApproval
4. Human approves → mock VCS adapter merge call

**Acceptance demo:**
- [ ] Resume-after-approval works (workflow checkpoint)
- [ ] Deny leaves PR unmerged in fixture store

**Proves:** Resume · Approval gates · Same runtime as marketing

---

#### A5 — Cross-domain proof (meta demo)

**User story:**  
As a platform engineer, I want to run Acme marketing and Acme engineering workflows back-to-back on one Forge process.

**Acceptance demo:**
- [ ] Single runtime boot; two domain manifests; no shared hardcoded channels
- [ ] Architecture test: no imports from `forge.gusto`

**Proves:** Generic framework · Extension over replacement

---

### 3.3 Gusto (company customization)

Gusto domains from north-star: **benefits**, **benops**, **usp**, **r&d**.

#### G1 — Benefits: Member question → grounded answer → escalate if low confidence

**User story:**  
As a Benefits specialist, I want Forge to draft an answer to a member benefits question using approved knowledge sources, cite sources, and escalate to a human when confidence or policy requires it.

**Flow:**
1. Load `forge.gusto` company + `benefits` domain
2. Workflow `benefits.member-inquiry`
3. Skills: retrieve approved KB, draft answer, classify sensitivity
4. Policy: `benefits.advice.regulated` → RequireApproval or Deny for certain topics
5. Side effect `member.message.send` only after approval

**Acceptance demo:**
- [ ] Fixture member inquiry produces cited draft
- [ ] Regulated topic forces approval (policy id asserted)
- [ ] Prompt cannot grant `member.message.send` if policy denies
- [ ] Runs on same binary/runtime as Acme demos

**Proves:** Company package · Policy > prompt · Human approve

---

#### G2 — BenOps: Operational ticket triage → recommended runbook → gated execution

**User story:**  
As a BenOps operator, I want Forge to triage an ops ticket, recommend a runbook, and execute only the approved steps.

**Flow:**
1. Ticket fixture (pager/Jira-shaped via adapter)
2. Skill: classify severity + match runbook
3. Workflow expands runbook steps; each `adapter.call` with write effect gated
4. Human approves step batch or individual steps (configurable)

**Acceptance demo:**
- [ ] Dry-run mode executes zero write adapters
- [ ] Approve-all executes N fixture writes matching runbook
- [ ] Partial approve executes subset; remaining cancelled with audit

**Proves:** Extension · Deterministic infrastructure · Intelligent triage

---

#### G3 — USP: Unique selling / product narrative pack (or Unified Support path)

> **Open naming note for ADR:** North-star lists `usp` without expansion. Treat as a **first-class Gusto domain package** whose concrete workflows are finalized in Phase 0 stakeholder research. Until then, demo USP as: *product/positioning + go-to-market support workflows* that consume company knowledge and require brand/legal approval before external publish. If USP means a different internal Gusto org unit, swap workflow nouns without changing the configuration model.

**User story (working assumption):**  
As a USP stakeholder, I want Forge to assemble a product narrative pack from internal sources and route it through brand/legal approval before any external channel publish.

**Flow:**
1. Domain `usp` manifest + plugins
2. Skills: synthesize narrative, extract claims, flag unverified claims
3. Policy: `external.publish` + `claims.regulated` → RequireApproval (multi-role if needed)
4. Publish adapters only post-approval

**Acceptance demo:**
- [ ] Unverified claim → blocked or forced human review
- [ ] Approval records role + policy pack version
- [ ] Zero Gusto logic in `forge/` core (import boundary test)

**Proves:** Company customization · Multi-policy packs · Extension

---

#### G4 — R&D: Research experiment in sandbox with prod isolation

**User story:**  
As an R&D engineer, I want to run experimental agent workflows in a sandbox that cannot touch production adapters.

**Flow:**
1. Domain `r-and-d` with policy pack `research-sandbox`
2. Adapter registry binds only mock/sandbox adapters
3. Attempt to call prod binding → Deny at policy/capability layer
4. Optional: disposable sandbox (Firecracker/Testcontainers — tech ADR)

**Acceptance demo:**
- [ ] Prod adapter invocation fails closed with structured error
- [ ] Experiment workflow completes against mocks
- [ ] Telemetry marks `environment=research`

**Proves:** Policies · Adapters · Sandbox boundary

---

#### G5 — Parity demo: Acme vs Gusto on one runtime

**User story:**  
As a principal engineer evaluating Forge, I want to see Acme marketing and Gusto BenOps run from the same Forge installation, differing only by company package.

**Acceptance demo:**
- [ ] `forge run --company acme --workflow marketing.campaign-brief`
- [ ] `forge run --company gusto --workflow benops.ticket-triage`
- [ ] Diff of loaded manifests shown in demo UI/CLI
- [ ] No restart of core required beyond company load (or documented hot-load rules)

**Proves:** North-star claim — “same runtime, different manifests + plugins”

---

### 3.4 Content for `016-demo-scenarios.md` (structure)

For each scenario A1–A5, G1–G5:

```
## <ID> <Title>
### Principle(s) proven
### Actors
### Preconditions / fixtures
### User story
### Sequence (happy path)
### Sequence (deny / failure path)
### Acceptance checklist
### Telemetry / audit assertions
### Phase introduced
```

Map scenarios to phases (see §5).

---

## 4. What Phase 0 Research Must Produce (Before Any Code)

Phase 0 = **research only**. No production implementation. Dogfoods “Research before Implementation.”

### 4.1 Mandatory research topics (from north-star)

| Topic | Output artifact | Decision needed |
|---|---|---|
| LangGraph | research note + ADR candidate | Adopt as engine behind port? Alternatives? |
| LangSmith | research note + ADR | Observability adapter vs required dep |
| BullMQ | research note + ADR | Queue port default impl |
| Sandbox tech | research note + ADR | Firecracker vs containers vs process |
| Firecracker | deep dive | Feasible for Phase N? |
| Testcontainers | deep dive | Dev/test strategy |
| MCP | research note + ADR | Skill/tool boundary |
| A2A | research note | Interop later vs now |
| ACPX | research note + ADR | Integration behind port |
| SimPill | research note + ADR | Role in runtime |
| Vercel AI SDK | research note + ADR | Provider layer fit |
| AI Elements | research note | UI building blocks |
| OpenTelemetry | research note + ADR | Canonical telemetry |
| Open Policy Agent | research note + ADR | Policy engine vs typed-TS policies |
| OpenFeature | research note + ADR | Feature flags |

### 4.2 Phase 0 artifacts checklist (exit criteria)

**Documents**
- [ ] `docs/000`–`016` drafts + `MASTER_SPEC.md` skeleton that links them
- [ ] Project constitution (never-violate list) finalized
- [ ] What-not-to-build list finalized
- [ ] Company configuration model (this doc → `009` + company section)
- [ ] Demo scenario catalog (`016`) with acceptance checklists
- [ ] Monorepo layout ADR
- [ ] Plugin SDK ADR (schemas, lifecycle, forbidden APIs)
- [ ] Workflow compiler ADR (compile inputs/outputs, opacity of engine)
- [ ] Provider port ADR
- [ ] Policy model ADR (OPA vs native typed policies — decision matrix)
- [ ] Sandbox ADR
- [ ] Observability ADR
- [ ] Threat model draft (`014` / `006` as numbered in final set)

**Decision matrices** (template per tech):
- Options considered  
- Criteria (security, operability, TS fit, OSS maturity, abstraction leak risk)  
- Recommendation  
- Revisit triggers  

**Benchmarks / spikes (read-only or throwaway sandboxes only)**
- [ ] Minimal LangGraph “hello workflow” behind a port (throwaway; not merged as product)
- [ ] Zod v4 boundary parsing spike for manifests
- [ ] Policy deny path spike (prove prompt cannot escalate)
- [ ] Dual-company load spike (Acme + Gusto manifests in one process) — design validation

**Quality of Phase 0 itself**
- [ ] Every ADR has alternatives considered + tradeoffs  
- [ ] Every phase (1+) has Deliverables / Demo / Quality Gates / Exit Criteria stubs  
- [ ] No `forge` package depends on `forge.gusto` in the planned graph  
- [ ] Open questions list with owners  

### 4.3 Explicit Phase 0 non-deliverables

- No production workflow compiler  
- No published npm packages  
- No real Gusto production credentials  
- No UI product  
- No “temporary” core forks for Gusto  

### 4.4 Content for `015-phases.md` (Phase 0 section draft)

```
Phase 0 — Research & Specification
Deliverables
  ✓ Tech research notes (list above)
  ✓ ADRs + decision matrices
  ✓ MASTER_SPEC + docs 000–016 skeletons filled to reviewable quality
  ✓ Demo catalog with acceptance criteria
  ✓ Monorepo layout decision
Demo
  ✓ Walkthrough of Acme vs Gusto separation (doc + diagram)
  ✓ Tabletop demo of policy > prompt (sequence diagram)
Quality Gates
  ✓ ADR completeness checklist
  ✓ Constitution + what-not-to-build reviewed
  ✓ No implementation PRs merged
Exit Criteria
  ✓ All Phase 0 artifacts accepted
  ✓ Implementation agent can start Phase 1 from MASTER_SPEC alone
```

### 4.5 Suggested early implementation phases (stubs for `015`)

| Phase | Focus | Demo milestone |
|---|---|---|
| 0 | Research & spec | Doc walkthrough |
| 1 | Monorepo + constitution tooling (lint, arch tests) | `pnpm` workspace boots; arch test forbids bad imports |
| 2 | Provider + sandbox + compiler skeleton | Two providers; resume workflow |
| 3 | Plugin SDK + company loader | Load Acme company package |
| 4 | Policies + approvals | A2 finance / A1 marketing approval paths |
| 5 | Acme full demo suite | A1–A5 green |
| 6 | `forge.gusto` package + G1–G2 | Benefits + BenOps demos |
| 7 | G3–G5 + parity demo | USP + R&D isolation + dual-company |
| 8+ | Observability, UI, hardening, prod readiness | Per `015` detail |

*(Exact phase boundaries finalized after Phase 0 ADRs.)*

---

## 5. Suggested Monorepo / Project Layout

Root: `/Volumes/BlackBox/GitHub/forge`

```
forge/                              # repository root (name: forge)
├── README.md
├── MASTER_SPEC.md                  # or forge/docs/MASTER_SPEC.md — pick in ADR
├── pnpm-workspace.yaml
├── package.json
├── turbo.json                      # or nx — ADR
├── .gitignore
├── docs/
│   ├── 000-overview.md
│   ├── 001-vision.md
│   ├── 002-problem-statement.md
│   ├── 003-project-constitution.md
│   ├── 004-architecture.md
│   ├── 005-research-workflow.md
│   ├── 006-runtime.md
│   ├── 007-workflow-compiler.md
│   ├── 008-provider-sdk.md
│   ├── 009-plugin-sdk.md
│   ├── 010-sandbox.md
│   ├── 011-observability.md
│   ├── 012-ui.md
│   ├── 013-testing.md
│   ├── 014-security.md
│   ├── 015-phases.md
│   ├── 016-demo-scenarios.md
│   ├── adr/
│   └── research/                   # Phase 0 notes (this file lives here today under forge/docs)
├── packages/                       # @forge/* core
│   ├── tsconfig/                   # shared TS config
│   ├── eslint-config/
│   ├── constants/                  # no magic strings shared
│   ├── schema/                     # Zod schemas: manifests, workflows, skills, policies
│   ├── plugin-sdk/                 # Plugin types + host APIs
│   ├── compiler/                   # workflow compiler
│   ├── runtime/                    # execution runtime
│   ├── provider/                   # provider port + mock
│   ├── provider-claude/            # Claude adapter (optional package)
│   ├── sandbox/                    # sandbox port
│   ├── queue/                      # queue port
│   ├── policy/                     # policy engine port + default impl
│   ├── approvals/                  # human approval protocol
│   ├── observability/              # OTel + LangSmith adapters
│   ├── config/                     # config loading (not secrets)
│   └── cli/                        # forge CLI
├── examples/
│   └── acme/
│       ├── forge.company.json
│       ├── domains/
│       │   ├── marketing/
│       │   ├── finance/
│       │   ├── design/
│       │   └── engineering/
│       ├── plugins/
│       ├── policies/
│       ├── prompts/
│       ├── fixtures/
│       └── demos/
├── forge.gusto/                    # company package (sibling, not under packages/)
│   ├── package.json                # name: @forge.gusto/company or forge.gusto
│   ├── forge.company.json
│   ├── domains/
│   │   ├── benefits/
│   │   ├── benops/
│   │   ├── usp/
│   │   └── r-and-d/
│   ├── plugins/
│   ├── adapters/
│   ├── policies/
│   ├── prompts/
│   ├── workflows/
│   ├── skills/
│   ├── fixtures/
│   ├── demos/
│   ├── CLAUDE.md
│   └── AGENT.md
├── tooling/
│   ├── architecture-tests/         # dependency-cruiser / eslint boundaries
│   └── scripts/
└── .github/workflows/
```

### 5.1 Layout decisions to lock in Phase 0 ADR

1. **Where does today's nested `forge/forge` go?**  
   Current disk has `forge/` and `forge.gusto/` as siblings under the repo root already named `forge`. Prefer: **repo root = monorepo root**; move existing `forge/docs` → root `docs/` or keep `forge/` as the core package folder renamed to `packages/` content.  
   **Recommendation:** Treat current `forge/` directory as the future core workspace root content; flatten so `packages/`, `docs/`, `examples/` live at repo root beside `forge.gusto/`.

2. **Is `forge.gusto` a workspace package?**  
   Yes — member of pnpm workspace, but **not** published as part of public Forge core. Private/company package.

3. **Is Acme under `examples/` or `packages/`?**  
   `examples/acme` — never imported by core.

4. **Public package names:**  
   `@forge/runtime`, `@forge/plugin-sdk`, `@forge/schema`, …  
   `@forge.gusto/*` for company plugins/adapters.

### 5.2 Boundary enforcement (Phase 1 quality gate)

```
forbidden:
  - packages/** importing forge.gusto/**
  - packages/** importing examples/**
  - forge.gusto/** importing examples/acme/** (optional soft rule)
allowed:
  - forge.gusto → packages/@forge/*
  - examples/acme → packages/@forge/*
```

### 5.3 Mapping current disk → target

| Current | Target |
|---|---|
| `/Volumes/BlackBox/GitHub/forge/forge/` | Core docs + eventually `packages/*` (or repo-root packages) |
| `/Volumes/BlackBox/GitHub/forge/forge.gusto/` | Company package (keep sibling path) |
| `forge/docs/research/RAW.md` | Preserve as research input; promote into `000`–`016` |
| No `package.json` today | Created in Phase 1 after Phase 0 ADRs |

---

## 6. Cross-Doc Injection Map

Use this when drafting the formal specs:

| Target doc | Inject from this research |
|---|---|
| `000-overview` | §1.8 product definition, principles, Acme vs Gusto proof points, dependency direction |
| `002-problem-statement` | §2.9 problem / answer / non-goals |
| `009-plugin-sdk` | §2.4–2.7, §2.10 outline, company package layout |
| `015-phases` | §4.4 Phase 0, §4.5 phase stubs, every phase ends with Deliverables/Demo/Quality Gates/Exit Criteria |
| `016-demo-scenarios` | §3 full catalog A1–A5, G1–G5 with acceptance checklists |

---

## 7. Open Questions (resolve in Phase 0)

1. Exact expansion of **USP** at Gusto (org unit vs product narrative) — does not block model; blocks workflow nouns only.  
2. Multi-approver / quorum support in v1 or later?  
3. Hot-reload of company packages vs process restart?  
4. OPA vs native TypeScript policy engine for v1?  
5. Single repo vs submodule for `forge.gusto` long-term (start: monorepo sibling).  
6. CLI UX: `forge run --company` vs separate entrypoints.  
7. How much of Acme ships in OSS release vs internal?

---

## 8. Definition of Done for This Research Thread

- [x] Core vs company vs Acme ownership matrix  
- [x] Configuration model (manifests, plugins, workflows, skills, policies)  
- [x] Concrete Acme + Gusto demo scenarios with acceptance demos  
- [x] Phase 0 produce-list before code  
- [x] Monorepo layout recommendation for `forge/` + `forge.gusto/`  
- [x] Mapped to docs 000, 002, 009, 015, 016  

**Next:** Promote sections into formal `000`/`002`/`009`/`015`/`016` drafts; open ADRs for plugin SDK, policy engine, and monorepo flatten.
