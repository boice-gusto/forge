# Research: Observability

**Feeds:** `011-observability.md`, ADR-006  
**Status:** Phase 0 research  
**Principle:** OpenTelemetry substrate; LangSmith only through adapters; structured logging; dogfood `@simpill/observability.utils` / `logger.utils` / `request-context.utils`.

---

## Verdict

| Layer | Technology | Port |
|-------|------------|------|
| Correlation | W3C tracecontext + `@simpill/request-context.utils` | process ALS |
| Logs | `@simpill/logger.utils` (pino adapter) | `LoggerPort` |
| Traces/metrics | OpenTelemetry API/SDK | `ObservabilityPort` |
| LLM deep dive | LangSmith (optional) | same port, feature-flagged |
| AI SDK telemetry | `@ai-sdk/otel` when AI SDK used | registered at composition root |

---

## Normative rules

1. Domain/compiler never import `langsmith` or vendor OTEL exporters.  
2. Every run has `runId` + `traceId`; approvals and tool calls are spans.  
3. Redact secrets/PII in log attributes (env secrets never logged).  
4. OpenFeature may gate LangSmith export; OPA still owns authz.  
5. Performance gates: span cardinality budgets documented in Phase 2.

---

## Minimum event taxonomy

- `forge.run.start|end|fail`  
- `forge.node.start|end`  
- `forge.approval.requested|resolved`  
- `forge.policy.decide`  
- `forge.provider.invoke`  
- `forge.sandbox.create|destroy`  

---

## Acceptance

1. Local demo: traces visible in OTEL collector or console exporter.  
2. Enabling LangSmith does not require code changes in plugins — flag + adapter only.  
