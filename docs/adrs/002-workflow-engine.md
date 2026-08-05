# ADR-002: Workflow engine (LangGraph behind port)

- **Status:** Accepted · **amended 2026-08-05** — the port is implemented, the vendor is not  
- **Date:** 2026-08-02  
- **Evidence:** `PACKAGE-EVIDENCE.md`, `TECH-STACK-RESEARCH.md`

## Context

Forge needs durable HITL, checkpoint/resume, and compiled graphs without exposing engine APIs.

## Decision

- Use **`@langchain/langgraph@^1.4.x`** as the **internal** graph engine.  
- Public runtime speaks `GraphEnginePort` + opaque `EnginePlan` only.  
- Production checkpointer: Postgres (`@langchain/langgraph-checkpoint-postgres`); MemorySaver for unit tests.  
- Compiler lowers Forge IR → LangGraph inside `@forge/adapters-langgraph` only.

## Consequences

- Strong HITL/`interrupt` story; migration cost if abandoning LangGraph later (IR isolates).  
- Never re-export LangGraph types from `@forge/sdk`.

## Alternatives considered

Temporal (heavier ops), custom state machine (reinvent), Inngest (weaker agent HITL).

---

## Amendment 2026-08-05: `@forge/engine-memory` is the engine

`GraphEnginePort` exists and is honoured. What sits behind it is
`@forge/engine-memory`, written in this repository, not LangGraph.

This was originally a stand-in "so the runtime can be built and proven against
the port before that adapter lands". The adapter has not landed, and the reason
to stop waiting is that the engine is no longer a graph walker. It now carries:

- **sandbox scoping** — a `sandbox` node leases an environment for the nodes
  reachable from it, and the rest of the pending work is walked first, outside
  the lease;
- **verdict and branch routing** — one arm survives, the others are pruned, and
  a verdict with no arm stops the run rather than falling through;
- **the data plane's short-circuit** — a node whose value is already pinned is
  not re-invoked, which is what makes a resumed run reproduce rather than
  re-decide.

Those are Forge's safety properties, not execution mechanics. Reimplementing
them inside a vendor's execution model would move the invariants somewhere this
repository's tests cannot reach, and the tests are the reason the properties
hold at all.

**The port stays.** `EnginePlan` is still opaque and the runtime still talks
only to `GraphEnginePort`, so a vendor engine remains possible. Revisit if a
workflow needs something the in-repo engine genuinely cannot express — a
requirement, not a preference for a named library.

**What is given up:** LangGraph's checkpointing, its ecosystem, and any
familiarity a new contributor brings. Forge checkpoints through
`CheckpointStorePort` and `RunStorePort` instead, which is where the durable
resume already lives.
