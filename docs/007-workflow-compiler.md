# 007 — Workflow Compiler

**Status:** Handbook (normative)  
**Date:** 2026-08-02  
**Related ADRs:** [002-workflow-engine](./adrs/002-workflow-engine.md)  
**Principles:** Compile. Don't Configure. · Deterministic Infrastructure. Intelligent Execution.

---

## 1. Purpose

The Forge **workflow compiler** is a **pure, deterministic** program that lowers typed authoring manifests into sealed execution artifacts. Authors declare workflows with `defineWorkflow`; they never hand-wire LangGraph nodes, BullMQ jobs, or provider calls in company code.

```
WorkflowManifest (Zod)
        │
        ▼
   Validate + resolve refs (prompts, skills, policies)
        │
        ▼
   Forge IR (engine-agnostic)
        │
        ▼
   CompileTargetPort.lower(ir)    ← adapters-langgraph only
        │
        ▼
   EnginePlan (opaque brand)
        │
        ▼
   CompiledWorkflowArtifact (sealed + fingerprinted)
```

The runtime loads artifacts by `workflowVersionId`; it never re-parses manifests at execution time in production.

---

## 2. Compiler vs runtime

| Concern | Compiler | Runtime |
|---------|----------|---------|
| Parse/validate manifests | ✅ | ❌ |
| Resolve prompt/skill/policy refs | ✅ | ❌ (refs bound in artifact) |
| Type-check step I/O contracts | ✅ | re-validate payloads at boundaries only |
| Build Forge IR | ✅ | ❌ |
| Lower IR → `EnginePlan` | ✅ | ❌ |
| Fingerprint / version artifact | ✅ | lookup only |
| LLM calls, queue, checkpoints | ❌ | ✅ |
| Retry / timeout enforcement | declares in IR | enforces |

### Compiler invariants

1. Same manifest bytes + same compiler version → same artifact fingerprint.
2. **No side effects** — no Redis, HTTP, LLM, filesystem writes, or clock-dependent control flow.
3. All failures are **diagnostics** with stable codes (`WF_UNKNOWN_REF`, `WF_CYCLE`, `WF_UNTYPED_EDGE`, …).
4. Compiler may depend on `ir`, `manifest`, `ports` (compile-target interface only) — never network adapters.

---

## 3. Authoring surface: `defineWorkflow`

Public API lives in `@forge/manifest`. Authors write typed workflow definitions; the compiler is the only path to a runnable graph.

`defineWorkflow` takes the graph the IR and compiler actually consume — nodes and
edges — and resolves the workflow's internal references in the type system as it
is written:

```ts
import { defineWorkflow } from '@forge/manifest';

export const claimReview = defineWorkflow({
  id: 'benefits.claim-review',
  version: '1.2.0',
  sideEffects: ['claim.decide'],
  grantedCapabilities: ['claims.read'],
  roles: { adjudicator: { version: '1.0.0', capabilities: { requires: ['claims.read'], forbids: [] } } },
  nodes: [
    { id: 'intake', kind: 'input', schemaRef: 'benefits.claim@1' },
    { id: 'review', kind: 'agent', promptRef: 'benefits.adjudicate@1', role: 'adjudicator' },
    { id: 'gate', kind: 'approval', gateSchemaRef: 'benefits.decide@1', gates: ['decide'] },
    { id: 'decide', kind: 'tool', skillRef: 'benefits.decide@1', effect: 'claim.decide' },
    { id: 'result', kind: 'output', schemaRef: 'benefits.decision@1' },
  ],
  edges: [
    { from: 'intake', to: 'review' }, { from: 'review', to: 'gate' },
    { from: 'gate', to: 'decide' }, { from: 'decide', to: 'result' },
  ],
});
```

An edge to a node that does not exist, a gate naming one, a node using an
undeclared role, or a tool causing an effect missing from `sideEffects` is a
**type error here**, before the compiler runs. All of those are schema-valid, so
the type system is the only place they can be caught this early. The compiler
keeps every analysis that needs the whole graph — reachability, gate bypass,
capability closure — because `defineWorkflow` cannot see a path.

> **Not yet implemented.** A `steps: [...]` builder DSL over `skill()` /
> `approval()` / `branch()`, and `input` / `output` Zod schemas on the workflow.
> The schemas wait on a run data plane: nothing currently flows between nodes,
> so a declared input schema would validate a payload no node can read. Node
> `schemaRef`s are refs the compiler resolves, not live schemas.

**Forbidden in company/plugin code:**

- `new StateGraph()` or any LangGraph import
- `queue.add('langgraph-…')` or BullMQ types
- Inline unversioned prompt strings for product flows
- Hand-wired edges between engine nodes

Operators start runs via `@forge/sdk`:

```ts
await forge.workflows.start({ workflowId: 'benefits.claim_review', version: '1.2.0', input });
```

---

## 4. Sealed artifact

```ts
interface CompiledWorkflowArtifact {
  workflowId: WorkflowId;
  fingerprint: Sha256;
  ir: ForgeIR;                    // inspectable internally / debug UIs
}

// Not yet implemented: `workflowVersionId`, `compilerVersion`, and a carried
// `enginePlan` — the plan is materialised by the engine from the IR rather than
// sealed into the artifact, so there is one owner of it. The public surface is
// derived on demand (see `POST /v1/workflows/compile`) rather than stored;
// `inputSchema`/`outputSchema` wait on the data plane.
```

| Field | Visibility |
|-------|------------|
| `publicSurface` | SDK, UI, API responses |
| `ir` | Internal tooling, compile diagnostics, debug inspector |
| `enginePlan` | `@forge/adapters-langgraph` only — never serialized to clients |

Production mode rejects execution when `fingerprint` is missing or compiler version is incompatible. Dev may allow JIT compile (ephemeral) with explicit flag — not the production default.

---

## 5. Forge IR taxonomy

IR is a Zod-validated discriminated union of node kinds. It is **engine-agnostic** — not LangGraph-shaped.

| Kind | Deterministic? | Purpose |
|------|----------------|---------|
| `input` | yes | Validate run input against schema |
| `agent` | no | Call `ProviderPort`; typed I/O schemas |
| `tool` | mostly | Skill/tool invocation; policy-gated |
| `transform` | yes | Pure mapped function / JSONLogic-like |
| `branch` | yes | Predicate on typed state |
| `parallel` | yes | Fan-out / fan-in barrier |
| `approval` | yes (wait) | Human gate; resume payload schema |
| `policy_check` | yes | Capability assertion before privileged step |
| `sandbox` | infra | Run untrusted work via `SandboxPort` |
| `judge` | mixed | Score/classify artifact; may use LLM via provider |
| `output` | yes | Final typed result |

Edges carry `from`, `to`, optional `conditionId`. Retry, timeout, and backoff are **node policies** attached to nodes — not scattered runtime config.

### Example IR sketch

```ts
type IrNode =
  | { kind: 'input'; id: string; schemaRef: SchemaRef }
  | { kind: 'agent'; id: string; promptRef: PromptRef; input: SchemaRef; output: SchemaRef; retry?: RetryPolicy }
  | { kind: 'approval'; id: string; gateSchema: SchemaRef; onReject: 'fail' | EdgeRef; ttl?: Duration }
  | { kind: 'judge'; id: string; judgeRef: JudgeRef; onVerdict: Record<'pass'|'fail'|'review', EdgeRef> }
  | { kind: 'output'; id: string; schemaRef: SchemaRef };
```

---

## 6. Node policies

Structured config compiled into IR — runtime enforces without reinterpretation.

```ts
interface RetryPolicy {
  maxAttempts: number;
  backoff: 'fixed' | 'exponential';
  initialDelayMs: number;
  retryableErrors: ErrorCode[];
}

interface TimeoutPolicy {
  durationMs: number;
  onTimeout: 'fail' | 'retry';
}
```

Side effects must be **declared** on workflow manifests (`sideEffects[]`). Compiler enforces approval gates before side-effect nodes unless an explicit policy exemption exists (rare, audited).

---

## 7. Opaque `EnginePlan`

Do not export LangGraph `StateGraph` types from any public or shared runtime surface.

```ts
// @forge/ports
declare const EnginePlanBrand: unique symbol;
export type EnginePlan = { readonly [EnginePlanBrand]: true };

interface CompileTargetPort {
  lower(ir: ForgeIR): Result<EnginePlan, CompileDiagnostic[]>;
}
```

`@forge/adapters-langgraph` implements `CompileTargetPort`:

- Holds private registry or versioned JSON understood only by that adapter
- Maps IR `approval` nodes → LangGraph `interrupt()` + checkpointer hooks
- Maps IR retry policies → engine-level retry configuration
- Never re-exports LangGraph types upward

**Why IR, not Manifest → LangGraph directly?**

| Approach | Verdict |
|----------|---------|
| Public LangGraph config | **Reject** — violates north star |
| Manifest → LangGraph in compiler | Weak — couples compiler to vendor |
| **Manifest → IR → adapter lowering** | **Adopt** — swap/mock engine; golden tests |
| JIT IR→engine every run | Acceptable for dev; AOT artifact for prod |

---

## 8. Reference resolution

At compile time the compiler resolves and pins:

| Ref type | Resolution |
|----------|------------|
| `promptRef: { id, versionRange }` | Pin exact semver into artifact; error if unresolved |
| `skillRef` | Bind handler id + capability requirements |
| `policyPackRef` | Attach required policy evaluations |
| `judgeRef` | Bind judge definition + prompt refs |

Prompts are versioned assets — see §9. Prompt text never grants capabilities; policy packs declare authorization rules.

---

## 9. Prompt binding

Prompts are typed, versioned, content-addressed assets registered via `definePrompt` in `@forge/manifest`.

```ts
definePrompt({
  id: 'benefits.explain-enrollment',
  version: '1.2.0',
  input: PromptInputSchema,
  output: PromptOutputSchema,
  template: { kind: 'text', body: '...' },
  metadata: { owner: 'benefits', risk: 'low' },
});
```

| Rule | Normative |
|------|-----------|
| Identity | `id` + semver; immutable once published |
| Binding | Workflows reference `promptRef`; compiler pins exact version |
| Variables | Typed input schema only; no secret concat in templates |
| Structured output | Prefer Zod-validated JSON; runtime rejects on `safeParse` fail |
| Capabilities | Prompts **never** expand capability set |

Architecture test: product flows must not contain unversioned prompt literals in `apps/*` or adapters.

---

## 10. Judge nodes

A **judge** evaluates an artifact (draft, PR risk, invoice anomaly) and emits structured `JudgeResult` — never a permission grant.

```ts
type JudgeResult = {
  judgeId: string;
  version: string;
  verdict: 'pass' | 'fail' | 'review';
  score?: number;
  reasons: string[];
  evidence: Record<string, unknown>;
  recommendedAction?: 'approve' | 'reject' | 'escalate';
};
```

Compiler emits `judge` nodes after produce steps and before side-effect / publish nodes. Policies may inject mandatory judges via company policy packs.

| Kind | Engine |
|------|--------|
| Deterministic | Pure functions / OPA simulation |
| Heuristic | Typed scoring function |
| LLM judge | `ProviderPort` + versioned prompt |
| Ensemble | IR `JudgeEnsemble` combining weighted results |

Fail closed: judge error → `verdict: 'review'` + escalate — never silent pass.

---

## 11. Diagnostics catalog

All compile failures return structured diagnostics — not thrown exceptions without codes.

| Code | Meaning |
|------|---------|
| `WF_UNKNOWN_REF` | Unresolved prompt/skill/policy/judge reference |
| `WF_CYCLE` | Dependency cycle in step graph |
| `WF_UNTYPED_EDGE` | Edge missing condition on non-exhaustive branch |
| `WF_SCHEMA_MISMATCH` | Step I/O incompatible with upstream output |
| `WF_MISSING_APPROVAL` | Side-effect node without required approval gate |
| `WF_CAPABILITY_UNBOUND` | Skill requires capability not satisfiable by policy closure |
| `WF_INVALID_VERSION` | Semver or version range unsatisfiable |
| `WF_DUPLICATE_ID` | Node or step id collision |

Diagnostics include `path`, `message`, and optional `suggestion` for IDE/CLI display.

---

## 12. Compile-time vs runtime validation

| Validation | When |
|------------|------|
| Manifest schema, ref resolution, graph structure | Compile time |
| Capability closure (static) | Compile time |
| Run input / output | Runtime boundary (`safeParse`) |
| Resume payload per approval gate | Runtime boundary |
| Provider/tool output before branch | Runtime boundary |
| Policy decision for live actor | Runtime (dynamic) |

The compiler proves static properties; runtime re-validates all untrusted payloads at process boundaries.

---

## 13. Fingerprinting

```
fingerprint = sha256(
  canonicalJson(manifest)
  + compilerVersion
  + pinnedPromptVersions
  + pinnedPolicyPackVersions
  + irSchemaVersion
)
```

Same inputs → same fingerprint. Artifact store keyed by `(workflowId, workflowVersionId, fingerprint)`.

Bump `compilerVersion` when IR schema or lowering semantics change. Workers warm-cache `EnginePlan → MaterializedGraph` with LRU keyed by fingerprint.

---

## 14. Test strategy

| Layer | Tests |
|-------|-------|
| **Compiler unit** | Pure functions; golden IR fixtures; diagnostic codes; no Redis/LLM |
| **Lowering adapter** | IR fixture → materializable graph; approval interrupt mapping |
| **Integration** | Full manifest → artifact → mock runtime execute |
| **Architecture** | `compiler` ↛ adapters except `CompileTargetPort` test doubles |

Example golden test flow:

1. Check in manifest fixture `claim_review.v1.json`
2. Compile → snapshot IR JSON
3. Lower via test `CompileTargetPort` → assert node count, approval gates, capabilities

---

## 15. Workflow definition shape (company packages)

Workflows in company packages (`examples/acme`, `forge.gusto`) are data + typed nodes:

- `id`, `version`, `domain`, `inputSchema`, `outputSchema`
- `nodes[]` with kinds aligned to manifest step builders
- `sideEffects[]` explicitly declared
- `promptRefs[]` — versioned assets only
- `failurePolicy`, `timeouts`, `retries` as structured config

The compiler produces an opaque compiled workflow. Public API never exposes LangGraph types.

---

## 16. Acceptance criteria

When compiler implementation is complete for Phase 2+, **done** means:

1. **Pure compiler** — Unit tests run with zero network/Redis/LLM; same manifest + version → identical fingerprint across runs.
2. **No public graph wiring** — Workflow author can define a manifest with an approval gate without importing LangGraph; architecture test enforces.
3. **Ref resolution** — Unresolved `promptRef` emits `WF_UNKNOWN_REF`; no silent latest-version pin in production mode.
4. **Side-effect gates** — Compiler error `WF_MISSING_APPROVAL` when write side-effect lacks approval node and no policy exemption.
5. **Capability closure** — `WF_CAPABILITY_UNBOUND` when plugin skill requirements exceed static policy closure.
6. **Opaque plan** — `@forge/runtime` and `@forge/sdk` cannot import or introspect `EnginePlan` structure; TypeScript brands enforce.
7. **Golden IR** — At least three fixture workflows (linear, branch+approval, parallel+judge) have checked-in IR snapshots in CI.
8. **Prompt pin** — Bumping prompt `1.2.0` → `1.3.0` changes artifact fingerprint; runtime loads new version only after recompile.
9. **Diagnostic stability** — Diagnostic codes are stable across patch compiler releases; breaking changes bump compiler major.
10. **JIT dev mode** — Ephemeral compile flag works locally; production path requires sealed artifact with fingerprint.

---

## 17. Related documents

- [006 — Runtime](./006-runtime.md) — executes sealed artifacts; approval + checkpoint orchestration
- [009 — Plugin SDK](./009-plugin-sdk.md) — company workflows and skills fed to compiler
- [008 — Provider SDK](./008-provider-sdk.md) — agent nodes call provider at runtime, not compile time
