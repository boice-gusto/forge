# ADR-007: Policy engine (OPA Wasm)

- **Status:** Accepted  
- **Date:** 2026-08-02  
- **Evidence:** `014-security.research.md`, `TECH-STACK-RESEARCH.md`

## Decision

- Capability / tool / approval authorization uses **OPA Wasm** (`@open-policy-agent/opa-wasm`) behind `PolicyPort`.  
- **Fail closed** on errors.  
- **OpenFeature** is for rollout flags only — never sole authz.  
- Input shape: `{ principal, action, resource, context }` → `{ allow, obligations[] }` (obligations drive HITL).

## Alternatives

Prompt-based permissions (forbidden); OpenFeature-only (insufficient).
