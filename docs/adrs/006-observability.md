# ADR-006: Observability substrate

- **Status:** Accepted  
- **Date:** 2026-08-02  
- **Evidence:** `011-observability.research.md`, `TECH-STACK-RESEARCH.md`

## Decision

- **OpenTelemetry** is the platform telemetry substrate (`ObservabilityPort`).  
- **Structured logs** via `@simpill/logger.utils` + request context.  
- **LangSmith** optional LLM sink behind the same port, gated by OpenFeature.  
- Domain packages never import `langsmith` or exporter SDKs.

## Alternatives

LangSmith-only (couples); console.log (fails audit).

## Amendment 2026-08-06: pino, and no LangSmith

`ObservabilityPort` exists and is honoured; two things named above do not.

**`@simpill/logger.utils` was never available.** `@forge/observability` logs
through `pino`. This is the same finding as ADR-005's amendment — the
`@simpill/*` packages the plan assumed are not published, and were replaced
with what exists rather than waited for.

**LangSmith and OpenFeature are not built.** No sink, no flag, no dependency.
The port is where one would go and the decision to keep it behind the port
still holds, but "optional LLM sink, gated by OpenFeature" describes an
intention rather than the code. ADR-007 cites OpenFeature for rollout flags on
the same footing and is stale in the same way.

What *is* built: OTLP export over `@opentelemetry/*`, redaction enforced in
the adapter rather than at call sites, one trace per run carried across
processes on the run record, and a durable run-event history behind
`RunEventStorePort`. The audit requirement the original decision was protecting
is met; the vendor named in it is not the one in the tree.
