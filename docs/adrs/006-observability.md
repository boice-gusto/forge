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
