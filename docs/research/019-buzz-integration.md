# Research: Buzz integration boundary

**Status:** Research; connector implementation deferred until the CLI/API flagship workflow passes.

## Verified observations

Buzz provides a relay, signed event-oriented collaboration, a JSON-oriented CLI, and an optional `buzz-acp` harness that connects ACP agents such as Claude Code and Codex to the relay. Its own status table labels workflow approval gates as still being wired, so Forge must not rely on Buzz for durable approval, delivery, policy, or execution authority. Sources: https://github.com/block/buzz and https://github.com/block/buzz/blob/main/TESTING.md

## Forge decision

```text
Buzz relay event -> forge.buzz listener -> canonical WorkflowRequest -> Forge API/queue
Forge artifacts/progress -> forge.buzz artifact adapter -> Buzz room/thread
```

The listener verifies signatures, filters/deduplicates events, maps Buzz identity/room to Forge principals and workflow metadata, invokes the Forge intake API, and publishes safe progress/artifact summaries. It never starts providers, manages sandboxes, decides policy, or persists canonical workflow state.

`BuzzAgentProvider` is Research only. If introduced, it is a private `ProviderPort` adapter and does not replace the V1 SimPill ACP harness.

## Required connector tests

- invalid signature, duplicate event, unknown identity, and unauthorized room are denied without a Forge run;
- one accepted Buzz event becomes one idempotent `WorkflowRequest`;
- progress and artifact publication contain redacted metadata only;
- Buzz delivery failure is retried through Forge connector policy and never loses the canonical run/audit record;
- Forge restart/resume and approval remain correct when Buzz is unavailable.
