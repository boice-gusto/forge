# 014 — Security

**Status:** Handbook (normative)  
**Audience:** All engineers; security reviewers; compliance  
**Related:** [ADR-007](./adrs/007-policy.md) · [013-testing](./013-testing.md) · [011-observability](./011-observability.md) · [012-ui](./012-ui.md)  
**Research:** [014-security.research.md](./research/014-security.research.md)

---

## 1. Security identity

Forge security is defined by four constitution principles:

> **Policies before permissions.** Capabilities determine what is allowed — not prompts.  
> **Humans own the final decision.** AI recommends; humans approve.  
> **Env only for secrets. Config for everything else.**  
> **Never let prompts determine permissions. Never let LLMs bypass deterministic gates.**

Security is the **runtime control plane**: policy → capability → sandbox → human gate → audit. It is not a bolt-on scanner job.

---

## 2. Trust boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│  Operators / Admins (Forge control plane)                       │
├─────────────────────────────────────────────────────────────────┤
│  Human approvers (HITL UI/API)                                  │
├─────────────────────────────────────────────────────────────────┤
│  Forge Runtime (deterministic): compiler, policy engine,        │
│  capability broker, gate service, queue, observability sinks    │
├───────────────┬─────────────────────────┬───────────────────────┤
│ Provider      │ Plugin / Skill host     │ Sandbox executor      │
│ adapters      │ (company / third-party) │ (container / microVM) │
│ (untrusted    │ untrusted code+data     │ untrusted agent code  │
│  model I/O)   │                         │ + tools               │
└───────────────┴─────────────────────────┴───────────────────────┘
         ▲                     ▲                     ▲
         │                     │                     │
    LLM outputs          plugin outputs        guest workload
    = untrusted          = untrusted           = untrusted
```

**Invariant:** Crossing downward requires a **deterministic allow** from policy/capability broker. Model confidence is never an authorization signal.

---

## 3. Threat model (STRIDE)

### 3.1 Assets

| Asset | Examples |
|-------|----------|
| Secrets | Provider API keys, OAuth tokens, org credentials |
| Sandbox code & data | Customer repos, worktrees, PII in fixtures |
| Policy & capability registry | Tool allowlists, approval rules |
| Human gate decisions | Approvals, audit trail integrity |
| Workflow IR / prompts | Versioned assets; prompt confidentiality |
| Plugins | Supply chain + runtime behavior |
| Telemetry | OTel/LangSmith traces (may contain sensitive context) |
| Control plane APIs | Queue, admin, feature flags |

### 3.2 STRIDE matrix

| STRIDE | Agent-specific threats | Primary Forge controls |
|--------|------------------------|------------------------|
| **S**poofing | Forged approval; stolen provider identity; plugin impersonation | Signed approvals; service auth; plugin digest pin; no ambient creds in sandbox |
| **T**ampering | Prompt/IR tampering; memory poisoning; malicious tool args; compromised deps | Versioned signed assets; immutable run manifests; Zod at boundaries; CI provenance |
| **R**epudiation | Agent action without audit | Append-only audit log; trace IDs on every tool/gate; approval records with actor + scope |
| **I**nformation disclosure | Prompt injection → exfil; logs leak secrets; LangSmith over-share | Redaction; secret-env isolation; egress allowlists; trace scrubbing |
| **D**enial of service | Runaway loops; fork bombs; queue flood; Denial of Wallet | Timeouts, step budgets, rate limits, circuit breakers, cgroup limits, cost caps |
| **E**levation of privilege | Prompt claims admin; plugin escalates tools; sandbox escape; gate bypass | Policies before permissions; capability brokering outside LLM; non-bypassable gates; sandbox tiers |

### 3.3 OWASP LLM Top 10 (2025) → Forge mapping

| OWASP | Forge emphasis |
|-------|----------------|
| LLM01 Prompt Injection | All model & retrieved content untrusted; prompts never authz |
| LLM02 Sensitive Info Disclosure | Redact; sandbox env scrub; careful LangSmith |
| LLM03 Supply Chain | SBOM, pin plugins, scan images |
| LLM04 Data & Model Poisoning | Validate memory/RAG/plugin outputs before persistence |
| LLM05 Improper Output Handling | Zod-validate tool args/results |
| LLM06 Excessive Agency | Least privilege tools; HITL for high-impact |
| LLM07 System Prompt Leakage | No secrets in prompts; prompts ≠ policy |
| LLM08 Vector/Embedding Weaknesses | Defer until RAG in scope |
| LLM09 Misinformation | Humans for irreversible actions |
| LLM10 Unbounded Consumption | Budgets, rate limits, sandbox quotas |

### 3.4 Abuse cases (must be acceptance tests)

1. Prompt override cannot replace system/developer policy.
2. Unauthorized tool denied even if model “confidently” requests it.
3. Low-trust session cannot reach privileged tools/creds.
4. Memory/plugin output injection cannot expand capabilities.
5. Data exfil via tool args/logs blocked or redacted.
6. High-impact action without **valid, unexpired, parameter-bound** approval fails closed.
7. Approval for action A cannot be replayed for action B (`tool + argsHash + runId` binding).

Each case links to a test ID in [013-testing](./013-testing.md).

---

## 4. Policies before permissions

### 4.1 Authorization pipeline

Authorization is a **deterministic pre-action check** outside the model loop:

```
Model proposes tool call
        ↓
Zod-validate proposal (schema)
        ↓
Capability broker (tools available for this run)
        ↓
Policy engine (OPA Wasm): allow | deny | requires-approval
        ↓
If requires-approval → Human gate (parameter-bound)
        ↓
Sandbox executes with ephemeral credentials only
```

The hook **must be awaited in runtime** — not implemented as prompt instructions. Prompt injection may convince the model to *request* a tool; it must not execute without policy allow.

See [ADR-007](./adrs/007-policy.md).

### 4.2 OPA vs OpenFeature

| Concern | Owner | Notes |
|---------|-------|-------|
| Authz / tool allow / approval required | **OPA (Rego) via Wasm** | Rich rules; **fail closed** |
| Gradual rollout / kill switches | **OpenFeature** | Flags ≠ permissions |
| “Can tenant use provider X?” | Policy (truth) + flag (rollout) | Flag must not grant absent capability |

**Fail closed:** Policy errors → deny. Default deny for unknown tools.

**Policy input (minimum):**

```jsonc
{
  "actor": { "type": "agent_run", "runId": "...", "tenantId": "...", "userId": "..." },
  "tool": { "name": "repo.write", "argsHash": "...", "args": { /* validated */ } },
  "capabilities": ["repo.read", "repo.write.worktree"],
  "context": { "workflowId": "...", "environment": "prod", "riskClass": "high" },
  "approval": null
}
```

Model text is **not** a policy input field for allow/deny (audit-only optional).

### 4.3 Obligations → HITL

OPA returns `{ allow, obligations[] }`. Obligations drive interrupts:

- `require_human_approval` → open approval gate
- `deny` → fail closed with `forge.policy.deny` telemetry

---

## 5. Never-allow list

| Never | Enforcement |
|-------|-------------|
| Prompts determine permissions | Arch test: policy ↛ prompt renderer for authz |
| LLM bypasses deterministic gates | Gate service ignores model “approved” tokens |
| Expose LangGraph / BullMQ / Claude / ACPX publicly | Export tests + depcruise |
| Hardcode company logic in core | `examples/` and `forge.gusto/` only |
| Ambient cloud credentials in sandbox | Explicit injection; IMDS blocked |
| `allowed_commands: "*"` style tools | Schema reject; policy deny |
| Shared writable state across tenants | Isolation tests |
| Approval without parameter binding | Gate rejects unbound approvals |
| Secrets in config / prompts / traces | Gitleaks + redaction middleware |
| Privileged Docker socket in sandbox | Image/runtime policy |

---

## 6. Secret handling

### 6.1 Storage rules

| Kind | Storage |
|------|---------|
| Secrets | Environment / secret manager only |
| Config | Files / config service (no embedded creds) |
| Identity | IdP / org directory adapter |

Never commit `.env` with real secrets. Ship `.env.sample` with placeholders.

### 6.2 Runtime practices

| Practice | Detail |
|----------|--------|
| Injection | Control plane passes **ephemeral, scoped** creds to sandbox when policy allows |
| Provider keys | Host/adapter side when possible |
| Redaction | Scrub `Authorization`, `api_key`, PEM in logs/traces |
| Rotation | Document rotation; no long-lived keys in plugin manifests |
| Approval UI | Mask secrets; show action preview only |
| LangSmith | Default deny sensitive payload fields |

### 6.3 Scanning

- **Pre-commit / PR:** Gitleaks
- **CI:** fail on findings; scheduled history scan
- Secret provider port ADR for Vault/Doppler/AWS SM (deploy phase)

---

## 7. Human approval gates (security properties)

| Property | Requirement |
|----------|-------------|
| Binding | Covers exact `tool + argsHash + runId + stepId` |
| Freshness | TTL; expired approvals not reusable |
| Authority | Approver from IdP; role checked by policy |
| Preview | Sanitized action preview; no secret material |
| Non-bypass | Model cannot emit honored `approved=true` |
| Audit | Immutable: who/when/what/why |
| Dual control | Optional for finance (company policy) |

---

## 8. Sandbox isolation tiers

| Tier | Mechanism | Use when |
|------|-----------|----------|
| 0 | Process / worktree | Trusted local dev — **not** multi-tenant prod |
| 1 | Hardened Docker (seccomp, drop caps, non-root, RO rootfs) | Trusted internal automation |
| 2 | gVisor | Stronger syscall boundary |
| 3 | Firecracker / Kata microVM | Untrusted agent code, multi-tenant |

**Worktrees** isolate git state, **not** security. Do not claim worktree ≡ sandbox.

### 8.1 Escape vectors & mitigations

1. Kernel exploit → microVM / gVisor
2. Docker socket / privileged mount → **forbid**
3. Overly broad volume mounts → worktree only
4. Network lateral movement → egress allowlist; block metadata IP
5. TOCTOU approval vs execution → re-validate policy at exec time
6. Resource exhaustion → cgroups, timeouts
7. Confused deputy → sandbox gets **no** control-plane credentials

Firecracker tests are **Linux-only**; macOS CI uses Docker substitute.

---

## 9. Plugin trust boundaries

### 9.1 Trust classes

| Class | Who | Rights |
|-------|-----|--------|
| Core plugins | Forge maintainers | Host APIs via ports only |
| Company (`forge.gusto`) | Org engineers | Policy-scoped; signed |
| Third-party | External | Strictest sandbox; digest pin |

### 9.2 Boundary rules

1. Plugins declare `requiredCapabilities[]` in manifest (Zod).
2. Runtime intersects with policy-granted capabilities — never union with prompt suggestions.
3. Plugin code runs as sandbox identity, not control-plane identity.
4. Plugin outputs are **untrusted data** (indirect prompt injection).
5. No cross-plugin private imports (architecture tests).
6. Network/tool allowlists per plugin class.
7. Resource quotas per invocation.

**Reject at conformance:** broad shell tools, unvalidated URLs (SSRF), implicit credential inheritance, unbounded blocking calls.

---

## 10. Web UI security

Apply to [012-ui](./012-ui.md) surfaces:

| Header | Recommendation |
|--------|----------------|
| `Content-Security-Policy` | Strict; `default-src 'self'`; nonce scripts |
| `Strict-Transport-Security` | max-age ≥ 15552000 |
| `X-Content-Type-Options` | nosniff |
| `Referrer-Policy` | strict-origin-when-cross-origin |
| `Permissions-Policy` | disable unused sensors |
| COOP / CORP | same-origin / same-site |

Markdown/HTML from model output: **sanitize**; never raw `dangerouslySetInnerHTML`. Approval pages: CSRF + SameSite cookies.

Verification: integration tests on headers; OWASP ZAP baseline nightly (Phase 4+).

---

## 11. Supply chain

### 11.1 Tooling (locked)

| Control | Tool | Gate |
|---------|------|------|
| Secret scan | **Gitleaks** | Fail PR |
| Vuln scan | **Trivy** (fs + image) | CRITICAL/HIGH = 0 or ADR waiver |
| SBOM | **Syft** / CycloneDX npm | Every release image + artifact |
| License | Trivy license / allowlist | Fail disallowed licenses |
| SAST | Semgrep / CodeQL | High-confidence rules |
| Container lint | Hadolint | Privileged patterns fail |
| Provenance | Cosign / SLSA | Phase 7 production |

### 11.2 Plugin supply chain

- Pin by version + content digest.
- Conformance suite before enablement.
- Unsigned third-party plugins disabled in prod by default.
- pnpm `ignore-scripts` where feasible for untrusted plugins.

---

## 12. Observability security

Cross-reference [011-observability](./011-observability.md):

- OpenTelemetry required; LangSmith **adapter only**.
- Default redact PII; no raw prompts as metric labels.
- Security events: `policy.deny`, `gate.timeout`, `sandbox.kill`, `secret.redacted`.

---

## 13. Security quality gates by phase

| Phase | Security exit bar |
|-------|-------------------|
| **0** | Threat model + never-allow list published (this doc) |
| **1** | Gitleaks + license allowlist + header middleware stub |
| **2** | Trivy clean on sandbox image; policy fail-closed tests; no privileged Dockerfile |
| **3** | Prompt-injection / gate-bypass suite green; approval binding tests |
| **4** | ZAP baseline on UI; demo tenant isolation |
| **5** | Gusto policy packs; tenant data boundaries |
| **7 Production** | SBOM attested; vuln SLA; Cosign; incident runbook |

Waivers require ADR with expiry.

---

## 14. Incident response

**UNKNOWN:** Formal IR process owner. Minimum for production:

- Alert on `forge.policy.deny` spike and `sandbox.kill` rate.
- Runbook: disable company package via policy + flag; rotate secrets; preserve audit + traces.
- Abuse contact in README (Phase 7).

---

## 15. Open questions

| ID | Question | Impact |
|----|----------|--------|
| S-1 | Firecracker v1 vs Docker hardened only | Residual risk |
| S-2 | OPA WASM vs sidecar | Latency, ops |
| S-3 | Plugin signing PKI | Supply chain |
| S-4 | Multi-tenant hard isolation timeline | Packaging |
| S-5 | IdP / SSO for approvers | Gate authority |
| S-6 | LangSmith data residency | Compliance |
| S-7 | Build vs buy sandbox (E2B-like) | Ops |

---

## 16. References

- OWASP AI Agent Security Cheat Sheet
- OWASP Top 10 for LLM Applications 2025
- Firecracker design docs (jailer, seccomp)
- OPA agent tool-approval patterns
- Syft, Trivy, Gitleaks, CycloneDX documentation
