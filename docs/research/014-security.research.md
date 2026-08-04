# Research Notes → `014-security.md`

**Status:** Phase 0 research (pre-implementation)  
**Audience:** Spec authors / principal engineers  
**Sources:** Forge `RAW.md` constitution; OWASP AI Agent Security Cheat Sheet; OWASP Top 10 for LLM Apps 2025; Firecracker/gVisor sandbox literature; OPA / OpenFeature agent policy patterns; industry DevSecOps tooling (Syft, Trivy, Gitleaks)  
**Last updated:** 2026-08-02  
**Companion:** `013-testing.research.md` (security regressions as tests), `006` threat-model doc if split

---

## 1. Purpose & Spec Contract

`014-security.md` must make Forge’s security identity **normative and testable**:

> **Policies before permissions.** Capabilities determine what is allowed — not prompts.  
> **Humans own the final decision.** AI recommends; humans approve.  
> **Env only for secrets. Config for everything else.**  
> **Never let prompts determine permissions. Never let LLMs bypass deterministic gates.**

Security is not a bolt-on scanner job. It is the runtime control plane: policy → capability → sandbox → human gate → audit.

**Done for the spec** means: threat model, control catalog, never-allow list, secret/supply-chain/web controls, sandbox & plugin trust boundaries, phase gates, and open ADRs.

---

## 2. Trust Boundaries (draw these in the spec)

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

## 3. Threat Model Outline (STRIDE-ish × Agent Assets)

Map classical STRIDE to agent-platform assets. Align with OWASP LLM Top 10 2025 and OWASP AI Agent Security Cheat Sheet.

### 3.1 Assets

| Asset | Examples |
|---|---|
| Secrets | Provider API keys, OAuth tokens, org credentials |
| Code & data in sandboxes | Customer repos, worktrees, PII in fixtures |
| Policy & capability registry | Who can run which tool |
| Human gate decisions | Approvals, audit trail integrity |
| Workflow IR / prompts | Versioned assets; prompt confidentiality |
| Plugins | Supply chain + runtime behavior |
| Telemetry | OTel/LangSmith traces (may contain sensitive context) |
| Control plane APIs | Queue, admin, feature flags |

### 3.2 STRIDE matrix (outline for full threat model)

| STRIDE | Agent-specific threats | Primary Forge controls |
|---|---|---|
| **S**poofing | Forged approval; stolen provider identity; plugin impersonation | Signed approvals; mTLS/service auth; plugin identity + digest pin; no ambient creds in sandbox |
| **T**ampering | Prompt/IR tampering; memory poisoning; malicious tool args; SBOM/bites of deps | Versioned signed assets; immutable run manifests; Zod at boundaries; checksummed memory if persisted; CI provenance |
| **R**epudiation | Agent “did something” without audit | Append-only audit log; OTel trace IDs on every tool/gate; approval records with actor + scope |
| **I**nformation disclosure | Prompt injection → exfil; logs leak secrets; LangSmith over-share; side-channel via tools | Redaction; secret-env isolation; egress allowlists; trace scrubbing; least-context prompts |
| **D**enial of service | Runaway loops; fork bombs; queue flood; **Denial of Wallet** (token spend) | Timeouts, step budgets, rate limits, circuit breakers, cgroup limits, cost caps |
| **E**levation of privilege | Prompt claims admin; plugin escalates tools; sandbox escape; gate bypass | Policies before permissions; capability brokering outside LLM; non-bypassable gates; strong sandbox |

### 3.3 OWASP LLM Top 10 → Forge mapping (must cite in spec)

| OWASP 2025 | Forge emphasis |
|---|---|
| LLM01 Prompt Injection | Treat all model & retrieved content as untrusted; never use prompts as authz |
| LLM02 Sensitive Info Disclosure | Redact; sandbox env scrub; careful LangSmith |
| LLM03 Supply Chain | SBOM, pin plugins, scan images |
| LLM04 Data & Model Poisoning | Validate memory/RAG/plugin outputs before persistence |
| LLM05 Improper Output Handling | Zod-validate tool args/results; encode for sinks |
| LLM06 Excessive Agency | Least privilege tools; HITL for high-impact |
| LLM07 System Prompt Leakage | Don’t put secrets in prompts; prompts ≠ policy |
| LLM08 Vector/Embedding Weaknesses | If RAG added later — isolate corpora **UNKNOWN:** v1 scope |
| LLM09 Misinformation | Judges/evaluators optional; humans for irreversible |
| LLM10 Unbounded Consumption | Budgets, rate limits, sandbox quotas |

### 3.4 Abuse cases that must appear as acceptance tests

From OWASP agent guidance + Forge constitution:

1. Prompt override cannot replace system/developer policy.  
2. Unauthorized tool denied even if model “confidently” requests it.  
3. Low-trust session cannot reach privileged tools/creds.  
4. Memory/plugin output injection cannot expand capabilities.  
5. Data exfil via tool args/logs blocked or redacted.  
6. High-impact action without **valid, unexpired, parameter-bound** approval fails closed.  
7. Approval for action A cannot be replayed for action B (bind hash of tool+args+runId).  

---

## 4. Policies Before Permissions (normative design)

### 4.1 Principle

Authorization is a **deterministic pre-action check** outside the model loop:

```
Model proposes tool call
        ↓
Zod-validate proposal (schema)
        ↓
Capability broker (what tools exist for this run)
        ↓
Policy engine (OPA candidate): allow | deny | requires-approval
        ↓
If requires-approval → Human gate (parameter-bound)
        ↓
Sandbox executes with issued ephemeral credentials only
```

Research note: academic/industry “pre-action authorization” (e.g. Open Agent Passport-style hooks) and OPA middleware patterns agree: **the hook must be awaited in the runtime**, not implemented as prompt instructions. Prompt injection may convince the model to *request* a tool; it must not execute without policy allow.

### 4.2 OPA vs OpenFeature (decision framing)

| Concern | Prefer | Notes |
|---|---|---|
| Authz / tool allow / approval required | **OPA (Rego) or equivalent policy-as-code** | Rich rules over structured input; fail closed |
| Gradual rollout / experiments / kill switches | **OpenFeature** | Feature flags ≠ permissions |
| “Can this tenant use provider X?” | Policy (source of truth) + flag for rollout | Flag must not grant capability absent in policy |

**Normative:** OpenFeature may *hide* a capability from product UX but **must not** be the only enforcement. Policy engine is authoritative for security decisions.

**Fail closed:** OPA/policy errors → deny. Default deny for unknown tools.

**UNKNOWN:** In-process OPA WASM vs sidecar; latency budgets — measure in Phase 2 perf gates.

### 4.3 Policy input (minimum)

```jsonc
{
  "actor": { "type": "agent_run", "runId": "...", "tenantId": "...", "userId": "..." },
  "tool": { "name": "repo.write", "argsHash": "...", "args": { /* validated */ } },
  "capabilities": ["repo.read", "repo.write.worktree"],
  "context": { "workflowId": "...", "environment": "prod", "riskClass": "high" },
  "approval": null  // or { "id": "...", "scopeHash": "...", "expiresAt": "..." }
}
```

Model text is **not** a policy input field for allow/deny (optional audit-only).

---

## 5. Never-Allow List (constitution → enforceable controls)

These belong in Project Constitution **and** automated tests (013).

| Never | Enforcement |
|---|---|
| Prompts determine permissions | Policy/capability packages have no import from prompt renderer for authz decisions; arch test |
| LLM bypasses deterministic gates | Gate service ignores model tokens; only signed approval API advances state |
| Expose LangGraph / BullMQ / Claude / ACPX APIs publicly | Package export tests + depcruise |
| Hardcode company logic in core | examples/company packages only |
| Ambient cloud credentials in sandbox | Explicit injection allowlist; IMDS blocked |
| `allowed_commands: "*"` style tools | Schema reject; policy deny |
| Shared writable state across tenants | Sandbox + storage isolation tests |
| Approval without parameter binding | Gate rejects unbound approvals |
| Secrets in config files / prompts / traces | Secret scan + redaction middleware |
| Privileged Docker socket in sandbox | Image/runtime policy |

---

## 6. Secret Handling

### 6.1 Normative rules (from RAW)

- **Secrets:** environment / secret manager only.  
- **Config:** non-secret settings (feature flags, timeouts, URLs without embedded creds).  
- **Never** commit `.env` with real secrets; provide `.env.example` with placeholders.

### 6.2 Runtime practices

| Practice | Detail |
|---|---|
| Injection | Control plane reads secrets; passes **ephemeral, scoped** creds into sandbox only when policy allows |
| Provider keys | Stay on host/adapter side when possible; sandbox gets short-lived tokens |
| Redaction | Structured logs + OTel attributes scrub `Authorization`, `api_key`, PEM, etc. |
| Rotation | Document key rotation; no long-lived keys in plugin manifests |
| Human gate UI | Never display full secrets; show masked + action preview |
| LangSmith adapter | Default deny payload fields classified sensitive; opt-in allowlist |

### 6.3 Scanning

- **Pre-commit / PR:** Gitleaks (or TruffleHog).  
- **CI:** fail on findings; history scan on schedule.  
- **UNKNOWN:** Whether Forge adopts Doppler/Vault/AWS SM — pick in deploy ADR; interface via secret provider port.

---

## 7. Supply Chain: SBOM, License, Vuln, Provenance

### 7.1 Recommended tooling

| Control | Tooling candidates | Gate |
|---|---|---|
| SBOM | **Syft** and/or **CycloneDX npm** | Generate on every release image + publish artifact |
| Vuln scan | **Trivy** (fs + image), optional OSV-Scanner | Fail CRITICAL/HIGH unless ADR waiver |
| License | Trivy license / license-checker + **allowlist policy** | Fail GPL/AGPL into proprietary distribute paths if org requires |
| Secret scan | **Gitleaks** | Fail PR |
| SAST | **Semgrep** and/or **CodeQL** | Fail high-confidence rules |
| Container lint | **Hadolint** | Warn/fail on privileged patterns |
| Provenance (later) | Cosign / SLSA | Phase 5 production |

### 7.2 Plugin supply chain

- Plugins pinned by **version + content digest**.  
- Signature verification **UNKNOWN:** required in v1? Recommend yes for third-party; company plugins may use internal registry trust.  
- Conformance suite must run before enablement (013).  
- Disable unsigned plugins in prod by default.

### 7.3 Dependency policy

- pnpm overrides for emergency patches.  
- Renovate/Dependabot with grouped AI SDK updates.  
- Ban install scripts for untrusted plugins (`ignore-scripts` where feasible).

---

## 8. Web UI Controls: CSP & Security Headers

Apply to Forge control plane UI and approval surfaces.

### 8.1 Baseline headers

| Header | Recommendation |
|---|---|
| `Content-Security-Policy` | Strict; default-src 'self'; script-src nonce/hash; object-src 'none'; base-uri 'self'; frame-ancestors 'none' (or tight); connect-src allow API + OTel only |
| `Strict-Transport-Security` | max-age ≥ 15552000; includeSubDomains |
| `X-Content-Type-Options` | nosniff |
| `Referrer-Policy` | no-referrer or strict-origin-when-cross-origin |
| `Permissions-Policy` | disable unused sensors/camera/mic |
| `Cross-Origin-Opener-Policy` | same-origin |
| `Cross-Origin-Resource-Policy` | same-site |

### 8.2 CSP notes for AI UIs

- Avoid `unsafe-inline` without nonces.  
- If using AI Elements / markdown rendering: **sanitize HTML**; never `dangerouslySetInnerHTML` with model output.  
- Approval pages: CSRF tokens / SameSite cookies; step-up auth for high-risk approvals **UNKNOWN:** SSO provider.

### 8.3 Verification

- Integration assert headers on responses.  
- Optional OWASP ZAP baseline in nightly (013/014 gate).

---

## 9. Sandbox Escape Considerations

### 9.1 Isolation tiers

| Tier | Mechanism | Use when |
|---|---|---|
| 0 | Process-only / worktree | Trusted local dev only — **not** multi-tenant prod |
| 1 | Hardened Docker (seccomp, AppArmor/SELinux, drop caps, non-root, read-only root) | Trusted internal automation |
| 2 | gVisor / user-space kernel | Stronger than runc; syscall filter tradeoffs |
| 3 | **Firecracker / Kata microVM** | Untrusted agent code, multi-tenant |

Industry consensus for AI agent code execution (2025–2026): **shared-kernel containers are insufficient for hostile/untrusted code**; microVMs are preferred for production multi-tenant.

### 9.2 Escape / breakout vectors to document

1. Kernel exploit from guest → host (mitigate: microVM / gVisor).  
2. Docker socket / privileged mode mount (forbid).  
3. HostPath / overly broad volume mounts (mount only worktree).  
4. Network lateral movement (egress allowlist; no cluster metadata).  
5. TOCTOU on approval vs execution (re-validate policy at exec time).  
6. Side-channel via shared caches (per-run ephemeral FS).  
7. Time/resource exhaustion (cgroups, timeouts).  
8. Confused deputy: sandbox calls Forge admin API with host identity (sandbox gets **no** control-plane credentials).

### 9.3 Firecracker operational notes (for ADR)

- Use **jailer**, seccomp, cgroups; treat guest as malicious.  
- Linux/KVM required — not on macOS CI.  
- Snapshot/warm pools for latency (E2B-style) — **UNKNOWN:** build vs buy sandbox mesh.

### 9.4 Worktrees

- Useful isolation for **git state**, not a security boundary.  
- Spec must not claim worktree ≡ sandbox.

---

## 10. Plugin Trust Boundaries

### 10.1 Trust classes

| Class | Who | Rights |
|---|---|---|
| Core plugins | Forge maintainers | Broader host APIs still via ports |
| Company plugins (`forge.gusto`) | Org engineers | Org registry; signed; policy-scoped |
| Third-party | External | Strictest sandbox; explicit capability grant; digest pin |

### 10.2 Boundary rules

1. Plugins declare **requested capabilities** in manifest (Zod).  
2. Runtime intersects with **granted capabilities** from policy — never union with prompt suggestions.  
3. Plugin code runs with sandbox identity, not control-plane identity.  
4. Plugin outputs feeding other plugins/tools are **untrusted data** (indirect prompt injection). Sanitize/summarize before re-entry to model context.  
5. No cross-plugin private imports (architecture tests).  
6. Network/tool allowlists per plugin class.  
7. Resource quotas per plugin invocation.

### 10.3 Insecure plugin design (OWASP LLM07)

Reject at conformance:

- Broad shell tools  
- Unvalidated URLs (SSRF)  
- Implicit credential inheritance  
- Sync blocking without timeout  

---

## 11. Human Approval Gates (security properties)

| Property | Requirement |
|---|---|
| Binding | Approval covers exact `tool + argsHash + runId + stepId` |
| Freshness | TTL; expired ≠ reusable |
| Authority | Approver identity from IdP; role checked by policy |
| Preview | Human sees sanitized action preview (no secret material) |
| Non-bypass | Model/provider cannot emit “approved=true” that runtime honors |
| Audit | Immutable record: who/when/what/why |
| Dual control | Optional for critical classes (finance) — company policy |

OWASP agent cheat sheet: high-impact actions need independent validation; risk-score manipulation must not lower thresholds without policy change.

---

## 12. Observability Security

- OpenTelemetry is required; **LangSmith only through adapters**.  
- Trace/log PII policy: default redact; sampling rules for prod.  
- Metrics without high-cardinality secrets (no raw prompts as metric labels).  
- Security events as first-class: `policy.deny`, `gate.timeout`, `sandbox.kill`, `secret.redacted`.

---

## 13. Security Quality Gates (tie to phases)

Mirror RAW four gates; specialize security scan:

| Phase | Security exit bar |
|---|---|
| 0 | Threat model draft + never-allow list published |
| 1 | Gitleaks + license allowlist + header middleware stub |
| 2 | Trivy clean on sandbox image; policy fail-closed tests; no privileged Dockerfile |
| 3 | Automated prompt-injection / gate-bypass suite green; approval binding tests |
| 4 | ZAP baseline on UI; demo tenants isolated |
| 5 | SBOM attested; vuln SLA; optional Cosign; incident runbook |

Waivers require ADR with expiry.

---

## 14. Spec Outline Recommendation for `014-security.md`

1. Security principles (constitution extract)  
2. Trust boundaries & diagrams  
3. Threat model (STRIDE × assets) + OWASP LLM mapping  
4. Policies before permissions (OPA/OpenFeature roles)  
5. Capability model & never-allow list  
6. Secret handling  
7. Human gates security properties  
8. Sandbox isolation tiers & escape mitigations  
9. Plugin trust model  
10. Web headers & CSP  
11. Supply chain (SBOM, license, vuln, secret scan)  
12. Observability & data handling  
13. Secure SDLC / phase gates  
14. Incident response & abuse contact (**UNKNOWN:** process)  
15. ADRs required  

---

## 15. Open Questions

| ID | Question | Impact |
|---|---|---|
| S-1 | Firecracker in v1 vs Docker hardened only? | Threat model residual risk |
| S-2 | OPA WASM vs sidecar; Rego ownership | Latency, ops |
| S-3 | OpenFeature provider choice | Flag/authz confusion risk |
| S-4 | Multi-tenant hard isolation timeline | Product packaging |
| S-5 | Plugin signing PKI | Supply chain |
| S-6 | IdP / SSO for approvers | Gate authority |
| S-7 | LangSmith data residency / what is sent | Compliance |
| S-8 | RAG in scope? | Extra LLM08 controls |
| S-9 | Build vs buy sandbox (E2B-like) | Ops burden |
| S-10 | Formal threat model tool (STRIDE sheets vs continuous) | Doc vs living process |

---

## 16. Recommendations (principal summary)

1. **Encode “Policies before permissions” as a runtime hook**, not prompt text — OPA (or equivalent) fail-closed before every tool dispatch.  
2. **OpenFeature for rollout only**; never as sole authz.  
3. **Parameter-bound human approvals** with TTL; model cannot forge gate state.  
4. **Sandbox tiering:** worktree ≠ security; Docker for trusted/dev; plan microVM for untrusted/multi-tenant.  
5. **Treat provider/plugin/sandbox I/O as hostile** (indirect prompt injection).  
6. **Ship DevSecOps gates early:** Gitleaks + Trivy + SBOM + license allowlist from Phase 1–2.  
7. **Strict CSP + no raw model HTML** on approval UI.  
8. **Architecture tests** are security controls — forbid leaking LangGraph/BullMQ/Claude and forbid prompt→permission coupling.  
9. Publish the never-allow list in constitution; link each item to a test ID in `013-testing.md`.

---

## 17. Key References (for spec bibliography)

- OWASP AI Agent Security Cheat Sheet  
- OWASP Top 10 for LLM Applications 2025  
- Firecracker design docs (jailer, seccomp, threat model)  
- Vitest/Turborepo testing notes → see `013-testing.research.md`  
- OPA agent tool-approval patterns / pre-action authorization literature  
- Syft, Trivy, Gitleaks, CycloneDX ecosystem docs  
