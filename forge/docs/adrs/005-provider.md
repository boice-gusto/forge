# ADR-005: Provider SDK (`@simpill/acp-llm-cli`)

- **Status:** Accepted  
- **Date:** 2026-08-02  
- **Evidence:** `PACKAGE-EVIDENCE.md`, https://github.com/SkinnnyJay/acp-llm-cli, local submodule

## Context

RAW requires provider abstraction and SimPill/ACPX research. User confirmed ACP harness is **acp-llm-cli**.

## Decision

1. Forge `ProviderPort` is implemented by private adapters.  
2. **Primary coding-agent provider path:** `@simpill/acp-llm-cli` (git/file until npm publish) wrapping Claude/Codex/Gemini/Cursor CLIs.  
3. Ship **`provider-mock`** for demos/tests.  
4. Wire `IPermissionHandler` from acp-llm-cli into Forge policy + `ApprovalPort` (never trust CLI permission alone).  
5. **ACPX** (`acpx`) is optional private mesh transport — not the Provider SDK; never public.  
6. Public SDK never imports `@simpill/acp-llm-cli` or `@agentclientprotocol/*`.

## Consequences

- Dogfoods SimPill patterns (Zod, env, logger).  
- Zod peer may be v3 — normalize at adapter boundary toward Forge Zod v4.  
- Install via `github:SkinnnyJay/acp-llm-cli` until registry publish.

## Alternatives

Direct Anthropic SDK only (less multi-CLI); ACPX-only (less typed factory).
