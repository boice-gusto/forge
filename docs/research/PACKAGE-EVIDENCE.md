# Package Evidence (Phase 0)

**Date:** 2026-08-02  
**Method:** `npm view` + local source deep-read for `@simpill/acp-llm-cli`  
**Policy:** Engines stay behind Forge ports; never re-export vendor types from public SDK.

---

## `@simpill/acp-llm-cli` — ADOPT (Forge provider harness)

| Field | Evidence |
|-------|----------|
| **Decision** | **ADOPT** as private implementation of Forge `ProviderPort` |
| **Repo** | https://github.com/SkinnnyJay/acp-llm-cli |
| **Local** | `/Volumes/BlackBox/GitHub/@simpill/utils/@simpill-acp-llm-cli.utils/` |
| **Version (local package.json)** | `0.1.2` |
| **npm registry** | **Not published** (404 on registry.npmjs.org as of 2026-08-02). Install via git URL, file:, or publish before CI consume. |
| **Node** | `>=20` |
| **Module** | ESM (`"type": "module"`) |
| **Key exports** | `getDefaultProviderClientFactory`, `getDefaultFactory`, `getDefaultRegistry`, `createHarness`, `Provider`, `PROVIDER_IDS`, model enums (`ANTHROPIC_MODEL_IDS`, …), `ENV_KEY`, `DEFAULT_COMMANDS`, `baseCliConfigSchema` |
| **Subpath** | `@simpill/acp-llm-cli/runtime` — harness runtime / extension API |
| **Deps** | `@agentclientprotocol/sdk@^0.12.0`, `@simpill/{async,env,patterns,errors,logger,protocols}.utils` |
| **Peers** | `zod@^3.23.8`, `eventemitter3@^5` — **Zod v3 peer while Forge targets Zod v4**; adapter must validate compatibility (`zod` v4 often dual-path) |
| **Providers** | Claude (`claude-agent-acp`), Gemini (`gemini --experimental-acp`), Codex (`codex-acp`), Cursor (`cursor-agent`) |
| **HITL hook** | `IPermissionHandler` → ACP `RequestPermissionRequest` / `RequestPermissionResponse` — wire to Forge `ApprovalPort` / policy |
| **Adapter boundary** | Only `@forge/adapters-provider-*` may import this package |
| **vs ACPX** | This package = typed direct harness. `acpx@0.13.0` = headless ACP client for mesh/`exec`. Forge prefers acp-llm-cli; ACPX optional private mesh later. |

**Source layout confirmed:** `domain/` (constants, models, Zod) → `runtime/` (factory, port, stdio, permission) → `providers/{claude,gemini,codex,cursor}/`.

---

## Other ADOPT / ADOPT-LATER packages

| Package | Version (npm 2026-08-02) | Decision | Adapter / notes |
|---------|--------------------------|----------|-----------------|
| `@langchain/langgraph` | `1.4.8` | **ADOPT** internal | `GraphEnginePort` only; checkpoint via `@langchain/langgraph-checkpoint-postgres@6.0.0` |
| `bullmq` | `6.0.5` | **ADOPT** internal | `QueuePort`; needs Redis (`ioredis@5.x`) |
| `ioredis` | `5.x` (peer/transitive) | **ADOPT** | With BullMQ |
| `ai` (Vercel AI SDK) | `7.0.48` | **ADOPT** model I/O only | Behind model port if used; **not** second workflow engine |
| `zod` | `4.4.3` | **ADOPT** | Constitution: safeParse at every boundary |
| `@opentelemetry/api` | `1.9.1` | **ADOPT** | Substrate for `ObservabilityPort` |
| `langsmith` | `0.3.x` line (viewed `1.0.4`? verify) — use current | **ADOPT optional** | Behind observability adapter; never domain imports |
| `@openfeature/server-sdk` | `1.23.0` | **ADOPT** | Rollout flags only — **not** authz |
| `@open-policy-agent/opa-wasm` | `1.10.0` | **ADOPT** | `PolicyPort` fail-closed |
| `@modelcontextprotocol/sdk` | `1.30.0` | **ADOPT-LATER** | Tool adapter; OPA wraps calls |
| `acpx` | `0.13.0` | **DEFER / optional private** | Never public; mesh only |
| `@agentclientprotocol/sdk` | `1.3.0` (registry); acp-llm-cli pins `^0.12.0` | Internal via acp-llm-cli | Do not re-export |
| `testcontainers` | `12.0.4` | **ADOPT** tests | Redis/Postgres CI |
| `vitest` | `4.1.10` | **ADOPT** | Unit/integration |
| `playwright` | `1.62.1` | **ADOPT** | Demo/UI acceptance |
| `dependency-cruiser` | `18.1.0` | **ADOPT** | Architecture fitness |
| `@simpill/adapters.utils` | `1.0.0` | **ADOPT** | Boundary helpers |
| `@simpill/zod.utils` | `1.0.0` | **ADOPT** | Safe-parse helpers |
| `@simpill/observability.utils` | `1.0.0` | **ADOPT** | Correlation / setup glue |
| `@simpill/env.utils` / `logger.utils` / `resilience.utils` / `async.utils` | `1.0.0` | **ADOPT** | Ops primitives |

---

## Install guidance for Forge (until acp-llm-cli publishes)

```json
{
  "dependencies": {
    "@simpill/acp-llm-cli": "github:SkinnnyJay/acp-llm-cli#main"
  }
}
```

Or workspace/`file:` during local monorepo development against `@simpill`.

---

## Reject / never public

Do **not** add to `@forge/sdk` or `@forge/plugin-sdk` dependency trees:

- `@langchain/langgraph`, `bullmq`, `acpx`, `@agentclientprotocol/*`, `@simpill/acp-llm-cli`, `@anthropic-ai/*`, `dockerode`, provider CLI binaries as APIs
