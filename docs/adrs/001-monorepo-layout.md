# ADR-001: Monorepo layout

- **Status:** Accepted  
- **Date:** 2026-08-02  
- **Evidence:** `docs/research/004-006-007-architecture-runtime-compiler.md`, `016-company-customization-and-demos.md`

## Context

Parent folder `/Volumes/BlackBox/GitHub/forge` currently holds sibling scaffolds `forge/` and `forge.gusto/` with no package manager. We need a layout that keeps core extendable without forks.

## Decision

1. Treat **parent** `/Volumes/BlackBox/GitHub/forge` as the **pnpm workspace root** (initialize when scaffolding).  
2. Core packages live under `forge/packages/@forge/*` (or flatten to `packages/@forge/*` at root — **choose root `packages/` + `apps/` + `examples/`** with handbook docs remaining in `forge/docs/` during transition, then migrate docs to root `docs/` once git exists).  
3. **Interim (this Phase 0 handbook pass):** Keep handbook at `forge/docs/` as RAW specifies; document target layout in `004-architecture.md`:

```
forge/                    # workspace root (future)
├── packages/@forge/*
├── apps/{api,worker,ui}
├── examples/acme/*
├── forge.gusto/          # company package (depends on @forge/*)
└── docs/                 # 000–016 + MASTER_SPEC + adrs + research
```

4. `forge.gusto` depends on `@forge/*`; core never imports `forge.gusto` or `examples/*` (dependency-cruiser).

## Consequences

- Single lockfile, shared tooling (Biome/Vitest patterns from SimPill).  
- Company customization is a package, not a fork.  

## Alternatives considered

| Alt | Why not |
|-----|---------|
| Two independent repos only | Harder shared CI / versioning |
| Core vendors company code | Violates extension-over-replacement |
