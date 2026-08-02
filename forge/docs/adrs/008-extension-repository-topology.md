# ADR-008: Core and extension repository topology

- **Status:** Accepted
- **Date:** 2026-08-02
- **Supersedes:** ADR-001 layout decision 2 for Acme placement
- **Evidence:** `docs/research/RAW2.md`, `docs/research/019-buzz-integration.md`

## Context

Forge must prove extension over replacement for both company packages and external collaboration integrations. Keeping all examples nested in core makes the Acme proof weaker and obscures the difference between a company extension and a connector extension.

## Decision

1. The parent workspace coordinates sibling repositories/packages: `forge/` (core), `forge.acme/` (fake company), `forge.gusto/` (company extension), and `forge.buzz/` (Buzz connector extension).
2. `forge.acme` and `forge.gusto` own company workflows, prompts, policies, service catalog data, sandbox profiles, fixtures, and themes. They contain no framework implementation.
3. `forge.buzz` owns only Buzz event normalization, identity mapping, progress/artifact presentation, Buzz-specific approvals/UI/configuration, and its E2E demo. It contains no workflow engine, sandbox, queue, provider, persistence, generic artifact schema, or generic policy evaluator.
4. All extensions depend on Forge public SDKs/contracts only. Forge never imports an extension. `forge.buzz` treats Buzz as an untrusted collaboration transport; Forge remains the authority for execution durability, policy, approval, and audit.

## Consequences

- Workspace and dependency fitness tests must support independent extension releases while preserving local linked development.
- `examples/acme` migrates to `forge.acme` only as part of a deliberate Phase 1 repository-topology task; no compatibility shim is silently created.
- Jira/Slack/Buzz are intake/artifact adapters that normalize to `WorkflowRequest`; they never own workflow implementation.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Nested `examples/acme` forever | Weak proof of outside-core extension boundaries |
| Core-owned Buzz listener | Couples execution platform to a fast-moving external product |
| Let Buzz own Forge persistence/approvals | Current Buzz workflow approval wiring is explicitly still being completed; violates Forge governance boundary |
