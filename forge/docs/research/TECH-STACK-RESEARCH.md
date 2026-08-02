# Forge Phase 0 — Technology Stack Research

> **Status:** Research summary for ADR drafting (not binding decisions)  
> **Audience:** Architecture / Phase 0 ADR authors  
> **Date context:** Current best practices as of mid/late 2026  
> **Constraint:** Forge is a typed TypeScript monorepo; adapters at every boundary; never expose engine internals publicly  
> **Uncertainty policy:** Claims that could not be fully verified against primary docs are marked **[UNCERTAIN]**

---

## How to use this document

1. Each section is ADR-ready: *what / why Forge / APIs / alternatives / risks*.
2. The final section recommends a **default Phase 0 stack** (adopt / defer / reject).
3. Cross-cutting Forge principles that drive recommendations:
   - Compile, don’t configure
   - Adapters at every boundary
   - Never expose LangGraph / BullMQ / provider APIs publicly
   - Policies before permissions
   - Humans approve; AI recommends
   - Zod v4 at every boundary (safe parse only)
   - OpenTelemetry as platform telemetry substrate
   - LangSmith only through adapters

---

## 1. LangGraph (JS/TS)

### What it is
LangGraph.js is a graph / functional workflow runtime for durable, stateful agent and pipeline execution. It checkpoints state per super-step (or per task in the Functional API), supports interrupts for human-in-the-loop, streaming, and time-travel/debug via thread + checkpoint IDs.

Primary packages:
- `@langchain/langgraph`
- `@langchain/langgraph-checkpoint` (base + `MemorySaver`)
- `@langchain/langgraph-checkpoint-postgres` (`PostgresSaver`)
- Optional: SQLite / MongoDB checkpoint packages for local/dev

### Why Forge might use it
Forge needs a **compiled workflow runtime** with:
- Durable resume after approval gates
- Deterministic infrastructure around intelligent steps
- Threaded run identity for long-lived company workflows

LangGraph is the strongest OSS TS option that already encodes HITL + checkpointing as first-class concepts. Forge should treat it as an **internal engine**, never a public API.

### Key APIs / concepts
| Concept | Notes |
| --- | --- |
| Graph API | `StateGraph`, `StateSchema`, nodes, edges, `START`/`END`, `.compile({ checkpointer })` |
| Functional API | `entrypoint`, `task`, checkpointing with less graph boilerplate |
| Checkpoints | Snapshot per super-step; organized by `thread_id` (+ optional `checkpoint_id`, `checkpoint_ns`) |
| HITL | `interrupt(value)` pauses; resume with `Command({ resume })` and same `thread_id` |
| State inspection | `graph.getState(config)`, `graph.getStateHistory(config)` |
| Persistence | `MemorySaver` (dev only); `PostgresSaver.fromConnString(...)` + `setup()` for prod |
| Config | `{ configurable: { thread_id } }` required when checkpointing |

Docs show Zod v4 schemas used with `StateSchema` / `ReducedValue` — aligns with Forge constitution.

### Alternatives
| Alternative | When to consider |
| --- | --- |
| Temporal (TS SDK) | Stronger durable-execution product; heavier ops; less LLM-native HITL UX |
| Inngest / Trigger.dev | Event/job workflows; weaker graph+agent primitives |
| Custom state machine + Postgres | Full control; high build cost; reinvent checkpoint/HITL |
| CrewAI / AutoGen-style frameworks | Agent orchestration focus; weaker “compile typed workflows” story for Forge |
| LangChain alone (no execute graph) | Insufficient for durable multi-step HITL |

### Risks / tradeoffs
- **Leakage risk:** Public types/APIs must never re-export LangGraph symbols. Adapter boundary is mandatory.
- **Vendor gravity:** Checkpoint formats and interrupt semantics are LangGraph-specific; migration cost is real.
- **Resume semantics:** On resume, nodes restart from the beginning — side effects must be after `interrupt` or wrapped in idempotent `task`s.
- **Serialization:** Checkpointed state must be JSON-serializable; Forge domain objects need explicit codecs.
- **Ops:** Production needs Postgres (or equivalent) checkpointer + Redis (BullMQ) — two persistence systems.
- **[UNCERTAIN]** Exact maturity parity of every Python LangGraph feature in JS (e.g. some Agent Server / platform features are Python-first).

### Forge opinion
**Adopt behind a WorkflowEngine port.** Compile Forge workflow IR → LangGraph graphs/entrypoints. Public surface: `runId`, `threadId`, `interrupt`, `resume`, typed events — not `StateGraph`.

---

## 2. LangSmith

### What it is
LangSmith is LangChain’s observability / evaluation / prompt platform for LLM apps: traces, runs, threads, datasets, online evals, feedback. TS SDK: `langsmith` (`traceable`, `wrapOpenAI`, `RunTree`, env-driven auto-tracing).

### Why Forge might use it
LLM-specific debugging (prompt/version, tool calls, token cost, agent step trees) is poorly served by generic APM alone. LangSmith is the natural companion if LangGraph is the engine — and Forge already plans “LangSmith through adapters.”

### Key APIs / concepts
| Concept | Notes |
| --- | --- |
| Projects / traces / runs | Hierarchical run tree per operation |
| Threads | Multi-turn / multi-step linkage |
| Env | `LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`, optional `LANGSMITH_WORKSPACE_ID`, `LANGSMITH_ENDPOINT` |
| Manual | `traceable(fn, { name })`, `RunTree` |
| Wrappers | `wrapOpenAI` and other provider wrappers |
| Integrations | LangGraph native; also Vercel AI SDK and others listed in LangSmith docs |
| Deployment modes | Cloud, hybrid, self-hosted (platform setup docs) |

**OTEL relationship (important):**
- LangSmith can ingest OTLP and has stronger native OTEL export story in **Python**.
- KB notes (2025): JS/TS OTEL support exists in recent versions for some paths (`traceable`, AI SDK); LangChain/LangGraph JS OTEL parity may lag. **[UNCERTAIN — verify current JS SDK OTEL matrix before ADR freeze]**

### Alternatives
| Alternative | When to consider |
| --- | --- |
| Helicone / Braintrust / Phoenix (Arize) / Langfuse | Open/self-host preference; eval-centric products |
| Pure OpenTelemetry + custom LLM span attributes | Max vendor neutrality; build LLM UX yourself |
| Honeycomb/Datadog LLM packs | Already standardized on those vendors |

### Risks / tradeoffs
- **SaaS / data residency:** Prompts and tool payloads may contain secrets/PII — need redaction adapter + retention policy.
- **Coupling:** Easy to sprinkle `langsmith` imports everywhere; violates adapter rule.
- **Cost / retention:** High-volume workflow traces get expensive; sample production, full-trace staging.
- **Dual telemetry:** Without a clear OTEL↔LangSmith fanout design, you get duplicate or fragmented traces.

### Forge opinion
**Adopt as LLM observability adapter (optional at runtime).** Default: OTEL for platform; LangSmith for LLM deep dives when enabled by feature flag. Never import `langsmith` from domain/plugin packages.

---

## 3. BullMQ

### What it is
Redis-backed Node.js job queue. Core classes: `Queue`, `Worker`, `QueueEvents`, `FlowProducer`. Supports retries/backoff, delays, priorities, rate limits, concurrency, job flows (DAG-ish dependencies). Mature TypeScript-first ecosystem (BullMQ 5.x line actively maintained into 2026).

### Why Forge might use it
Workflow engines checkpoint *state*; queues own *dispatch*:
- Run workers across processes/machines
- Retry transient provider/sandbox failures
- Isolate long-running sandboxed jobs from API processes
- Schedule delayed follow-ups / timeouts

Forge constitution already says: never expose BullMQ publicly.

### Key APIs / concepts
| Concept | Notes |
| --- | --- |
| `Queue.add(name, data, opts)` | Enqueue; use stable `jobId` for idempotency |
| `Worker(name, processor, opts)` | Consume with concurrency / limiter |
| Retries | `attempts` + `backoff: { type: 'exponential' \| 'fixed', delay }` |
| `UnrecoverableError` | Stop retrying poison messages |
| Events | `completed` / `failed` / `QueueEvents` for observers |
| Flows | `FlowProducer` for parent/child job graphs |
| Connection | Dedicated Redis connection; **`maxRetriesPerRequest: null`** required for workers |
| Cleanup | `removeOnComplete` / `removeOnFail` age+count caps |

Official docs: jobs fail when processor throws; retries are opt-in via `attempts`.

### Alternatives
| Alternative | When to consider |
| --- | --- |
| Temporal | Want workflow+queue unified; accept Temporal ops |
| pg-boss | Prefer Postgres-only infra (no Redis) |
| Graphile Worker | Postgres LISTEN/NOTIFY job model |
| SQS + workers | AWS-native deployment |
| RabbitMQ / NATS JetStream | Broader messaging needs |

### Risks / tradeoffs
- **At-least-once delivery:** Processors must be idempotent; pair with Forge run IDs.
- **Redis as SPOF/memory bomb:** Without removal policies and monitoring, Redis fills with job history.
- **Split brain with LangGraph:** Queue owns “who runs next”; checkpointer owns “what state.” Need a single orchestration story in the WorkflowEngine adapter.
- **No built-in DLQ:** Implement via `failed` handler → DLQ queue (common pattern, not a product feature).
- **Never expose** `Job` / `Queue` types outside infra adapters.

### Forge opinion
**Adopt behind a JobQueue port.** Use for worker execution, sandbox jobs, webhooks, and retryable side effects. Do **not** model human approvals as queue retries — use LangGraph interrupts + explicit resume commands.

---

## 4. Vercel AI SDK

### What it is
The leading TypeScript toolkit for model calls and AI UI streaming (`ai` package, AI SDK 5+). Unified provider model (Language Model Spec V2), `generateText` / `streamText`, tool calling, SSE streaming to clients, `useChat` / UI message stream architecture, provider registry / custom providers.

AI SDK 5 (announced 2025) made SSE the standard streaming protocol and recommends Zod **4.1.8+** for TS performance.

### Why Forge might use it
Forge must not expose Claude/OpenAI-specific APIs. AI SDK is the best TS **provider abstraction + streaming** layer for:
- Multi-provider model calls
- Tool/result streaming to a console UI
- Custom providers (CLI wrappers, mock, gateway)

### Key APIs / concepts
| Concept | Notes |
| --- | --- |
| `generateText` / `streamText` | Core generation APIs |
| `model` | Provider model instance or registry string id |
| Tools | Typed tool definitions; tool-call streaming default in v5 |
| `textStream` / `fullStream` | Streaming granularities |
| UI messages | `UIMessage` stream architecture (v5); `useChat` on client |
| Provider registry | `createProviderRegistry`, custom/`@ai-sdk/*` providers |
| Middleware | Model middleware for logging, caps, policy hooks |
| Related | Community `@ai-sdk/policy-opa` for OPA tool approvals **[verify package stability before adopting]** |

### Alternatives
| Alternative | When to consider |
| --- | --- |
| LangChain chat models only | Already deep in LangChain; accept weaker web streaming UX |
| OpenAI SDK + ad-hoc adapters | Simpler but poor multi-provider story |
| LiteLLM (sidecar) | Central gateway in another language/process |
| Direct provider SDKs behind Forge ports | Max control; more code |

### Risks / tradeoffs
- **Scope creep:** AI SDK also has Agent abstractions — Forge should **not** let AI SDK become a second workflow engine. Use it for model I/O + UI streaming only.
- **Vercel gravity:** Excellent with Next.js; still usable off-Vercel, but examples skew Next.
- **Version churn:** v4→v5 had breaking stream/UI changes; pin majors and adapter-test upgrades.
- **Provider leakage:** Plugins must depend on Forge `ModelPort`, not `@ai-sdk/anthropic` directly.

### Forge opinion
**Adopt as the ModelProvider adapter implementation** (and UI streaming bridge). Compile Forge provider manifests → AI SDK registry. Public API stays Forge-owned.

---

## 5. AI Elements (Vercel)

### What it is
Open-source React component registry (shadcn/ui-style) for AI-native UIs: conversation, message, prompt input, reasoning, tool display, citations, branch, code block, etc. Installed into the repo via CLI (`npx ai-elements@latest`), not a black-box npm runtime dependency. Site: [elements.ai-sdk.dev](https://elements.ai-sdk.dev/). Latest published line observed: `ai-elements@1.9.x` (2026).

### Why Forge might use it
Forge needs a console for:
- Streaming assistant output
- Tool/call visualization
- Human approval UX
- Reasoning / task progress

AI Elements accelerates a non-generic chat/ops UI while remaining forkable source in-tree.

### Key APIs / concepts
| Concept | Notes |
| --- | --- |
| CLI install | Copies components into `components/ai-elements/` (or configured shadcn path) |
| Composition | `Conversation`, `Message`, `PromptInput`, `Tool`, `Reasoning`, `Branch`, … |
| Coupling | Designed to pair with AI SDK `useChat` / message parts |
| Theming | Assumes shadcn/Tailwind CSS variable theming |

### Alternatives
| Alternative | When to consider |
| --- | --- |
| assistant-ui | Strong headless chat primitives |
| Custom shadcn only | Full design control; slower |
| Streamlit/Gradio-like internal tools | Prototypes only — not Forge product UI |

### Risks / tradeoffs
- **Design system.** shadcn/AI Elements look can become generic AI-chat chrome; Forge brand/console UX still needs intentional design (per Forge UI standards later).
- **Copy-in maintenance.** Updates are merges, not semver bumps of a library.
- **Overfit to chat.** Approval queues, policy diffs, and workflow graphs may need custom views beyond Elements.
- Phase 0 should **not** block on UI — Elements is Phase 1+ demo acceleration.

### Forge opinion
**Defer to Phase 1 UI spike; shortlist as default.** Do not let AI Elements dictate domain events — map Forge UI message DTOs → Elements parts in an adapter.

---

## 6. OpenTelemetry

### What it is
CNCF standard for traces, metrics, and logs. JS stack: `@opentelemetry/api`, `@opentelemetry/sdk-node`, auto-instrumentations, OTLP exporters. Stable traces/metrics; logs supported via OTLP exporters in Node SDK env config. Initialize **before** app code (`node --import ./instrumentation.ts`).

### Why Forge might use it
Constitution-level requirement. Platform telemetry must be vendor-neutral:
- HTTP/queue/db spans
- Workflow run metrics (duration, interrupt rate, fail rate)
- Structured correlation with `runId` / `threadId` / `tenantId`

### Key APIs / concepts
| Concept | Notes |
| --- | --- |
| `NodeSDK` | Bootstraps tracers/meters/(logs) |
| `trace.getTracer` / spans | Manual instrumentation at Forge ports |
| Metrics | Counters/histograms via `Meter` |
| Auto-instrumentation | HTTP, undici, Redis clients, etc. |
| Context propagation | W3C traceparent across API → worker → sandbox |
| Env | `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_*`, `OTEL_TRACES_EXPORTER`, … |
| Collector | Recommended fanout to Grafana/Datadog/LangSmith OTLP |

### Alternatives
| Alternative | When to consider |
| --- | --- |
| Vendor agent only (Datadog/New Relic) | Faster if single-vendor locked |
| OpenTracing legacy | Do not — superseded |
| Custom log-only observability | Insufficient for distributed workflow runtime |

### Risks / tradeoffs
- **Cardinality explosions** from high-dimension LLM attributes — use careful attribute allowlists.
- **ESM loader complexity** for instrumentation hooks in modern TS monorepos.
- **Overlap with LangSmith** — define a layering rule (below).
- Performance: sample in prod; always-on full traces in CI demos.

### Forge opinion
**Adopt as the sole required telemetry substrate.** All adapters emit OTEL. LangSmith is an optional sink/product UX, not the system of record for infra health.

**Recommended layering:**
1. Forge core/workers: OTEL only
2. LLM spans: OTEL attributes + optional LangSmith export via adapter
3. Collector routes destinations

---

## 7. OpenFeature

### What it is
CNCF incubating vendor-neutral feature-flag API. JS packages:
- `@openfeature/server-sdk` (Node)
- `@openfeature/web-sdk` / React SDK (browser)
- Providers for LaunchDarkly, Flagsmith, GO Feature Flag, Unleash, in-memory, etc.

### Why Forge might use it
Constitution lists feature flags. OpenFeature prevents locking Forge plugins to LaunchDarkly (etc.) and fits “extension over replacement.”

### Key APIs / concepts
| Concept | Notes |
| --- | --- |
| `OpenFeature.setProviderAndWait(provider)` | Init |
| `OpenFeature.getClient(domain?)` | Client |
| Typed evaluators | `getBooleanValue`, `getStringValue`, `getNumberValue`, `getObjectValue` |
| Evaluation context | Targeting keys, traits; transaction context propagator (ALS) |
| Hooks | Before/after evaluation telemetry |
| MultiProvider | Migration/backup/comparison strategies |
| Shutdown | `OpenFeature.close()` |

### Alternatives
| Alternative | When to consider |
| --- | --- |
| Direct LaunchDarkly/Unleash SDK | Faster, accepts lock-in |
| Config-only flags in YAML | Fine for Phase 0–1; weak targeting/experimentation |
| GrowthBook | Product analytics + flags combo |

### Risks / tradeoffs
- **Flags ≠ policy.** Do not use OpenFeature for capability authorization (that’s OPA). Flags gate *rollout*; OPA gates *allow*.
- Provider outage behavior must fail closed/open explicitly per flag class.
- Too many flags create config debt — require flag lifecycle in engineering standards.

### Forge opinion
**Adopt the API early with `TypedInMemoryProvider` / file provider in Phase 0–1.** Swap to GO Feature Flag or Unleash in prod without rewriting call sites.

---

## 8. Open Policy Agent (OPA) / policy-as-code

### What it is
CNCF-graduated policy engine. Policies in Rego; evaluate via:
- OPA/EOPA server (HTTP) — `@open-policy-agent/opa` TS SDK
- In-process Wasm bundles — `@open-policy-agent/opa-wasm` (`loadPolicy`)
- Emerging AI SDK helper: `@ai-sdk/policy-opa` for tool-approval hooks **[verify production readiness]**

### Why Forge might use it
Forge principle: **Policies before permissions. Capabilities determine what is allowed. Not prompts.**

OPA gives a deterministic PDP (policy decision point) in front of:
- Tool/skill invocation
- Provider/model selection
- Sandbox network egress classes
- Human-approval requirements (policy can return `require_approval`)

### Key APIs / concepts
| Concept | Notes |
| --- | --- |
| Rego | Declarative policy language |
| Decision | Typically `allow` / structured obligation objects |
| Wasm path | `opa build -t wasm -e package/rule` → `loadPolicy(wasm)` → `evaluate(input)` |
| HTTP path | `executePolicyWithInput` against running OPA |
| Data | Separate policy from data documents (roles, repo allowlists) |
| Testing | `opa test` — policies tested without app boot |

### Alternatives
| Alternative | When to consider |
| --- | --- |
| AWS Cedar | Smaller language, strong defaults; Bedrock-adjacent ecosystems |
| OSO / Cedar-in-process | App-centric authorization |
| CASL / custom TS RBAC | Too weak for agent capability graphs |
| Cedar + OPA hybrid | Unlikely — pick one PDP |

### Risks / tradeoffs
- **Rego learning curve** for the team and for generated policies.
- **Latency/ops:** Sidecar is clean isolation; Wasm is faster/simpler for single-tenant workers.
- **Policy authorship UX:** Company users shouldn’t write Rego raw forever — Forge should compile capability manifests → Rego/Wasm.
- **Fail closed** is mandatory for tool gates.
- Don’t let LLM output mutate policy documents.

### Forge opinion
**Adopt OPA (Wasm-first for workers; optional sidecar later) behind a PolicyPort.** Phase 0 ADR should define input schema: `{ principal, action, resource, context }` → `{ allow, obligations[] }`. Obligations drive HITL interrupts.

---

## 9. MCP (Model Context Protocol)

### What it is
Open standard for **agent-to-tool/resource** connectivity (tools, resources, prompts, auth). Spec versions dated; as of **2026-07-28** a major revision ships with Tier-1 SDKs.

**TS SDK status (critical):**
- **v2** (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`, …) implements **2026-07-28** — ESM-only, Node 20+, Standard Schema (Zod v4 compatible)
- **v1.x** (`@modelcontextprotocol/sdk`) continues bug/security fixes for ≥6 months after v2

2026-07-28 themes (from official blog/changelog summaries):
- More **stateless** core; session model changes
- `server/discover` replaces older initialize handshake patterns
- Multi round-trip requests (`InputRequiredResult`)
- Tasks moved toward extensions framework
- Auth hardened toward OAuth 2.0 / OIDC
- Formal deprecation policy

### Why Forge might use it
MCP is the ecosystem standard for exposing tools to agents. Forge should:
- **Consume** MCP servers as skill backends (via adapter)
- Optionally **expose** Forge capabilities as MCP *without* leaking engine internals
- Keep policy checks **outside** MCP servers (Forge PDP wraps tool calls)

### Key APIs / concepts
| Concept | Notes |
| --- | --- |
| Tools / Resources / Prompts | Classic MCP primitives (v1 mental model still useful) |
| Transports | stdio, Streamable HTTP (and framework adapters: Express/Hono/Fastify) |
| Auth | OAuth-oriented hardening in newer spec |
| Schemas | v2: Standard Schema — Zod v4 fits |
| Discover | New discovery RPC in 2026-07-28 |

Exact method names should be taken from the pinned SDK docs at implementation time — **do not freeze v1 APIs into Forge public types**.

### Alternatives
| Alternative | When to consider |
| --- | --- |
| Forge-native skill SDK only | Simpler early; ecosystem isolation |
| OpenAPI tool-calling | Good for HTTP APIs; weaker stdio/devtool story |
| ACPX / other agent control planes | Company-specific; keep behind adapters (per “never expose ACPX”) |

### Risks / tradeoffs
- **Spec churn 2025→2026:** Pin MCP spec + SDK major in ADR; plan migration tests.
- **Confused deputy / tool poisoning:** MCP servers are untrusted capability surfaces — OPA must gate.
- **Session semantics change:** Any Forge code assuming long-lived MCP sessions needs redesign for 2026-07-28.
- **[UNCERTAIN]** Ecosystem lag: many third-party MCP servers may remain on 2025-11-25 for months; clients need dual-speak or compatibility mode (TS v2 docs mention serving multiple revisions from one HTTP endpoint).

### Forge opinion
**Adopt MCP as an adapter transport for tools, not as the workflow engine.** Phase 0 ADR: support MCP client consumption; defer Forge-as-MCP-server until Plugin SDK shape is stable. Prefer SDK v2 + Node 20 baseline.

---

## 10. A2A (Agent-to-Agent Protocol)

### What it is
Linux Foundation open standard (originated at Google, 2025) for **agent-to-agent** interoperability. Complements MCP:
- **MCP** = agent → tools/resources
- **A2A** = agent → agent (discover, delegate tasks, exchange artifacts)

v1.0 announced as production-ready stable line. Core ideas: Agent Cards (capability discovery), task lifecycle (sync/async, SSE/push), HTTP + JSON-RPC 2.0 (+ gRPC bindings in spec ecosystem), opaque agents (no shared memory/tools required).

Normative model: `spec/a2a.proto` (per official spec site).

### Why Forge might use it
Relevant if Forge must:
- Delegate to external opaque agents (vendor bots, sister platforms)
- Offer Forge workflows as remotely invokable agents to partners
- Avoid proprietary multi-agent RPC

**Less relevant** if Phase 0–2 is a single Forge runtime with plugins/skills (internal composition), not a multi-vendor agent mesh.

### Key APIs / concepts
| Concept | Notes |
| --- | --- |
| Agent Card | JSON capability/endpoint/auth advertisement |
| Task | Unit of work with lifecycle |
| Messages / Artifacts | Results exchanged between agents |
| Transports | HTTPS, JSON-RPC 2.0, SSE streaming; gRPC in ecosystem |
| Auth | OpenAPI-aligned schemes (API keys, OAuth2, OIDC) |

### Alternatives
| Alternative | When to consider |
| --- | --- |
| Forge Plugin SDK only | Internal extensibility without network agent mesh |
| MCP-only | If “other agents” are actually tool servers |
| Proprietary webhook contracts | Short-term partner integrations |

### Risks / tradeoffs
- **Premature interoperability:** Building A2A before Forge’s own workflow/public API settles creates double surfaces.
- **Security:** Cross-org agent delegation amplifies confused-deputy and data-exfil risk — needs OPA + human gates.
- **SDK maturity variance by language** — verify official TS SDK status at ADR time. **[UNCERTAIN: TS SDK completeness vs Python samples]**
- A2A is explicitly **not** an agent framework and **not** a substitute for MCP.

### Forge opinion
**Track + research; defer implementation past Phase 0.** Write a short ADR: “A2A is out of scope until Forge has a stable external Agent facade.” If needed later, implement as an edge adapter over Forge runs (Agent Card → start workflow / resume / stream events).

---

## 11. Zod v4

### What it is
TypeScript-first schema validation library; **Zod 4 is stable** (2025+) with large perf wins (~6.5× faster object `safeParse` in published benches), slimmer types, `zod/mini`, and API cleanups. Requires TypeScript **5.5+**.

### Why Forge might use it
Constitutional: **Zod v4 at every boundary; safe parsing only.** Ideal for:
- Workflow/plugin manifests
- Provider/tool I/O
- Queue payloads
- MCP tool schemas (Standard Schema)
- LangGraph `StateSchema` channels (docs show `zod/v4` usage)

### Key APIs / concepts
| Concept | Notes |
| --- | --- |
| `safeParse` / `safeParseAsync` | Non-throwing boundary validation (Forge default) |
| `parse` / `parseAsync` | Throwing — reserve for internal assertions only |
| `z.infer<typeof Schema>` | Static types from schemas |
| Formats | Prefer top-level `z.email()`, `z.uuid()`, … in v4 style |
| Objects | `z.strictObject` / `z.looseObject` replace older strict/passthrough patterns |
| Errors | `z.flattenError`, `z.treeifyError`, `z.prettifyError` |
| Mini | `zod/mini` for tree-shake sensitive packages |
| Compat | `zod/v3` path exists for migration; AI SDK asks **≥ 4.1.8** |

### Alternatives
| Alternative | When to consider |
| --- | --- |
| Valibot / ArkType | Bundle-size or type-perf specialists; weaker ecosystem overlap with AI SDK/MCP |
| TypeBox / Ajv | JSON Schema-first shops |
| Zod 3 | Do not for greenfield Forge |

### Risks / tradeoffs
- Breaking renames vs Zod 3 — set lint rules against deprecated APIs.
- Huge shared schemas can still stress `tsc` — prefer composition modules + `zod/mini` in edge packages.
- “Safe parse only” must be enforced by lint/archtests, not hope.

### Forge opinion
**Non-negotiable default.** Single version in the monorepo. Boundary rule: external `unknown` → `safeParse` → branded/typed domain objects. Never trust LLM or queue JSON without schemas.

---

## Default stack recommendation (Phase 0 ADR set)

### Decision legend
- **ADOPT** — write ADR + spike criteria; plan to implement in Phase 1
- **ADOPT-LATER** — ADR now, code later
- **DEFER** — research note only; revisit when trigger met
- **REJECT (for core)** — may still appear behind adapters for demos

### Recommended defaults

| Concern | Default | Decision | ADR title (suggested) |
| --- | --- | --- | --- |
| Workflow runtime | LangGraph.js behind `WorkflowEngine` port; Postgres checkpointer in prod | **ADOPT** | ADR-001 LangGraph as internal workflow engine |
| Job dispatch / retries | BullMQ + Redis behind `JobQueue` port | **ADOPT** | ADR-002 BullMQ as internal job queue |
| Model I/O + streaming | Vercel AI SDK 5 behind `ModelProvider` port | **ADOPT** | ADR-003 AI SDK as provider/streaming adapter |
| Boundary validation | Zod v4 (`safeParse` only) | **ADOPT** | ADR-004 Zod v4 at every boundary |
| Platform telemetry | OpenTelemetry SDK + Collector | **ADOPT** | ADR-005 OpenTelemetry substrate |
| LLM trace UX | LangSmith via `LlmObservability` adapter (optional sink) | **ADOPT** (optional runtime) | ADR-006 LangSmith through adapter |
| Feature flags | OpenFeature server SDK + in-memory/file provider first | **ADOPT** | ADR-007 OpenFeature for flags |
| Capabilities / authz | OPA Wasm-first behind `PolicyPort`; fail closed | **ADOPT** | ADR-008 OPA for capability decisions |
| Tool ecosystem | MCP client adapter (SDK v2 / spec 2026-07-28); dual-compat as needed | **ADOPT-LATER** (client first) | ADR-009 MCP tool adapter |
| AI console components | AI Elements (shadcn registry) for demo UI | **ADOPT-LATER** | ADR-010 AI Elements for console primitives |
| Agent mesh | A2A | **DEFER** | ADR-011 A2A deferred until external agent facade |

### Explicit non-goals for Phase 0–1
- Do not expose LangGraph, BullMQ, AI SDK providers, MCP session types, or OPA Rego details in public Forge SDK.
- Do not use AI SDK Agent class / LangGraph Platform as the *product* architecture — Forge compiler owns the workflow IR.
- Do not use feature flags as authorization.
- Do not use prompts/LLM judgments as capability gates.

### Reference architecture (opinionated)

```text
[ Manifests / Plugins / Prompts ]  --Zod v4-->  [ Forge Compiler ]
                                                    |
                                                    v
                     +------------------- WorkflowEngine (port) ------------------+
                     |  adapter: LangGraph (graphs/entrypoints, interrupt/resume) |
                     +-------------------------------+----------------------------+
                                                     |
           +------------------+                      | checkpoints (Postgres)
           | PolicyPort (OPA) | <--- every tool/model/sandbox request
           +--------+---------+
                    |
                    v allow / obligations (e.g. require_human)
                                                     |
                     +-------------------------------v----------------------------+
                     | JobQueue (port) → BullMQ workers (sandboxes, webhooks)      |
                     +-------------------------------+----------------------------+
                                                     |
           ModelProvider (port) → AI SDK providers
           McpToolAdapter (port) → MCP clients
           Flags (port) → OpenFeature
           Telemetry → OpenTelemetry (+ optional LangSmith adapter)
           UI (later) → AI Elements bound to Forge UI DTOs
```

### Phase 0 ADR acceptance criteria (research exit)
Each ADOPT ADR must include:
1. Public port interface (Forge-owned types only)
2. Forbidden imports list (archtest seeds)
3. Failure modes (fail closed/open)
4. Local spike plan (≤2 days) with success metric
5. Alternatives considered (table)
6. Data sensitivity / redaction notes where relevant

### Spike priority order (after ADRs drafted)
1. Zod boundaries + package layout  
2. LangGraph interrupt/resume + PostgresSaver  
3. BullMQ worker calling WorkflowEngine resume/step  
4. AI SDK multi-provider generate/stream  
5. OPA Wasm allow/deny around a fake tool  
6. OTEL traces across API→worker  
7. OpenFeature flag wrapping one risky path  
8. LangSmith adapter optional export  
9. MCP client calling one local mock server  
10. AI Elements thin chat shell (demo only)  
11. A2A: literature review only unless partner demand appears  

---

## Uncertainty register

| Item | Uncertainty | Resolution action |
| --- | --- | --- |
| LangSmith JS OTEL parity | Weaker/less clear than Python | Spike: export LangGraph JS spans to Collector + LangSmith OTLP |
| `@ai-sdk/policy-opa` maturity | Convenient but may be early | Prefer Forge `PolicyPort` wrapping opa-wasm; treat AI SDK helper as optional |
| MCP 2026-07-28 ecosystem lag | Many servers on older rev | Require compatibility test matrix in ADR-009 |
| A2A TS SDK readiness | Spec v1.0 exists; SDK depth varies | Re-evaluate when external agent facade is scheduled |
| Exact BullMQ version pin | 5.x line moving | Pin in monorepo; avoid blog-only version claims in ADRs |
| LangGraph JS feature parity | Platform/Agent Server features may be Python-first | Constrain Forge to OSS JS APIs used in spikes |

---

## Sources (primary)

- LangGraph JS checkpointers / HITL / functional API — docs.langchain.com (`oss/javascript/langgraph/*`)
- LangSmith observability concepts & SDK — docs.langchain.com/langsmith, npm `langsmith`
- BullMQ — docs.bullmq.io
- AI SDK 5 — ai-sdk.dev, vercel.com/blog/ai-sdk-5
- AI Elements — elements.ai-sdk.dev, github.com/vercel/ai-elements
- OpenTelemetry JS — opentelemetry.io/docs/languages/js
- OpenFeature JS — openfeature.dev, `@openfeature/server-sdk`
- OPA — openpolicyagent.org, `@open-policy-agent/opa-wasm`, `@open-policy-agent/opa`
- MCP — modelcontextprotocol.io / blog posts for 2026-07-28; github.com/modelcontextprotocol/typescript-sdk
- A2A — a2a-protocol.org (v1.0)
- Zod 4 — zod.dev/v4, github.com/colinhacks/zod

---

## Next artifact

Produce individual ADRs under `docs/adr/` (or `docs/00x-*.md` per master spec layout) starting with **ADR-001…ADR-008** before any implementation package scaffolding.
