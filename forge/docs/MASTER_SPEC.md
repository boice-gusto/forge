# Forge Master Specification

**Status:** Binding for implementation agents  
**Version:** 0.1.0-phase0  
**Date:** 2026-08-02  
**Rule:** Read this document **before writing any product code**. Then open the numbered specs it indexes.

---

## 1. What Forge is

Forge is a **typed AI workflow platform**: organizations extend it with manifests and plugins; they never fork the core. Workflows are **compiled** into an internal engine. Deterministic infrastructure (policy, queues, sandboxes, approvals) surrounds intelligent steps. Humans approve; AI recommends.

**Living proof:** the same runtime executes `examples/acme/*` and `forge.gusto` domain workflows by changing packages—not by rewriting the engine.

---

## 2. Identity principles (non-negotiable)

1. **Compile. Don’t Configure.**  
2. **Deterministic Infrastructure. Intelligent Execution.**  
3. **Extension over Replacement.**  
4. **Adapters at Every Boundary.**  
5. **Prompts are Versioned Assets.**  
6. **Policies before Permissions.**  
7. **Humans own the final decision.**  
8. **Research before Implementation.**

Full normative list: [003-project-constitution.md](./003-project-constitution.md).

---

## 3. Document map (read order)

| Order | Doc | Binding content |
|------:|-----|-----------------|
| 0 | [000-overview.md](./000-overview.md) | How to navigate the handbook |
| 1 | [001-vision.md](./001-vision.md) | North star |
| 2 | [002-problem-statement.md](./002-problem-statement.md) | Why Forge exists |
| 3 | [003-project-constitution.md](./003-project-constitution.md) | Never-violate + never-build |
| 4 | [004-architecture.md](./004-architecture.md) | Hexagonal monorepo, ports, packages |
| 5 | [005-research-workflow.md](./005-research-workflow.md) | Research → ADR → … → impl |
| 6 | [006-runtime.md](./006-runtime.md) | Run lifecycle, HITL, queues |
| 7 | [007-workflow-compiler.md](./007-workflow-compiler.md) | Manifest → IR → EnginePlan |
| 8 | [008-provider-sdk.md](./008-provider-sdk.md) | ProviderPort; `@simpill/acp-llm-cli` |
| 9 | [009-plugin-sdk.md](./009-plugin-sdk.md) | Company packages & plugins |
| 10 | [010-sandbox.md](./010-sandbox.md) | SandboxPort, worktrees, Docker |
| 11 | [011-observability.md](./011-observability.md) | OTel + LangSmith adapter |
| 12 | [012-ui.md](./012-ui.md) | Operator UI standards |
| 13 | [013-testing.md](./013-testing.md) | Tests & fitness gates |
| 14 | [014-security.md](./014-security.md) | Threat model & controls |
| 15 | [015-phases.md](./015-phases.md) | Phase 0 → production |
| 16 | [016-demo-scenarios.md](./016-demo-scenarios.md) | Acme + Gusto acceptance demos |
| 17 | [017-vision-validation.md](./017-vision-validation.md) | Phase −1 traceability and flagship proof |

**ADRs:** [adrs/](./adrs/) (001 monorepo … 008 extension repository topology).  
**Research provenance:** [research/](./research/) (not binding; ADRs + numbered docs win).

---

## 4. Locked Phase 0 technology decisions

| Concern | Decision | ADR |
|---------|----------|-----|
| Monorepo | pnpm workspace; `@forge/*` + `forge.gusto` + `examples/acme` | ADR-001 |
| Engine | LangGraph.js behind `GraphEnginePort` | ADR-002 |
| Sandbox | Docker + worktrees MVP; Testcontainers CI; managed microVM later | ADR-003 |
| Queue | BullMQ behind `QueuePort` | ADR-004 |
| Provider | `ProviderPort`; mock + **`@simpill/acp-llm-cli`** ([repo](https://github.com/SkinnnyJay/acp-llm-cli)); ACPX private optional | ADR-005 |
| Observability | OpenTelemetry substrate; LangSmith optional | ADR-006 |
| Policy | OPA Wasm behind `PolicyPort`; fail closed; OpenFeature = flags only | ADR-007 |
| Validation | Zod v4 safeParse at boundaries | Constitution |
| Ops libs | Dogfood `@simpill/*` (env, logger, adapters, resilience, …) | Constitution |

**Never public:** LangGraph, BullMQ, Claude SDKs, ACPX, `@simpill/acp-llm-cli`, ACP SDK types, Dockerode/E2B clients.

---

## 5. Public vs internal packages

**Public:** `@forge/types`, `@forge/manifest`, `@forge/sdk`, `@forge/plugin-sdk`  
**Internal:** `compiler`, `runtime`, `ir`, `ports`, `adapters-*`  
**Deployables:** `apps/api`, `apps/worker`, `apps/ui`  
**Extensions:** `examples/acme`, `forge.gusto`

Fitness tests must fail if public packages depend on vendor engines.

---

## 6. Research → build pipeline

```
Research → ADR → Benchmark OSS → Decision matrix → Prototype → Tests → Implementation
```

Phase −1 validates the vision and traceability in [017](./017-vision-validation.md). Phase 0 produces research + ADRs + this handbook. **No product runtime code** until both Phase −1 and Phase 0 exit criteria pass.

---

## 7. Definition of done (platform)

A phase is done only when **Deliverables**, **Demo**, **Quality Gates**, and **Exit Criteria** all pass ([015](./015-phases.md)).  
Demos must prove principles via Acme A1–A5 and Gusto G1–G5 ([016](./016-demo-scenarios.md)).

---

## 8. Instructions to implementation agents

1. Open this file and the constitution (`003`).  
2. Implement only the active phase in `015`.  
3. Prefer surgical changes; no speculative abstractions.  
4. If a requirement conflicts with the constitution, **stop** and write/amend an ADR.  
5. Do not expose forbidden vendors in public APIs.  
6. Every significant feature starts with research notes under `docs/research/` unless an ADR already covers it.  
7. Provider work uses `@simpill/acp-llm-cli` behind adapters (git install until npm publish).  

---

## 9. Change control

- Handbook + ADRs are versioned with the repo.  
- Superseding an Accepted ADR requires a new ADR with explicit status change.  
- `docs/research/*` may lag; **numbered docs and Accepted ADRs are source of truth.**
