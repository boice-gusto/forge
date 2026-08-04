# forge.buzz

`forge.buzz` is the Buzz collaboration connector for Forge. It translates Buzz events and presentation into Forge’s public intake, progress, artifact, and approval contracts.

## Owns

- Buzz event signature verification, filtering, de-duplication, identity mapping, and room/thread mapping.
- Conversion of accepted Buzz events into canonical Forge `WorkflowRequest` values.
- Safe progress and artifact publication back to Buzz, Buzz-specific UI components/configuration, and connector E2E tests.

## Does not own

- Forge workflow meaning, persistence, approval durability, policy authority, provider execution, queues, sandboxes, or generic artifact schemas.
- A long-running Forge worker inside the connector.

## Boundary

```text
Buzz relay event -> forge.buzz -> Forge intake API -> durable Forge workflow
Forge events/artifacts -> forge.buzz -> Buzz room or thread
```

Buzz is a collaboration and event substrate. Forge remains the authority for execution, policy, evidence, quality gates, and audit. A Buzz outage must not lose the canonical Forge run; publication is retried through Forge connector policy. `buzz-acp` is research-only as an optional private provider adapter, not a V1 dependency.

## Status

Status: **connector design and research complete; implementation is Phase 8, after the CLI/API flagship is production-evaluable.**

Read the [Buzz integration research](../forge/docs/research/019-buzz-integration.md), [ADR-008](../forge/docs/adrs/008-extension-repository-topology.md), and [Phase 8 plan](../forge/docs/superpowers/plans/2026-08-02-forge-phased-program.md).
