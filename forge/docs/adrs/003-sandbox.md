# ADR-003: Sandbox strategy

- **Status:** Accepted  
- **Date:** 2026-08-02  
- **Evidence:** `docs/research/010-sandbox.md`

## Decision

- **Local/MVP:** Docker sandbox + **git worktrees** as workspace isolation (worktrees ≠ security boundary).  
- **CI:** Testcontainers for Redis/Postgres/Docker-backed adapter tests.  
- **Prod (later):** Managed microVM (Firecracker-class / E2B-like) behind `SandboxPort`; defer self-hosted Firecracker.  
- Public API: `SandboxPort` only.

## Alternatives

Raw Firecracker self-host (ops cost); worktree-only (insufficient isolation).
