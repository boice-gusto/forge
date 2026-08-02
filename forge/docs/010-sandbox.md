# 010 — Sandbox

**Status:** Handbook (normative)  
**Date:** 2026-08-02  
**Related ADRs:** [003-sandbox](./adrs/003-sandbox.md)  
**Principles:** Adapters at every boundary. · Policies before permissions. · Disposable sandboxes.

---

## 1. Purpose

The Forge **sandbox layer** provides disposable, policy-bound compute for agent tool execution and coding workflows. Untrusted or high-risk code runs inside a sandbox; the public surface is **`SandboxPort` only** — never Docker, Firecracker, E2B, or git APIs in company or plugin code.

Sandbox capabilities are **deterministic**: `PolicyPort` derives network, resource, and tool permissions from policy packs. Prompts cannot widen sandbox access.

---

## 2. Isolation ladder

Forge documents isolation strength so operators choose backends without changing public APIs:

```
Worktree only          → filesystem edit isolation; NOT a security boundary
Hardened Docker        → trusted / single-tenant agents; MVP default
gVisor (runsc)         → stronger shared-infra isolation; optional K8s RuntimeClass
Firecracker / Kata     → untrusted / multi-tenant gold standard; managed platform
```

| Backend | Security | Forge phase |
|---------|----------|-------------|
| Git worktree | Edit isolation only | Phase 1 (composed with Docker) |
| Hardened Docker | Shared kernel; trusted tenants | **Phase 1 MVP** |
| Testcontainers | CI harness only — not production orchestrator | Phase 1 CI |
| Managed microVM (E2B-class) | Dedicated guest kernel | Phase 2+ production |
| Self-hosted Firecracker | Maximum control; heavy ops | Defer unless BYOC/compliance requires |

**Rejected:** Worktree-only as the sole sandbox for untrusted code.

---

## 3. Public contract: `SandboxPort`

Conceptual interface — Zod-validated at every boundary in `@forge/ports`.

```ts
declare const SandboxIdBrand: unique symbol;
export type SandboxId = { readonly [SandboxIdBrand]: true };

interface SandboxPort {
  create(spec: SandboxCreateSpec): Promise<SandboxHandle>;
  exec(id: SandboxId, cmd: ExecRequest): Promise<ExecResult>;
  readFile(id: SandboxId, path: string): Promise<Uint8Array>;
  writeFile(id: SandboxId, path: string, data: Uint8Array): Promise<void>;
  snapshot?(id: SandboxId): Promise<SnapshotId>;
  destroy(id: SandboxId): Promise<void>;
}

interface SandboxCreateSpec {
  template: SandboxTemplateId;     // Forge alias — not docker:// or e2b raw id
  workspace: WorkspaceSpec;
  network: NetworkPolicy;
  resources: ResourceLimits;
  secrets: SecretRefs;             // injected by runtime — never from prompts
  capabilities: CapabilitySet;     // policy-derived
}

type WorkspaceSpec =
  | { kind: 'empty' }
  | { kind: 'git-worktree'; repo: RepoRef; ref: string; branch?: string }
  | { kind: 'copy'; sourcePath: string };   // adapter-internal use only

interface NetworkPolicy {
  default: 'deny' | 'allow';
  egressAllowlist?: string[];      // hostnames/CIDR — from policy
}

interface ResourceLimits {
  cpuMillis?: number;
  memoryMb: number;
  timeoutMs: number;
  diskMb?: number;
}
```

### Template aliases

Adapters resolve Forge-owned template ids internally:

| Alias | MVP backend | Notes |
|-------|-------------|-------|
| `forge.node-ts` | Docker image | Node 20 + git + pnpm |
| `forge.agent-coding` | Docker + worktree | Default coding-agent profile |
| `forge.mock` | In-memory FS | Unit tests |

Authors reference aliases in IR/manifests — not Docker image URIs.

---

## 4. Worktrees as workspace primitive

Git worktrees provide **parallel filesystem isolation** for coding agents — not security isolation.

```ts
workspace: {
  kind: 'git-worktree',
  repo: { url: configRef('acme.repo.main'), path: '/repos/acme' },
  ref: 'main',
  branch: 'forge/agent/run-abc123',
}
```

| Property | Behavior |
|----------|----------|
| Isolation | Separate working tree; shared `.git` object store |
| Parallelism | Multiple agents on one repo without branch thrash |
| Cleanup | Adapter removes worktree + branch on `destroy()` when policy allows |
| Limits | Shared host ports, caches, local DBs, secrets on host |

**Forge rule:** Worktrees compose **inside** Docker (or microVM) for concurrent untrusted agents. Worktree alone is acceptable only for trusted local/dev.

Adapter implementation spawns `git worktree add/remove` via controlled shell — never from plugin code or prompts.

---

## 5. Adapter matrix

| Adapter | Environment | Backend | Phase |
|---------|-------------|---------|-------|
| `sandbox-mock` | unit tests | in-memory FS + recorded exec | 0–1 |
| `sandbox-docker` | local / CI / MVP prod (trusted) | Docker Engine hardened | **1** |
| `sandbox-worktree` | local trusted | git worktree helper (composed) | 1 |
| `sandbox-e2b` (or equivalent) | staging / prod multi-tenant | Firecracker via managed API | 2+ |

Only `@forge/adapters-sandbox-*` packages import `dockerode`, `@e2b/code-interpreter`, or similar.

---

## 6. MVP: Docker + worktrees

ADR-003 locks Phase 1 default:

### Docker hardening (minimum)

- Non-root user inside container
- `--cap-drop=ALL` (plus only required caps)
- Read-only root filesystem where feasible
- **Network deny-by-default**; egress from `NetworkPolicy` / policy engine
- Resource limits from `ResourceLimits`
- TTL enforced — `destroy()` on run completion or timeout sweeper

### Composition flow

```
Workflow IR sandbox node (or agent step with requiresSandbox)
        │
        ▼
Runtime evaluates PolicyPort → CapabilitySet + NetworkPolicy
        │
        ▼
SandboxPort.create({ template: 'forge.agent-coding', workspace: git-worktree, … })
        │
        ├── Adapter creates Docker container
        └── Adapter adds git worktree inside mounted workspace
        │
        ▼
ProviderPort.startSession({ cwd: worktreePath })
        │
        ▼
Tool exec via SandboxPort.exec (policy-filtered commands)
        │
        ▼
Approval gate (if required) before merge/push/promote
        │
        ▼
SandboxPort.destroy() — default; disposable
```

---

## 7. CI: Testcontainers

[Testcontainers](https://node.testcontainers.org/) validates sandbox and infrastructure adapters in CI — **not** as the production sandbox orchestrator.

| Use case | Container |
|----------|-----------|
| Redis for BullMQ port tests | `GenericContainer` |
| Postgres for checkpoint / run store | `@testcontainers/postgresql` |
| Docker-backed sandbox contract tests | Docker-in-Docker or sibling socket |

Phase 1 quality gate: integration tests prove `sandbox-docker` adapter against real Docker Engine via Testcontainers (or CI service).

---

## 8. Production path: managed microVM

Phase 2+ adopts a **managed Firecracker-class platform** (E2B or equivalent) behind the same `SandboxPort`:

- No public API change — swap adapter at composition root
- Stronger isolation for multi-tenant / untrusted code
- Optional `snapshot()` for short HITL pauses when platform supports it
- Defer self-hosted Firecracker fleet unless BYOC/VPC compliance requires

gVisor (`runsc`) remains an optional middle tier on Kubernetes without changing Forge types.

---

## 9. Sandbox during human approval waits

Long `AWAITING_APPROVAL` periods must not hold expensive compute. See `006-runtime.md`.

| Strategy | When to use |
|----------|-------------|
| **Keep sandbox alive** | Waits under configurable threshold (~minutes) |
| **Snapshot + restore** | microVM backend with snapshot support |
| **Destroy + recreate from git** | **Default** for long waits — agent must commit to worktree branch before gate |
| **Hibernated worktree on host** | Trusted local dev only |

### Default long-wait policy

1. Before approval gate fires, agent commits/checkpoints to worktree branch.
2. Runtime destroys sandbox container (compute).
3. On resume after approval, runtime recreates sandbox from git ref — not from dirty container FS.
4. Uncommitted dirty state is **intentionally discarded** unless snapshot adapter exists.

---

## 10. Runtime orchestration

Sandbox lifecycle is owned by runtime — not plugins, not provider adapters directly.

```
PolicyPort.evaluate → capabilities + network
        │
SandboxPort.create
        │
Provider session (cwd = workspace path)
        │
Tool calls → SandboxPort.exec (after policy per command class)
        │
ObservabilityPort spans: sandbox.created, exec, destroyed
        │
SandboxPort.destroy (finally block — even on failure)
```

Provider and sandbox adapters do not import each other. Runtime passes workspace path from sandbox handle to provider session opts.

---

## 11. Policy integration

| Policy decision | Sandbox effect |
|-----------------|----------------|
| Deny `network.egress` | `NetworkPolicy.default = 'deny'`, empty allowlist |
| Allow `docs.fetch` | Egress allowlist to approved doc hosts only |
| Require sandbox for skill | Compiler/runtime refuse in-host exec |
| R&D research pack | Bind only mock/sandbox adapters — prod bindings denied |

Skills declare `optionalSandbox` or `requiresSandbox`; policies decide whether creation is allowed and with what limits.

---

## 12. Observability and audit

Every sandbox operation emits structured events:

- `sandbox.created` — template, policy id, run id, resource limits
- `sandbox.exec` — command class (not necessarily full argv in prod logs), exit code, duration
- `sandbox.destroy` — reason (completed, failed, ttl, approval-wait)
- OpenTelemetry spans linked to run and step ids

Secrets injected via `SecretRefs` are never logged or included in prompt templates.

---

## 13. What must never leak publicly

Forbidden outside adapter packages:

- `dockerode`, Docker Engine API types
- `@e2b/code-interpreter`, E2B template ids as public API
- Firecracker, Kata, gVisor configuration
- Raw `git worktree` orchestration from plugin code

Forbidden in prompts:

- "Run docker run …" as authorization mechanism
- Container capabilities or network overrides

---

## 14. Package layout

```
packages/
  ports/                    # SandboxPort + Zod schemas
  adapters/
    sandbox-mock/
    sandbox-docker/         # MVP — dockerode + worktree helper
    sandbox-e2b/            # Phase 2+ — optional
apps/
  worker/                   # binds SandboxPort via DI
tooling/
  integration/              # Testcontainers suites
```

Architecture test: `@forge/plugin-sdk` and company packages ↛ `dockerode`, `e2b`, `@forge/adapters-sandbox-*`.

---

## 15. Failure modes

| Failure | Behavior |
|---------|----------|
| `create()` timeout | Fail step; IR retry policy applies |
| `exec()` non-zero exit | Structured `ExecResult`; agent may recover or fail run |
| TTL exceeded | Sweeper calls `destroy()`; run may fail or await approval timeout |
| Orphan sandbox | Prevention: runtime `finally` + TTL sweeper; alert on leak metric |
| Worktree cleanup failure | Logged error; background janitor removes stale worktrees |

Fail closed: if policy requires sandbox and adapter unavailable, step fails — no silent in-host fallback in production.

---

## 16. Acceptance criteria

When sandbox implementation is complete for Phase 2+, **done** means:

1. **Port-only public surface** — Plugins and SDK use `SandboxPort` concepts only; architecture tests pass.
2. **Docker MVP** — `sandbox-docker` + worktree runs Acme engineering PR workflow locally with hardened defaults (non-root, cap-drop, deny network by default).
3. **Testcontainers CI** — Integration job validates sandbox adapter + Redis/Postgres ports without manual docker-compose.
4. **Disposable default** — Every completed run destroys sandbox; leak detector test fails if `destroy()` skipped.
5. **Policy network** — Egress denied when policy denies; allowlist enforced per hostname class.
6. **Long HITL** — Approval wait > threshold destroys compute; resume recreates workspace from git branch with committed state preserved.
7. **No worktree-only untrusted** — Architecture/lint docs reject configs marking untrusted workloads as worktree-only.
8. **Template aliases** — Manifests reference `forge.*` templates only; raw Docker image strings fail validation in company packages.
9. **Provider integration** — Agent session `cwd` resolves to sandbox worktree path; tool exec routes through `SandboxPort.exec`.
10. **Adapter swap path** — Contract test suite runs against `sandbox-mock` and `sandbox-docker` with identical `SandboxPort` assertions — proves microVM swap requires no manifest changes.

---

## 17. Related documents

- [006 — Runtime](./006-runtime.md) — sandbox lifecycle during runs and approval waits
- [008 — Provider SDK](./008-provider-sdk.md) — agent sessions run inside sandbox workspace
- [009 — Plugin SDK](./009-plugin-sdk.md) — skills declare sandbox requirements
- [007 — Workflow Compiler](./007-workflow-compiler.md) — `sandbox` IR nodes
