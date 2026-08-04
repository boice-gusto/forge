# ADR-002: Workflow engine (LangGraph behind port)

- **Status:** Accepted  
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
