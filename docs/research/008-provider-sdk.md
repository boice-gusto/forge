# Research Notes → `008-provider-sdk.md`

**Status:** Phase 0 research (not an ADR)  
**Date:** 2026-08-02  
**Scope:** Provider adapters, ACP/ACPX, SimPill, Claude CLI patterns, public Provider SDK design  
**Sources:** Agent Client Protocol (Zed/JetBrains), openclaw/acpx, @agentclientprotocol/*, Claude Agent SDK TS docs, @simpill npm scope (best-effort)

---

## Forge requirements (from constitution)

- Adapters at every boundary
- Never expose Claude-specific APIs publicly
- Never expose ACPX
- Never expose provider-specific models as core types
- Typed provider interfaces
- Demo: switch Claude CLI ↔ mock provider; resume a workflow

---

## Technology evaluations

### 5. ACPX (Agent Client Protocol client tooling)

| Dimension | Finding |
|-----------|---------|
| **What it is** | `acpx` ([openclaw/acpx](https://github.com/openclaw/acpx)) is a **headless CLI client** for the **Agent Client Protocol (ACP)**. ACP (Zed Industries; JetBrains co-maintainer) is JSON-RPC 2.0 over stdio between editors/orchestrators and coding agents. ACPX is “curl for agent sessions” — structured events instead of PTY scraping. |
| **Related stack** | Protocol: [agentclientprotocol.com](https://agentclientprotocol.com); TS SDK: `@agentclientprotocol/sdk`; Claude adapter: `@agentclientprotocol/claude-agent-acp`; Codex/Gemini/Cursor/Copilot adapters also exist. |
| **Maturity** | **ACP:** early but real (launched ~Aug 2025; JetBrains joined; npm SDK ~5M weekly downloads reported 2026 — verify before citing in marketing). **ACPX:** useful community CLI (MIT); not Anthropic-official. Anthropic has **not** shipped native Claude Code ACP (community reports NOT_PLANNED on feature request). Claude works via adapter wrapping Agent SDK / CLI. **ACP v2 is draft** — wire format may break. |
| **TS/Node integration** | Strong via `@agentclientprotocol/sdk`. ACPX itself is a CLI/orchestrator surface; Forge would typically speak ACP via the SDK or spawn `acpx` as a subprocess inside a **private** adapter. |
| **When to use** | Multi-agent / multi-CLI orchestration with structured tool-call events; editor-agnostic coding agent sessions; avoiding brittle terminal scraping. |
| **Alternatives** | Direct Claude Agent SDK; Vercel AI SDK providers; custom stdio JSON protocol; MCP (tools/data, not editor↔agent session protocol). |
| **Forge recommendation** | **Research/adopt ACP as an *optional transport* inside a private adapter — never public.** Prefer Forge `ProviderPort` events. Use ACPX or `@agentclientprotocol/sdk` only behind `provider-acp` / `provider-claude-acp` packages. Pin adapter versions; treat ACP v2 as unstable. Constitution rule stands: **never expose ACPX**. |

**Clarification for docs:**  
- **ACP** = protocol  
- **ACPX** = one headless client implementation  
- **claude-agent-acp** = Claude↔ACP bridge  

Do not conflate ACP with Anthropic’s Messages API or MCP.

---

### 6. SimPill — RESOLVED (2026-08-02)

| Dimension | Finding |
|-----------|---------|
| **What it is** | **`@simpill/*` TypeScript utility monorepo** ([SkinnnyJay/simpill-utils](https://github.com/SkinnnyJay/simpill-utils)) plus first-class ACP harness **`@simpill/acp-llm-cli`** ([SkinnnyJay/acp-llm-cli](https://github.com/SkinnnyJay/acp-llm-cli)). **User-confirmed** as the Forge ACP provider library. |
| **What it is NOT** | Unrelated: mHealth **SIMpill**; Collinear **SimLab**. |
| **Maturity** | First-party toolkit for this org. Local package `0.1.2`; **npm registry 404 as of 2026-08-02** — install via git/file until publish. Deep-read complete → `PACKAGE-EVIDENCE.md`, ADR-005. |
| **TS/Node integration** | Native TypeScript packages; ACP CLI harness is the relevant piece if intentional. |
| **When to use** | Only if Forge intentionally depends on `@simpill/acp-llm-cli` or shared utils; otherwise treat as optional inspiration, not core infrastructure. |
| **Alternatives** | ACPX + official `@agentclientprotocol/sdk`; Claude Agent SDK directly; Forge-owned ACP client. |
| **Forge recommendation** | **ADOPT `@simpill/acp-llm-cli` behind `ProviderPort`** (ADR-005). Dogfood other `@simpill/*` ops packages. Never re-export from public SDK. ACPX remains optional private mesh only. |

**RESOLVED referent:** `@simpill/acp-llm-cli` + simpill-utils. Historical candidates (superseded):

1. `@simpill/acp-llm-cli` + util packages (ACP-adjacent, name match)  
2. Typo/confusion with **SimLab** (Collinear agent simulation)  
3. Internal/private codename not published  

Mark any SimPill ADR as **blocked on clarification**.

---

### 7. Claude Code CLI / provider CLI adapters pattern

| Dimension | Finding |
|-----------|---------|
| **What it is** | Pattern: wrap a coding-agent CLI (or its SDK) behind a stable interface. Official path: **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — programmatic access to Claude Code capabilities (`query()`, sessions, tools, MCP). Bundles native CLI binary per platform. Community: CLI wrappers, ACP bridges, OpenAI-compatible proxies. |
| **Maturity** | **Official Agent SDK is the production path** (renamed from Claude Code SDK; TS + Python). CLI remains the interactive surface; SDK is the embeddable one. |
| **TS/Node integration** | **First-class.** `npm i @anthropic-ai/claude-agent-sdk`; Node 18+. Options for cwd, model, allowed tools, abort, structured output, warm startup (`startup()`). |
| **When to use** | Real coding-agent provider for Forge demos and engineering workflows; ACP bridge when editor/multi-agent protocol needed. |
| **Alternatives** | Anthropic Messages API only (no coding harness); other CLIs (Codex, Gemini CLI) via ACP; mock provider for tests. |
| **Forge recommendation** | **Ship two Phase-1 providers:** (1) `provider-mock`, (2) `provider-claude-agent` wrapping Agent SDK **or** CLI — never leak SDK types. Prefer Agent SDK over raw CLI PTY. Optional later: `provider-acp` for multi-CLI. |

#### Adapter pattern (canonical for Forge)

```
┌─────────────────────────────────────────┐
│  Workflow / Runtime (Forge core)        │
│  depends on: ProviderPort only          │
└─────────────────┬───────────────────────┘
                  │
      ┌───────────┴───────────┐
      ▼                       ▼
 provider-mock          provider-claude
 (deterministic)        (Agent SDK / CLI)
      │                       │
      │                 optional: claude-agent-acp
      │                       │
      └───────────┬───────────┘
                  ▼
         Forge domain events
    (text, tool, approval, result)
```

**Rules:**
- Map provider-native stream events → Forge `ProviderEvent` union (Zod).
- Model IDs are adapter config, not core enums (`claude-opus-*` stays in adapter package).
- Auth/secrets via env/secret manager; never in workflow manifests as plaintext.
- Timeouts, cancel, cost ceilings enforced by runtime policy around the adapter.

---

## Provider SDK design (public vs private)

### Public surface (`@forge/provider-sdk` or equivalent)

Expose only:

| Type | Purpose |
|------|---------|
| `ProviderPort` | `startSession`, `prompt`, `cancel`, `close` |
| `ProviderEvent` | Discriminated union: `text-delta`, `tool-call`, `tool-result`, `approval-request`, `error`, `completed` |
| `ProviderSessionRef` | Opaque id |
| `ProviderRegistration` | factory + metadata (name, capabilities) |
| Zod schemas | Safe parse at every boundary |

**Must not export:** Anthropic SDK types, ACP types, ACPX argv, Claude tool names as required core vocabulary, LangChain message classes.

### Private adapters (plugins)

```
packages/
  provider-sdk/          # public contracts + zod
  provider-mock/         # implements ProviderPort
  provider-claude/       # implements ProviderPort; depends on Agent SDK
  provider-acp/          # optional; spawns ACP agent via SDK/ACPX
apps/runtime/            # binds adapters via DI / registry
```

### Capability model (ties to policies)

```ts
interface ProviderCapabilities {
  supportsTools: boolean
  supportsStreaming: boolean
  supportsResume: boolean
  requiresSandbox: boolean
  approvalModes: Array<'none' | 'tool' | 'session-end'>
}
```

Policy engine decides which capabilities are *allowed*; provider reports which are *supported*; intersection is what runs.

### Demo acceptance (from RAW Phase 2)

- Run mock + Claude providers against same workflow definition  
- Switch via config/feature flag, not code change in core  
- Resume after interrupt (HITL) without provider-specific resume APIs in core  

---

## Decision summary (provider)

| Choice | Recommendation | Confidence |
|--------|----------------|------------|
| Public API | Forge `ProviderPort` + Zod events only | High |
| Claude integration | `@anthropic-ai/claude-agent-sdk` behind private adapter | High |
| Mock provider | First-class, required for CI | High |
| ACP / ACPX | Optional private transport; never public | High |
| SimPill / acp-llm-cli | **ADOPT** behind ProviderPort (ADR-005) | High (confirmed) |
| Expose Claude/ACP types in core | **Forbidden** | High |

---

## Open questions

1. ~~Confirm SimPill referent~~ → **Resolved:** `@simpill/acp-llm-cli`.  
2. Agent SDK vs Managed Agents (self-hosted sandboxes) for Gusto — different control planes.  
3. Whether Forge needs multi-provider in one workflow (Claude plan → Codex implement) via ACP in v1 or later.  
4. Publish `@simpill/acp-llm-cli` to npm vs pin git dependency in Forge CI.
