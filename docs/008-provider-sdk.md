# 008 — Provider SDK

**Status:** Handbook (normative)  
**Date:** 2026-08-02  
**Related ADRs:** [005-provider](./adrs/005-provider.md)  
**Principles:** Adapters at every boundary. · Policies before permissions. · Never expose vendor types publicly.

---

## 1. Purpose

The Forge **provider layer** abstracts coding-agent and LLM execution behind `ProviderPort`. Workflows invoke agents at runtime through this port; company code, plugins, and public SDK packages never import Claude SDK, ACP protocol types, ACPX, or `@simpill/acp-llm-cli`.

Forge ships:

1. **`ProviderPort`** — typed contract + Zod event schemas (internal `@forge/ports`; concepts mirrored in handbook)
2. **`provider-mock`** — deterministic adapter for CI and demos
3. **`adapters-provider-acp`** — private adapter wrapping **`@simpill/acp-llm-cli`**
4. **Optional `adapters-provider-acpx`** — private mesh transport; never public

Provider choice is a **composition-root configuration** — swap mock ↔ live provider without workflow or manifest changes.

---

## 2. Architecture

```
┌─────────────────────────────────────────┐
│  @forge/runtime                         │
│  depends on: ProviderPort only          │
└─────────────────┬───────────────────────┘
                  │
      ┌───────────┴───────────┐
      ▼                       ▼
 adapters-provider-mock   adapters-provider-acp
 (deterministic)          (@simpill/acp-llm-cli)
      │                       │
      │                 optional future:
      │                 adapters-provider-acpx (private mesh)
      └───────────┬───────────┘
                  ▼
         Forge ProviderEvent union
    (text-delta, tool-call, tool-result,
     approval-request, error, completed)
```

**Dependency rule:** Only `@forge/adapters-provider-*` packages may import vendor/provider libraries. Architecture tests fail if `@forge/sdk`, `@forge/manifest`, or `@forge/plugin-sdk` transitively depend on them.

---

## 3. Public contract: `ProviderPort`

Conceptual interface — finalized in `@forge/ports` with Zod schemas at every boundary.

```ts
interface ProviderPort {
  startSession(opts: ProviderSessionOpts): Promise<ProviderSessionRef>;
  prompt(session: ProviderSessionRef, msg: ProviderMessage): AsyncIterable<ProviderEvent>;
  cancel(session: ProviderSessionRef): Promise<void>;
  close(session: ProviderSessionRef): Promise<void>;
}

interface ProviderSessionOpts {
  cwd: string;                        // sandbox workspace path
  model?: string;                     // adapter config — not a core enum
  allowedTools?: string[];            // policy-filtered
  capabilities: ProviderCapabilities;
  correlationId: string;
}

interface ProviderCapabilities {
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsResume: boolean;
  requiresSandbox: boolean;
  approvalModes: Array<'none' | 'tool' | 'session-end'>;
}
```

### `ProviderEvent` union

All native stream events map into a Forge discriminated union — validated with Zod `safeParse` before runtime handles them.

```ts
type ProviderEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolId: string; args: unknown }
  | { type: 'tool-result'; toolId: string; result: unknown }
  | { type: 'approval-request'; request: ToolApprovalRequest }
  | { type: 'error'; code: string; message: string; retryable: boolean }
  | { type: 'completed'; usage?: TokenUsage };
```

| Event | Runtime action |
|-------|----------------|
| `text-delta` | Stream to observability / optional live UI |
| `tool-call` | Policy check → sandbox exec or interrupt |
| `approval-request` | Route to `ApprovalPort` — never auto-approve in prod without policy |
| `error` | Apply IR retry policy; surface structured failure |
| `completed` | Close step span; validate output schema |

### Opaque session ref

```ts
declare const ProviderSessionRefBrand: unique symbol;
export type ProviderSessionRef = { readonly [ProviderSessionRefBrand]: true };
```

Adapters construct refs; runtime passes them through without introspection.

---

## 4. Capability intersection

Three layers determine what actually runs:

```
allowed = policyGrant ∩ providerSupports ∩ workflowRequires
```

| Layer | Source |
|-------|--------|
| **Policy grant** | `PolicyPort` — authoritative |
| **Provider supports** | Adapter metadata from `ProviderRegistration` |
| **Workflow requires** | Compiled artifact `requiredCapabilities` |

Prompts never expand `allowed`. A model cannot invoke a tool the policy denied even if the CLI would permit it.

---

## 5. Primary adapter: `@simpill/acp-llm-cli`

**Decision:** ADR-005 adopts `@simpill/acp-llm-cli` as the primary private implementation of `ProviderPort`.

| Field | Value |
|-------|-------|
| Repo | [github.com/SkinnnyJay/acp-llm-cli](https://github.com/SkinnnyJay/acp-llm-cli) |
| Install (until npm publish) | `github:SkinnnyJay/acp-llm-cli#main` or workspace `file:` |
| Node | `>=20` |
| Providers | Claude (`claude-agent-acp`), Gemini, Codex, Cursor |
| Protocol | ACP over stdio via `@agentclientprotocol/sdk` (internal only) |

### Adapter responsibilities

1. **Factory bootstrap** — use `getDefaultProviderClientFactory()` or `getDefaultFactory()`; validate config with adapter-local Zod (normalize v3 peer → Forge v4 at boundary).
2. **Event mapping** — map ACP session updates → `ProviderEvent` union.
3. **Model IDs** — stay in adapter config (`ANTHROPIC_MODEL_IDS`, etc.); not Forge core enums.
4. **Auth/secrets** — `ANTHROPIC_API_KEY`, etc. via env/secret manager; never in manifests.
5. **Timeouts / cancel** — honor runtime cancellation tokens; map CLI abort to `ProviderEvent.error`.
6. **Never re-export** — `@simpill/acp-llm-cli`, `@agentclientprotocol/*` types stop at adapter package edge.

### Example adapter wiring (internal)

```ts
import {
  getDefaultProviderClientFactory,
  Provider,
  ANTHROPIC_MODEL_IDS,
} from '@simpill/acp-llm-cli';

const factory = getDefaultProviderClientFactory();
const client = factory.getClient(Provider.CLAUDE, {
  command: 'claude-agent-acp',
  args: [],
  model: ANTHROPIC_MODEL_IDS.CLAUDE_SONNET_4_6,
  cwd: sandboxWorkspacePath,
});
// Map client.port stream → ProviderEvent; wrap in ProviderPort methods
```

---

## 6. Permission handler → Forge policy

`@simpill/acp-llm-cli` exposes `IPermissionHandler` for ACP `RequestPermissionRequest` / `RequestPermissionResponse`. Forge **must** wire this to Forge policy + `ApprovalPort` — never trust CLI permission defaults alone.

```
ACP RequestPermission (tool: bash, network, …)
        │
        ▼
ForgePermissionBridge implements IPermissionHandler
        │
        ├── PolicyPort.evaluate(action, resource, actor, context)
        │       → Allow | Deny | RequireApproval
        │
        └── If RequireApproval → ApprovalPort.request(...)
                → human decision → RequestPermissionResponse
```

| Rule | Normative |
|------|-----------|
| Auto-allow | Only when policy explicitly allows tool + risk class |
| Auto-deny | Fail closed when policy denies or context missing |
| Require approval | Create Forge approval record; do not block worker — see `006` |
| Audit | Log policy id, tool name, decision source (policy vs human) |

Tool allowlist interrupts (low-risk auto, high-risk gate) are configured in policy packs — not in prompt text.

---

## 7. Mock provider

`adapters-provider-mock` is **required** for CI and demos.

| Behavior | Purpose |
|----------|---------|
| Deterministic text/tool sequences | Golden workflow tests |
| Configurable latency/errors | Retry policy tests |
| No network / no API keys | CI parity |
| Same `ProviderPort` surface | DI swap with live adapter |

Acceptance demo: run identical compiled workflow with mock and live provider; only composition-root config changes.

---

## 8. ACPX — optional, private, never public

| Term | Meaning |
|------|---------|
| **ACP** | Agent Client Protocol — JSON-RPC over stdio between orchestrator and agent |
| **ACPX** | Headless CLI client ([openclaw/acpx](https://github.com/openclaw/acpx)) — "curl for agent sessions" |
| **acp-llm-cli** | Typed harness for provider CLIs — **Forge primary path** |

ACPX may exist in a future **`adapters-provider-acpx`** for multi-agent mesh (`acpx claude exec …`). Constraints:

- **Never** re-export from `@forge/sdk` or `@forge/plugin-sdk`
- **Never** document ACPX argv in public handbook APIs
- Pin versions; treat ACP v2 wire format as potentially unstable
- Prefer `@simpill/acp-llm-cli` for typed factory + Zod validation

---

## 9. Runtime integration

Agent IR nodes (`007`) invoke provider at runtime:

1. Runtime creates sandbox workspace (`010`) when `requiresSandbox`.
2. `ProviderPort.startSession({ cwd, capabilities, … })`.
3. Stream `prompt()` events → observability; tool calls → sandbox exec after policy.
4. On session end or step boundary → validate output against compiled schema.
5. `ProviderPort.close()` in `finally`; sandbox destroy per sandbox policy.

Provider and sandbox adapters are orchestrated by runtime; neither imports the other's vendor SDK.

---

## 10. Multi-provider considerations

Phase 1 targets **one provider per agent step**. Future workflows may chain providers (plan → implement) via separate IR agent nodes or optional ACP mesh — still behind ports.

| Scenario | Approach |
|----------|----------|
| Demo provider swap | DI config at worker boot |
| Per-workflow provider | Manifest metadata → compile into IR agent node config |
| Multi-CLI in one step | Defer; optional ACPX mesh adapter |

Model IDs and CLI commands remain adapter configuration — not manifest-required enums.

---

## 11. What must never leak publicly

Forbidden in `@forge/sdk`, `@forge/manifest`, `@forge/plugin-sdk`, company packages:

- `@anthropic-ai/claude-agent-sdk` types
- `@agentclientprotocol/sdk` types
- `@simpill/acp-llm-cli` imports
- `acpx` CLI surface
- Claude tool names as required core vocabulary
- LangChain message classes

Allowed public concepts:

- `ProviderEvent` shapes (Forge-owned)
- `ProviderCapabilities` metadata
- Structured errors with stable codes
- Session correlation ids for run inspector

---

## 12. Package layout

```
packages/
  ports/                      # ProviderPort interface + Zod schemas
  adapters/
    provider-mock/            # deterministic ProviderPort
    provider-acp/             # @simpill/acp-llm-cli implementation
    provider-acpx/            # optional; private mesh
apps/
  worker/                     # binds provider via DI
  api/                        # no direct provider calls in happy path
```

Install note until `@simpill/acp-llm-cli` publishes to npm:

```json
{
  "dependencies": {
    "@simpill/acp-llm-cli": "github:SkinnnyJay/acp-llm-cli#main"
  }
}
```

---

## 13. Acceptance criteria

When provider implementation is complete for Phase 2+, **done** means:

1. **Port-only consumption** — `@forge/runtime` imports `ProviderPort` only; architecture tests pass.
2. **Mock provider CI** — All workflow integration tests run on `provider-mock` without API keys.
3. **Live adapter swap** — Same sealed artifact runs with mock and `@simpill/acp-llm-cli` by changing worker config only.
4. **Event mapping** — ACP stream fixtures produce valid `ProviderEvent` Zod parses; unknown events fail closed.
5. **Permission bridge** — `IPermissionHandler` denies when policy denies; never auto-allows `bash`/network without explicit policy; approval path creates Forge approval record.
6. **No public leak** — dependency-cruiser fails if `@forge/sdk` or `@forge/plugin-sdk` depends on `@simpill/*`, `@agentclientprotocol/*`, `@anthropic-ai/*`, or `acpx`.
7. **Resume after HITL** — Workflow with approval gate resumes after human decision without provider-specific resume APIs in core.
8. **Cancel** — `ProviderPort.cancel` aborts in-flight CLI session; worker shutdown does not orphan zombie processes (integration test).
9. **Secrets** — Architecture test fails if manifests or plugin code contain API key patterns.
10. **Zod boundary** — All provider events `safeParse` at adapter egress; malformed native events become structured `error` events.

---

## 14. Related documents

- [006 — Runtime](./006-runtime.md) — orchestrates provider during agent IR nodes
- [010 — Sandbox](./010-sandbox.md) — workspace `cwd` for provider sessions
- [007 — Workflow Compiler](./007-workflow-compiler.md) — agent nodes compiled from manifests
- [PACKAGE-EVIDENCE](./research/PACKAGE-EVIDENCE.md) — version and adopt decisions
