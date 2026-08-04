# Research Notes → `006-runtime.md` (partial)

**Status:** Phase 0 research (not an ADR)  
**Date:** 2026-08-02  
**Scope:** Runtime wiring of providers, sandboxes, worktrees, and human approval gates  
**Companion research:** `008-provider-sdk.md`, `010-sandbox.md`  
**Out of scope here:** LangGraph deep-dive, BullMQ deep-dive, full observability (separate research items)

---

## Forge runtime principles (inputs)

- Deterministic infrastructure; intelligent execution  
- Humans own the final decision — AI recommends, humans approve  
- Never let LLMs bypass deterministic gates  
- Never expose LangGraph / BullMQ / Claude / ACPX / Firecracker publicly  
- Compile workflows; don’t hand-wire engine graphs in company code  

---

## 8. Human-in-the-loop (HITL) approval patterns

| Dimension | Finding |
|-----------|---------|
| **What it is** | Pause an agent/workflow before irreversible or high-risk actions; collect human approve / reject / edit; resume with durable state. Industry patterns: tool-call review, output validation, explicit clarification, time-travel/branch from checkpoint. |
| **Maturity** | **Mature pattern**; LangGraph’s `interrupt()` + checkpointer + `Command(resume=…)` is a well-documented reference implementation (2024–2026). Same shape appears in Temporal signals, Cadence, custom job state machines. |
| **TS/Node integration** | LangGraph JS supports interrupts/checkpointers; alternatively implement Forge-owned `ApprovalGate` on top of a durable queue + DB. Either way, **durable persistence is mandatory**. |
| **When to use** | Before merge/push, external side effects (Jira/Slack/email), spend/cost thresholds, production deploys, policy-flagged tool calls. |
| **Alternatives** | Sync CLI confirm (dev only); always-auto with audit (unsafe for Forge constitution); out-of-band ticket approval with webhook resume. |
| **Forge recommendation** | **First-class `ApprovalPort` in core runtime**, not a LangGraph leaky abstraction. Internally may compile to LangGraph interrupts — publicly: Forge approval APIs only. |

### HITL patterns Forge should support

| Pattern | Behavior | Typical use |
|---------|----------|-------------|
| **Approve / Reject** | Binary gate; reject routes to alternate node or fail | Merge PR, send message, apply migration |
| **Edit then approve** | Human amends proposed payload; agent continues with edited state | PR description, ticket fields, commit message |
| **Tool allowlist interrupt** | Auto-approve low-risk tools; interrupt on sensitive tools | `bash`, network, `gh`, prod credentials |
| **Timeout policy** | Pending approval expires → `timeout` decision (fail / escalate / safe default) | SLA-bound BenOps workflows |
| **Async resume** | Start run → 202 + `threadId` → separate resume API from UI/Slack | Production default |

### Engineering requirements (non-negotiable)

1. **Durable checkpointer / run store** — process restart must not lose pending approvals (Postgres preferred; Redis only with persistence story).  
2. **Idempotent nodes before interrupt** — on resume, pre-interrupt code may re-run (LangGraph semantics); Forge compiler must document or enforce idempotency.  
3. **Approval records are audit events** — who, when, decision, diff of edits, policy id.  
4. **Policies before permissions** — which gates fire is decided by policy engine + capability set, never by prompt text.  
5. **TTL + escalation** — background sweeper for stale interrupts.  
6. **UI/API contract** — `ApprovalRequest` Zod schema; resume via `ApprovalDecision`; no engine-specific payload types in public API.

### Conceptual Forge API (public)

```ts
interface ApprovalPort {
  request(runId: RunId, req: ApprovalRequest): Promise<ApprovalId>
  // runtime blocks/compiles to interrupt; waiters use subscriptions or polling
}

type ApprovalDecision =
  | { kind: 'approve' }
  | { kind: 'reject'; reason: string }
  | { kind: 'edit'; patch: unknown } // validated by Zod per approval type
  | { kind: 'timeout' }
```

Runtime resumes the compiled workflow with the decision; provider/sandbox adapters are not invoked until after an approve when the gate is pre-effect.

---

## Runtime composition (providers + sandboxes + approvals)

### Layered architecture

```
┌──────────────────────────────────────────────────────────┐
│ Company manifests / plugins (Acme, Forge.gusto)          │
└─────────────────────────────┬────────────────────────────┘
                              │ compile
┌─────────────────────────────▼────────────────────────────┐
│ Workflow Compiler → Forge IR (not LangGraph-shaped)      │
└─────────────────────────────┬────────────────────────────┘
                              │
┌─────────────────────────────▼────────────────────────────┐
│ Runtime Engine (internal: may use LangGraph + BullMQ)    │
│  - Run store / checkpointer                              │
│  - Policy engine                                         │
│  - Approval gates                                        │
│  - Provider sessions                                     │
│  - Sandbox lifecycle                                     │
└───────┬─────────────────┬─────────────────┬──────────────┘
        │                 │                 │
   ProviderPort      SandboxPort      ApprovalPort
   (adapters)        (adapters)       (UI/Slack/API)
```

### Lifecycle of a coding-agent run

1. **Enqueue** workflow run (queue abstracted; BullMQ internal).  
2. **Policy** resolves capabilities (network, tools, approval requirements).  
3. **Sandbox.create** — Docker (dev) or Firecracker-backed (prod); optionally provision **git worktree** inside.  
4. **Provider.startSession** — cwd = sandbox workspace; mock or Claude adapter.  
5. Stream **ProviderEvents** → observability + optional live UI.  
6. On sensitive tool / end-of-plan → **ApprovalRequest**; engine interrupts; sandbox may pause or snapshot.  
7. Human **Approval**; on approve → continue (e.g. open PR); on reject → cleanup path.  
8. **Sandbox.destroy** + worktree cleanup (disposable default).  
9. Persist artifacts (logs, diffs, approval audit) outside the sandbox.

### Sandbox during long HITL waits

| Strategy | Pros | Cons | Recommendation |
|----------|------|------|----------------|
| Keep sandbox alive | Fast resume | Cost; stale state | Short waits only (< minutes) |
| Snapshot + restore | Good UX | Backend must support snapshots | Prefer when Firecracker/E2B available |
| Destroy + recreate from git | Cheap; simple | Loses dirty non-committed state | Default if agent commits to worktree branch |
| Hibernated worktree on host + new container | Cheap for trusted local | Weaker isolation | Local/dev |

**Forge default:** require agent to commit/checkpoint to the worktree branch before approval waits longer than a configured threshold; destroy compute; restore workspace from git on resume.

---

## How abstractions prevent vendor leak

| Concern | Wrong (leaky) | Right (Forge) |
|---------|---------------|---------------|
| Start Claude | `query()` from Agent SDK in workflow code | `provider.prompt(session, msg)` |
| Run in E2B | `Sandbox.create()` from `e2b` in plugin | `sandboxes.create(spec)` |
| Pause graph | `interrupt()` in company plugin | Declarative `needsApproval` in workflow IR / policy |
| Multi-CLI | `acpx claude ...` in scripts called by core | `provider-acp` adapter registered in DI |
| Parallel edits | Ad-hoc `git worktree` in prompts | `workspace: { kind: 'git-worktree' }` on sandbox spec |

**Constitution tests (architecture tests):**
- No imports of `@anthropic-ai/*`, `e2b`, `dockerode`, `acpx`, `@agentclientprotocol/*` outside adapter packages.  
- No LangGraph types in `packages/plugin-sdk` or company examples.

---

## Phase guidance (runtime-relevant)

| Phase | Runtime deliverables |
|-------|----------------------|
| **0** | This research + ADRs for ProviderPort, SandboxPort, ApprovalPort |
| **1** | Mock provider + Docker sandbox + in-memory/Postgres approvals; worktree helper; architecture tests |
| **2** | Claude Agent SDK adapter; resume demo; switch providers via config |
| **3+** | Firecracker-backed sandbox adapter; optional ACP provider; Slack/UI approval channels |

---

## Decision summary (runtime slice)

| Choice | Recommendation | Confidence |
|--------|----------------|------------|
| HITL as first-class port | Yes — `ApprovalPort` | High |
| Engine for interrupts | LangGraph OK **internally**; hide behind compiler | High (pending LangGraph research ADR) |
| Durable state for approvals | Postgres checkpointer / run store | High |
| Sandbox across long approvals | Destroy compute; restore from git/worktree | Medium–High |
| Provider + sandbox coupling | Runtime orchestrates; neither knows the other’s vendor API | High |

---

## Cross-links

- Full sandbox tech notes → `010-sandbox.md`  
- Full provider / ACPX / SimPill / Claude notes → `008-provider-sdk.md`  
- Still needed for complete `006-runtime`: LangGraph research, BullMQ/queue research, MCP/A2A boundaries, observability hooks  

---

## Unknowns

1. Final workflow engine choice (LangGraph vs custom) — blocked on dedicated LangGraph research.  
2. Approval UX channel priority (web UI vs Slack vs both) for Acme vs Gusto demos.  
3. SimPill identity — see `008-provider-sdk.md`.  
4. Whether Managed Agents self-hosted sandboxes (Anthropic control plane + customer workers) is a Forge deployment mode or a competitor pattern to document only.
