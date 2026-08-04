# Research Notes → `010-sandbox.md`

**Status:** Phase 0 research (not an ADR)  
**Date:** 2026-08-02  
**Scope:** Disposable sandboxes, isolation layers, and the Forge Sandbox abstraction  
**Sources:** Firecracker/E2B docs & industry guides, Testcontainers Node docs, Claude Code worktree docs, Docker/gVisor comparisons (2025–2026)

---

## Forge requirements (from constitution)

- Disposable sandboxes
- Worktrees
- Adapters at every boundary — never expose Firecracker/Docker APIs publicly
- Policies before permissions — sandbox capabilities are deterministic, not prompt-driven

---

## Technology evaluations

### 1. Firecracker microVMs

| Dimension | Finding |
|-----------|---------|
| **What it is** | AWS open-source VMM that runs lightweight KVM microVMs. Each workload gets a dedicated guest kernel. Powers AWS Lambda/Fargate; used by E2B, Vercel Sandbox, and many agent platforms. |
| **Maturity** | **Production-proven** at hyperscale (Lambda). For *agent sandboxes*, the ecosystem is mature via managed platforms; raw self-hosted Firecracker fleets remain operationally heavy. |
| **TS/Node integration** | **No first-class Node binding to Firecracker itself.** Practical path: managed SDKs that hide Firecracker (e.g. `e2b` / `@e2b/code-interpreter` TypeScript SDK). Self-hosting requires Linux + KVM, rootfs/kernel management, TAP networking — not a Node library problem. |
| **When to use** | Untrusted / multi-tenant agent code execution; production isolation where a shared-kernel escape is unacceptable. |
| **Alternatives** | Kata Containers (microVM via K8s), libkrun/microsandbox (self-hosted microVM), gVisor (weaker isolation, easier ops), hardened Docker (trusted-only). |
| **Forge recommendation** | **Adopt as production isolation *backend*, never as public API.** Prefer a managed Firecracker platform (E2B or equivalent) behind `SandboxPort` for Phase 2+. Do **not** operate raw Firecracker in MVP unless BYOC/compliance forces it. Local/dev should not require Firecracker. |

**Unknowns:** Exact Forge hosting target (AWS/GCP/on-prem); whether E2B BYOC or self-hosted microsandbox is required for Gusto-class deployments.

---

### 2. Testcontainers (local/dev/test)

| Dimension | Finding |
|-----------|---------|
| **What it is** | Library that programmatically starts throwaway Docker containers for tests/integration. Node package: `testcontainers` (+ modules like `@testcontainers/postgresql`). |
| **Maturity** | **Very mature.** Node port actively maintained (v11–v12 range as of 2026); millions of weekly npm downloads; de facto standard for Node integration tests. |
| **TS/Node integration** | **Excellent.** First-class TypeScript APIs, Vitest/Jest friendly, GenericContainer for arbitrary images, reuse mode for local speed. |
| **When to use** | Local/CI tests of Forge runtime deps (Postgres, Redis/BullMQ, mock provider sidecars) and **sandbox-adapter contract tests** against a Docker-backed `SandboxPort` implementation. |
| **Alternatives** | docker-compose in CI; Devcontainers; in-memory mocks (faster, less fidelity). |
| **Forge recommendation** | **Adopt for Phase 1 testing.** Use Testcontainers to exercise the Docker sandbox adapter and infrastructure ports. Do **not** use Testcontainers as the production sandbox orchestrator — it is a test harness, not an agent runtime. |

---

### 3. Git worktrees as isolation for coding agents

| Dimension | Finding |
|-----------|---------|
| **What it is** | Linked working directories sharing one `.git` object store. Each agent gets its own checkout + branch. Claude Code (`--worktree`, `isolation: worktree`), Cursor Parallel Agents, Codex all use this pattern. |
| **Maturity** | **Git-native and production-used** for parallel coding agents in 2025–2026. Not a security boundary. |
| **TS/Node integration** | Spawn via `git worktree add/remove` (simple-git, execa, or shell). No special SDK required. Lifecycle/cleanup is the hard part. |
| **When to use** | Parallel coding agents on the same repo; filesystem edit isolation; PR-per-agent workflows. |
| **Alternatives** | Full clones (disk-heavy); ephemeral container/VM clones (stronger isolation); remote preview envs. |
| **Forge recommendation** | **Adopt as a first-class *workspace* primitive, not a sandbox.** Compose: `WorktreePort` inside a `SandboxPort`. Document hard limits: worktrees do **not** isolate network, Docker daemon, ports, local DBs, or secrets. Hybrid pattern (worktree + container) is the production standard for >1 concurrent agent. |

**Limitations (must document in `010-sandbox`):**
- Shared host resources (ports, caches, local services)
- Cleanup of dirty worktrees / unpushed commits
- Not suitable as the sole isolation for untrusted code

---

### 4. Docker / container sandboxes

| Dimension | Finding |
|-----------|---------|
| **What it is** | Process isolation via namespaces, cgroups, seccomp. Optional hardening: non-root, `--cap-drop=ALL`, read-only rootfs, no network, AppArmor/SELinux. Optional stronger runtimes: gVisor (`runsc`), Kata. |
| **Maturity** | **Ubiquitous** tooling; **insufficient alone** for hostile multi-tenant AI code (shared kernel). Industry consensus 2026: containers for trusted/internal; microVMs for untrusted. |
| **TS/Node integration** | **Excellent** via `dockerode`, Testcontainers, Docker Engine API. Works on macOS/Windows via Docker Desktop (dev). |
| **When to use** | Local agent sandboxes; trusted internal automation; CI; first Forge sandbox adapter. |
| **Alternatives** | Firecracker/E2B (stronger), gVisor (middle), Wasm (limited Node native compatibility). |
| **Forge recommendation** | **Default sandbox adapter for local/dev/MVP.** Harden aggressively. Graduate production multi-tenant to Firecracker-backed adapter without changing public Forge APIs. Consider gVisor as optional RuntimeClass where K8s is the host. |

**Isolation ladder (for docs):**

```
Worktree only          → edit isolation, no security boundary
Hardened Docker        → trusted / single-tenant agents
gVisor                 → stronger shared-infra isolation
Firecracker / Kata     → untrusted / multi-tenant gold standard
```

---

## Sandbox abstraction design (Forge)

### Public contract (never leak backends)

```ts
// Conceptual — Zod-validated at boundaries
type SandboxId = string & { readonly __brand: 'SandboxId' }

interface SandboxPort {
  create(spec: SandboxCreateSpec): Promise<SandboxHandle>
  exec(id: SandboxId, cmd: ExecRequest): Promise<ExecResult>
  readFile(id: SandboxId, path: string): Promise<Uint8Array>
  writeFile(id: SandboxId, path: string, data: Uint8Array): Promise<void>
  snapshot?(id: SandboxId): Promise<SnapshotId>
  destroy(id: SandboxId): Promise<void>
}

interface SandboxCreateSpec {
  imageOrTemplate: string          // Forge-owned alias, not docker:// or e2b template raw
  workspace: WorkspaceSpec         // e.g. { kind: 'git-worktree', repo, ref }
  network: NetworkPolicy           // deny-all default; allowlist egress
  resources: ResourceLimits        // cpu, memory, timeout, disk
  secrets: SecretRefs              // injected by runtime, never in prompts
  capabilities: CapabilitySet      // policy-derived
}
```

### Adapter matrix

| Adapter | Env | Backend | Phase |
|---------|-----|---------|-------|
| `sandbox-docker` | local/CI | Docker Engine + optional Testcontainers for tests | 1 |
| `sandbox-worktree` | local trusted | git worktree only (compose with docker for runtime) | 1 |
| `sandbox-e2b` (or equivalent) | staging/prod | Firecracker via managed API | 2 |
| `sandbox-mock` | unit tests | in-memory FS + recorded exec | 0–1 |

### Non-negotiables

- Public packages import `SandboxPort` only — never `dockerode`, `e2b`, Firecracker APIs.
- Image/template names are Forge aliases resolved inside adapters.
- Network deny-by-default; egress from policy engine.
- TTL + hard destroy; no orphan sandboxes.
- Every sandbox creation emits OpenTelemetry spans + structured audit events.

### Recommended composition

```
Workflow node needs code execution
        ↓
Runtime asks PolicyEngine for capabilities
        ↓
SandboxFactory.create(adapterId, spec)
        ↓
Adapter provisions: [optional worktree] + [docker | microVM]
        ↓
Provider/agent runs inside workspace path
        ↓
Approval gate (if required) before promote/merge/push
        ↓
destroy() — disposable by default
```

---

## Decision summary (sandbox)

| Choice | Recommendation | Confidence |
|--------|----------------|------------|
| Public API | Forge `SandboxPort` only | High |
| Local/MVP backend | Hardened Docker (+ worktrees for coding) | High |
| Test harness | Testcontainers for adapter + infra tests | High |
| Prod untrusted backend | Firecracker via managed platform (E2B-class) | High |
| Worktrees alone as sandbox | **Reject** | High |
| Self-host Firecracker in Phase 1 | **Defer** | Medium |

---

## Open questions

1. Does Forge.gusto require BYOC / VPC-only sandboxes (rules out pure SaaS E2B)?
2. Snapshot/resume of sandboxes needed for long HITL pauses, or destroy + recreate from worktree/git?
3. GPU / browser sandboxes in scope for v1?
