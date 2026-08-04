# 011 — Observability

**Status:** Handbook (normative)  
**Audience:** Runtime engineers, adapter authors, SRE  
**Related:** [ADR-006](./adrs/006-observability.md) · [013-testing](./013-testing.md) · [014-security](./014-security.md)  
**Research:** [011-observability.research.md](./research/011-observability.research.md)

---

## 1. Purpose

Forge observability answers four questions for every workflow run:

1. **What happened?** — Structured logs with correlation IDs.
2. **Where did time go?** — Distributed traces across compile → queue → run → gate → sandbox.
3. **Was it allowed?** — Policy and approval decisions as first-class telemetry.
4. **What did the model do?** — Optional LLM deep-dive via LangSmith, never as the only sink.

Observability is a **platform concern**, not a vendor choice. Domain packages, the workflow compiler, and company plugins never import LangSmith, OpenTelemetry exporters, or pino directly. They depend on Forge ports and dogfood SimPill utilities where applicable.

---

## 2. Locked decisions

| Layer | Technology | Port / utility |
|-------|------------|----------------|
| Correlation | W3C Trace Context + `@simpill/request-context.utils` | Process-scoped ALS |
| Logs | `@simpill/logger.utils` (pino adapter) | `LoggerPort` |
| Traces & metrics | OpenTelemetry API/SDK | `ObservabilityPort` |
| LLM deep dive | LangSmith (optional) | Same port; feature-flagged adapter |
| AI SDK telemetry | `@ai-sdk/otel` when AI SDK is used | Registered at composition root only |

**Normative rules:**

1. Domain and compiler packages **never** import `langsmith` or vendor OTEL exporters.
2. Every run has `runId` + `traceId`; approvals and tool calls are spans.
3. Secrets and PII are redacted in log attributes; env secrets are **never** logged.
4. OpenFeature may gate LangSmith export; **OPA still owns authorization** (see [014-security](./014-security.md)).
5. Span cardinality budgets are documented and enforced from Phase 2 onward.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  apps/{api, worker, ui}  — composition roots                    │
│  register OTEL SDK, logger, request-context, optional LangSmith │
└───────────────────────────────┬─────────────────────────────────┘
                                │ inject ports
┌───────────────────────────────▼─────────────────────────────────┐
│  @forge/runtime · @forge/compiler · @forge/policy · adapters    │
│  depend on LoggerPort + ObservabilityPort only                    │
└───────────────────────────────┬─────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
  OTEL Collector          Structured logs          LangSmith (optional)
  (traces/metrics)        (stdout / Loki / …)      via adapter only
```

### 3.1 Port interfaces (conceptual)

```ts
interface LoggerPort {
  child(bindings: Record<string, unknown>): LoggerPort
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  // debug/trace gated by env in composition root
}

interface ObservabilityPort {
  startSpan(name: string, attrs?: SpanAttributes): SpanHandle
  recordMetric(name: string, value: number, attrs?: MetricAttributes): void
  withContext<T>(ctx: TraceContext, fn: () => T): T
}
```

Adapters implement these at the composition root (`apps/api`, `apps/worker`). Tests use in-memory OTEL exporters and stub loggers.

### 3.2 Request context propagation

Every inbound request and every dequeued job must establish:

| Field | Source | Propagation |
|-------|--------|-------------|
| `traceId` | W3C `traceparent` or generated | OTEL + logs |
| `spanId` | Active span | OTEL |
| `runId` | Forge run store | Logs + span attribute |
| `tenantId` / `companyId` | Company loader | Logs + span attribute |
| `workflowId` | Compiled workflow | Logs + span attribute |
| `actorId` | IdP / run principal | Logs (redacted where PII) |

Use `@simpill/request-context.utils` for async-local storage so worker continuations and approval resumes inherit context without threading bags through every function.

---

## 4. Event taxonomy

All Forge-emitted telemetry uses the `forge.*` namespace. Third-party engine internals (LangGraph node names, BullMQ job IDs as primary keys) may appear as **low-cardinality adapter attributes** but must not replace Forge event names in dashboards.

### 4.1 Required events

| Event | Type | When | Required attributes |
|-------|------|------|---------------------|
| `forge.run.start` | span + log | Run accepted | `runId`, `workflowId`, `workflowVersion`, `companyId`, `providerId` |
| `forge.run.end` | span + log | Terminal success | `runId`, `durationMs`, `outcome=success` |
| `forge.run.fail` | span + log | Terminal failure | `runId`, `errorCode`, `durationMs` |
| `forge.node.start` | span | IR node enters | `runId`, `nodeId`, `nodeKind` |
| `forge.node.end` | span | IR node exits | `runId`, `nodeId`, `durationMs` |
| `forge.approval.requested` | span + log | HITL gate opens | `runId`, `approvalId`, `tool`, `argsHash`, `policyId` |
| `forge.approval.resolved` | span + log | Human decision | `runId`, `approvalId`, `decision`, `approverId` |
| `forge.policy.decide` | span + log | Pre-action authz | `runId`, `action`, `allow`, `obligations[]` |
| `forge.provider.invoke` | span | Model call | `runId`, `providerId`, `model` (no prompt body) |
| `forge.sandbox.create` | span | Sandbox provisioned | `runId`, `sandboxId`, `tier` |
| `forge.sandbox.destroy` | span | Sandbox torn down | `runId`, `sandboxId`, `reason` |

### 4.2 Security events (cross-link 014)

These must always be emitted and alertable in production:

- `forge.policy.deny`
- `forge.gate.timeout`
- `forge.sandbox.kill`
- `forge.secret.redacted`

---

## 5. Logging standards

### 5.1 Structured logging

- JSON logs in production; pretty-print only in local dev.
- One log line per significant state transition; no printf debugging in packages.
- Log levels: `error` (action required), `warn` (degraded), `info` (audit-worthy), `debug` (local only).

### 5.2 Redaction

Before any attribute reaches logs, traces, or LangSmith:

| Pattern | Action |
|---------|--------|
| `Authorization`, `api_key`, PEM blocks | Replace with `[REDACTED]` |
| Env vars matching `*_SECRET`, `*_TOKEN`, `*_KEY` | Never attach |
| Full prompt text | Omit by default; opt-in sampling with ADR |
| PII fields (email, SSN, member ID) | Hash or truncate per company policy pack |

Implement redaction in the **adapter layer**, not in call sites. Domain code passes structured fields; adapters scrub.

### 5.3 Never log

- Raw tool arguments containing secrets (mask in approval preview path).
- OPA Rego bundle contents at `debug`.
- Plugin source code or sandbox filesystem listings at `info`.

---

## 6. Tracing standards

### 6.1 Span hierarchy

```
forge.run
├── forge.compile          (if compile-in-run)
├── forge.node (×N)
│   ├── forge.policy.decide
│   ├── forge.provider.invoke
│   ├── forge.approval.requested → forge.approval.resolved
│   └── forge.sandbox.create → … → forge.sandbox.destroy
└── forge.run.end | forge.run.fail
```

Parent context must propagate across API → queue → worker → sandbox RPC.

### 6.2 Cardinality budgets (Phase 2+)

| Attribute | Cardinality limit | Notes |
|-----------|-------------------|-------|
| `workflowId` | Low (catalog size) | OK as metric label |
| `nodeId` | Medium (per workflow) | OK as span attribute |
| `runId` | High | Spans only; not metric labels |
| `promptVersion` | Low | OK |
| Raw prompt hash | Medium | Prefer version ID |

Exceeding budgets fails CI perf/observability gates (see [013-testing](./013-testing.md)).

### 6.3 AI SDK integration

When the Vercel AI SDK is the provider adapter, register `@ai-sdk/otel` **only** in the composition root alongside the Forge OTEL SDK. AI SDK spans become children of `forge.provider.invoke`, not parallel roots.

---

## 7. Metrics

Minimum metric set for operability:

| Metric | Type | Labels (low cardinality) |
|--------|------|--------------------------|
| `forge_runs_total` | counter | `outcome`, `companyId`, `workflowId` |
| `forge_run_duration_seconds` | histogram | `workflowId` |
| `forge_approvals_pending` | gauge | `companyId` |
| `forge_policy_decisions_total` | counter | `allow`, `action_class` |
| `forge_provider_tokens_total` | counter | `providerId`, `direction` |
| `forge_sandbox_active` | gauge | `tier` |

Do **not** use raw prompts, user emails, or `argsHash` as metric labels.

---

## 8. LangSmith adapter (optional)

LangSmith is an **optional LLM observability sink**, not a platform requirement.

### 8.1 Activation

- Controlled by OpenFeature flag `observability.langsmith.enabled`.
- Requires env secret `LANGSMITH_API_KEY` (never in config files).
- Enabling LangSmith must not require code changes in plugins — flag + adapter registration only.

### 8.2 Data policy

Default deny for fields classified sensitive. Allowlist per company pack:

- Run metadata, tool names, token counts: allowed.
- Full prompts/completions: opt-in per tenant with compliance review.
- Member/benefits PII (Gusto): denied unless explicit ADR waiver.

### 8.3 UI link

The operator UI may link out to LangSmith traces for a run (optional). It must **not** embed LangSmith UI components or depend on LangSmith for approval workflows.

---

## 9. Local development

### 9.1 Default local stack

```bash
# Composition root env (example)
OTEL_EXPORTER_OTEL_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=forge-worker
LOG_LEVEL=debug
```

Use OTEL Collector with console exporter or Jaeger for local demos. Traces for `forge demo acme …` must be visible without LangSmith.

### 9.2 Acceptance (local)

1. Start a demo run; verify `forge.run.start` → `forge.run.end` trace in collector UI.
2. Trigger an approval gate; verify `forge.approval.requested` and `forge.approval.resolved` spans linked to same `traceId`.
3. Enable LangSmith flag; confirm export without adding imports to `@forge/runtime`.

---

## 10. Phase rollout

| Phase | Observability deliverables |
|-------|---------------------------|
| **0** | ADR-006 accepted; event taxonomy in this doc |
| **1** | `LoggerPort` + request context wired in API skeleton; JSON logs |
| **2** | OTEL traces for compile → run; in-memory exporter tests; cardinality doc |
| **3** | Approval + policy spans; security event catalog |
| **4** | Demo runs emit full taxonomy; Playwright asserts trace IDs in API responses |
| **5** | LangSmith adapter behind flag; redaction middleware |
| **Production** | Collector deployment, SLO dashboards, alert rules on `forge.policy.deny` rate |

---

## 11. Testing requirements

Cross-reference [013-testing](./013-testing.md):

- Integration tests use OTEL in-memory exporter; assert span names and required attributes.
- Architecture test: `packages/**` ↛ `langsmith`, ↛ `@opentelemetry/exporter-*` (except adapter package).
- Contract test: every `forge.*` event in §4.1 has a schema or snapshot fixture.

---

## 12. Alternatives considered

| Approach | Decision |
|----------|----------|
| LangSmith-only | Rejected — couples platform to vendor; fails multi-tenant audit story |
| Unstructured console.log | Rejected — not queryable; no correlation |
| Direct OTEL in domain | Rejected — violates ports & adapters |
| Prompt text in default traces | Rejected — LLM02 / disclosure risk |

---

## 13. Open questions

| ID | Question | Owner phase |
|----|----------|-------------|
| O-1 | Collector deployment topology (agent vs sidecar) | Production ADR |
| O-2 | Prompt sampling policy for LangSmith | Phase 5 + compliance |
| O-3 | Log retention per tenant | Production |

---

## 14. Exit criteria (handbook)

This document is **done** when:

- [ ] ADR-006 references this taxonomy.
- [ ] Implementation agents can implement `ObservabilityPort` without further research.
- [ ] Every event in §4.1 appears in at least one demo scenario telemetry checklist ([016-demo-scenarios](./016-demo-scenarios.md)).
