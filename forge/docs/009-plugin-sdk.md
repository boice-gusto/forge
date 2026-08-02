# 009 — Plugin SDK

**Status:** Handbook (normative)  
**Date:** 2026-08-02  
**Principles:** Extension over Replacement. · Compile. Don't Configure. · Policies before permissions.

---

## 1. Purpose

The Forge **Plugin SDK** (`@forge/plugin-sdk`) is the public extension surface for **company packages** — `examples/acme`, `forge.gusto`, and future `forge.<org>` repos. Companies extend Forge by shipping typed manifests, plugins, skills, policies, and prompts. They **never fork** core runtime, compiler, or engine adapters.

```
forge.gusto ──depends──► @forge/*  (public packages)
examples/acme ──depends──► @forge/*
forge core ──never depends──► company or example packages
```

---

## 2. Goals and non-goals

### Goals

- Discover, validate (Zod), register, and version company contributions
- Expose registries for workflows, skills, policies, prompts, and adapter bindings
- Enforce **capability closure** before compile — plugins cannot escalate beyond host grant
- Keep engine internals private — no LangGraph, BullMQ, Claude, ACPX, or Docker in plugin code

### Non-goals

- Exposing `GraphEnginePort`, `EnginePlan`, IR mutators, or queue internals
- Letting plugins bypass approval gates or policy checks
- Hardcoding org-specific IDs (Slack channels, Jira projects) in core — config refs only
- A "copy and fork Forge" customization model

---

## 3. Company package model

A **company package** is a versioned npm workspace member that implements the company contract:

```
forge.gusto/
  package.json                 # depends on @forge/plugin-sdk, @forge/manifest, …
  forge.company.json           # company manifest root
  domains/
    benefits/
    benops/
    usp/
    r-and-d/
  plugins/
  adapters/                    # company port implementations (Slack, Jira, …)
  policies/
  prompts/
  workflows/
  skills/
  fixtures/
  demos/
```

`examples/acme` follows the same layout with generic domains (marketing, finance, design, engineering) to prove the framework works without company-specific core code.

### Ownership matrix

| Concern | Core `forge` | `examples/acme` | `forge.gusto` |
|---------|--------------|-------------------|---------------|
| Compiler, runtime, ports | ✅ | | |
| Plugin SDK + manifest schema | ✅ | | |
| Domain workflows | | ✅ | ✅ |
| Company policies | | illustrative | ✅ production-shaped |
| Company adapters | | mock | ✅ real + mock |
| Org config (channels, repos) | **NEVER** | config refs | config refs |

---

## 4. Plugin lifecycle

```
Discover → Validate → Register → Compile → Execute
```

| Phase | Actor | Action |
|-------|-------|--------|
| **Discover** | Company loader | Read `forge.company.json`; resolve plugin package refs |
| **Validate** | Plugin SDK | Zod `safeParse` on every manifest; semver compatibility check |
| **Register** | Plugin `register(ctx)` | Contribute workflows, skills, policies, prompts, adapters |
| **Compile** | Workflow compiler | Resolve refs; capability closure; emit sealed artifact |
| **Execute** | Runtime | Load artifact; enforce policy + approvals at runtime |

Fail closed: schema violation or capability overflow aborts registration or compile with structured diagnostics — never partial registration.

---

## 5. Plugin interface

```ts
import type { PluginManifest } from '@forge/plugin-sdk';

interface ForgePlugin {
  readonly manifest: PluginManifest;
  register(ctx: PluginContext): void | Promise<void>;
}

interface PluginContext {
  readonly companyId: CompanyId;
  readonly hostCapabilities: CapabilitySet;   // granted by core — ceiling
  workflows: WorkflowRegistry;
  skills: SkillRegistry;
  policies: PolicyRegistry;
  prompts: PromptRegistry;
  adapters: AdapterRegistry;
  // NO GraphEnginePort, QueuePort, EnginePlan, LangGraph, BullMQ, Provider SDK internals
}
```

### Plugin manifest (sketch)

```ts
const manifest = {
  id: 'gusto.plugin-benefits',
  version: '0.1.0',
  requiredCapabilities: ['benefits.member.read'],
  providedCapabilities: ['benefits.advice.draft'],
  contributes: {
    workflows: ['./workflows/member-inquiry'],
    skills: ['./skills/kb-retrieve'],
    policies: ['./policies/benefits-data'],
  },
} satisfies PluginManifest;
```

---

## 6. Registries and contribution points

| Registry | Registers | Consumed by |
|----------|-----------|-------------|
| `WorkflowRegistry` | `defineWorkflow` exports | Compiler |
| `SkillRegistry` | `defineSkill` exports | Compiler + runtime tool dispatch |
| `PolicyRegistry` | `definePolicy` / policy packs | Compiler (static) + runtime (dynamic) |
| `PromptRegistry` | `definePrompt` assets | Compiler ref resolution |
| `AdapterRegistry` | Company adapter bindings | Runtime DI at company boot |

Plugins receive **registry facades** — thin typed APIs that validate on insert. They do not receive raw engine handles.

---

## 7. Capability model and closure

Skills and plugins **request** capabilities; policies **grant** them. Prompts never grant.

```ts
defineSkill({
  id: 'gusto.benefits.kb-retrieve',
  version: '1.0.0',
  input: InquirySchema,
  output: RetrievedDocsSchema,
  requiredCapabilities: ['benefits.kb.read'],
  optionalSandbox: false,
});
```

### Closure check (compile time)

Before emitting artifact:

1. Collect `requiredCapabilities` from all skills/tools in workflow closure.
2. Union plugin `requiredCapabilities` from loaded plugins.
3. Evaluate static policy packs for company + domain.
4. If any required capability is not satisfiable → `WF_CAPABILITY_UNBOUND`.

Plugins **cannot** register capabilities beyond `hostCapabilities` passed in `PluginContext`. Attempt → registration error.

### Runtime enforcement

Even after compile, `PolicyPort.evaluate` runs before each gated step with live actor context. Static closure is necessary but not sufficient for dynamic deny/require-approval.

---

## 8. Typed artifacts

Every company artifact is typed, versioned, and validated:

| Artifact | Schema | Versioned |
|----------|--------|-----------|
| Company manifest | `CompanyManifest` | semver + content hash |
| Domain manifest | `DomainManifest` | semver |
| Workflow | `WorkflowDefinition` via `defineWorkflow` | semver |
| Skill | `SkillDefinition` via `defineSkill` | semver |
| Policy pack | `PolicyPack` | semver |
| Prompt | `PromptAsset` via `definePrompt` | semver + immutable id |
| Plugin | `PluginManifest` | semver |

No magic strings for artifact IDs — branded types and constants.

---

## 9. Company manifest hierarchy

Conceptual `forge.company.json`:

```yaml
apiVersion: forge.company/v1
kind: Company
metadata:
  id: gusto
  name: Gusto
  version: 0.1.0
spec:
  domains:
    - ref: domains/benefits
    - ref: domains/benops
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
  defaults:
    approvalRequiredFor:
      - side_effect.write
      - external.api.call
      - pii.export
```

Domain manifests add workflows, skills, and **config refs** — not hardcoded channel IDs in TypeScript.

### Config vs secrets

| Kind | Storage |
|------|---------|
| Config | company config files / config service |
| Secrets | env / secret manager only |
| Identity | IdP / org directory adapter |

Never put secrets in manifests. Never put org-specific IDs in core packages.

---

## 10. Typed workflows (plugin author view)

Workflows are declared with `defineWorkflow` — see `007`. From the plugin author perspective:

- Explicit `sideEffects[]` — compiler enforces approval gates
- `promptRefs[]` only — no inline product prompts
- `failurePolicy`, `timeouts`, `retries` as structured fields
- No hand-wired graph edges to engine primitives

```ts
// examples/acme/domains/marketing/workflows/campaign-brief.ts
export const campaignBrief = defineWorkflow({
  id: 'marketing.campaign-brief',
  version: '1.0.0',
  input: LaunchBriefInput,
  output: CampaignDraftOutput,
  sideEffects: ['external.publish'],
  steps: [
    skill('acme.extract-goals'),
    skill('acme.draft-copy', { promptRef: { id: 'acme.marketing.draft', version: '^1.0.0' } }),
    approval({ gate: 'publish', schema: PublishApprovalSchema }),
    skill('acme.slack-publish-request'),
  ],
});
```

---

## 11. Typed policies

Policy packs evaluate authorization before privileged actions:

```
Request(action, resource, actor, context)
  → PolicyEngine.evaluate(policyPacks)
  → Allow | Deny | RequireApproval(reason, approverRoles)
```

Default Gusto-shaped packs:

- `human-approval-defaults` — side effects require approval
- `pii` — classification + export controls
- `benefits-data` — member data access
- `change-management` — prod-adjacent changes
- `research-sandbox` — R&D isolation (no prod adapters)

Policies are versioned, testable, and **not** prompt-authored.

---

## 12. Forbidden APIs (engine leak list)

Architecture tests **must fail** if company or plugin code imports:

| Forbidden | Reason |
|-----------|--------|
| `@langchain/langgraph`, LangGraph types | Engine leak |
| `bullmq`, Redis queue clients | Transport leak |
| `@anthropic-ai/*`, `@simpill/acp-llm-cli` | Provider leak |
| `@agentclientprotocol/*`, `acpx` | Protocol leak |
| `dockerode`, `e2b`, Firecracker APIs | Sandbox leak |
| `@forge/runtime`, `@forge/compiler`, `@forge/ir` | Internal packages |
| `@forge/adapters-*` | Adapter packages |

### Allowed public dependencies

- `@forge/types`
- `@forge/manifest` (`defineWorkflow`, `definePrompt`, `defineSkill`, `definePolicy`)
- `@forge/plugin-sdk`
- `@forge/sdk` (for demo CLI apps — not plugins loaded into core)

`plugin-sdk` may expose port **interface types** duplicated from `@forge/types` where needed — prefer `@forge/types` only to minimize surface.

---

## 13. Versioning and compatibility

| Change | Policy |
|--------|--------|
| Plugin semver minor | Additive contributions backward compatible |
| Plugin semver major | Breaking manifest or capability contract |
| Core `@forge/manifest` major | Company packages must bump explicit compatibility range |
| Policy pack bump | Recompile artifacts; fingerprint changes |

Company loader checks:

- Plugin `peerDependencies` against host Forge version
- Conflicting workflow id registration → fail at register time
- Duplicate capability claims → diagnostic error

---

## 14. Testing plugins

| Test type | Scope |
|-----------|-------|
| **Unit** | Skill handlers, policy rules, prompt input validation |
| **Contract** | Plugin manifest Zod parse; registry insert rules |
| **Compile integration** | Workflow fixture → artifact with expected gates |
| **Architecture** | No forbidden imports; core ↛ company packages |
| **Demo acceptance** | Scenario scripts in `demos/` (see `016-demo-scenarios`) |

Example architecture test assertion:

```
forbidden: packages/** importing forge.gusto/**
forbidden: forge.gusto/** importing @langchain/langgraph
forbidden: examples/acme/** importing @forge/runtime
```

---

## 15. Reference plugins

### Acme (`examples/acme`)

Proves generic framework:

- Marketing campaign brief with publish approval (A1)
- Finance invoice anomaly with policy deny path (A2)
- Engineering PR merge gate with resume (A4)

No Gusto nouns. Mock adapters only.

### Gusto (`forge.gusto`)

Proves company customization:

- Benefits member inquiry with regulated topic escalation (G1)
- BenOps ticket triage with gated runbook steps (G2)
- R&D sandbox with prod adapter deny (G4)

Zero Gusto logic in core — import boundary tests enforce.

---

## 16. Dual-company parity

One Forge installation loads different company packages by config:

```bash
forge run --company acme --workflow marketing.campaign-brief
forge run --company gusto --workflow benops.ticket-triage
```

Same runtime binary; different manifests + plugins. Core never restarts for company logic changes beyond documented hot-load rules (Phase 2+).

---

## 17. Acceptance criteria

When Plugin SDK implementation is complete for Phase 3+, **done** means:

1. **Load Acme package** — Company loader discovers plugins, validates manifests, registers contributions without core imports from `examples/acme`.
2. **Capability closure** — Workflow requiring `finance.payment.initiate` without policy grant fails compile with `WF_CAPABILITY_UNBOUND`.
3. **No escalation** — Plugin attempting to register capability outside `hostCapabilities` fails at register time.
4. **Engine leak tests** — dependency-cruiser fails on forbidden imports in `examples/acme` and `forge.gusto`.
5. **Approval cannot bypass** — Plugin skill cannot invoke write adapter when workflow lacks approval node and policy requires it.
6. **Prompt refs only** — Architecture test fails on unversioned product prompt literals in company workflows.
7. **Dual company** — Acme marketing and Gusto BenOps workflows compile and run from one process with different `--company` flag.
8. **Core independence** — No file under core `packages/` imports `forge.gusto` or `examples/acme`.
9. **Version mismatch** — Incompatible plugin peer range produces clear loader error at boot.
10. **Demo scripts** — At least A1 and G1 acceptance demos pass in CI with mock provider.

---

## 18. Related documents

- [007 — Workflow Compiler](./007-workflow-compiler.md) — consumes registered workflows
- [006 — Runtime](./006-runtime.md) — executes compiled artifacts with policy enforcement
- [008 — Provider SDK](./008-provider-sdk.md) — plugins never touch provider adapters directly
- [010 — Sandbox](./010-sandbox.md) — skills declare sandbox need; policy decides provision
- [016 — Demo Scenarios](./016-demo-scenarios.md) — acceptance catalog (when published)
