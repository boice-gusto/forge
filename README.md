# Forge

Forge is a typed engineering-workflow platform. It compiles versioned workflow assets into deterministic execution: policy, durable state, sandboxes, queues, approvals, artifacts, and observability surround bounded AI work.

**The workflow owns the work; agents perform bounded compute.**

## Start here

Read the [Master Specification](./docs/MASTER_SPEC.md) before writing product code. It links the handbook, accepted ADRs, research evidence, Phase −1 vision validation, and the phased implementation plan.

Current status: **phases 0–8 built**. [`docs/STATUS.md`](./docs/STATUS.md) is
the ledger — what exists, what does not, and why. Where it and the phase plan
disagree, STATUS.md is the one that was checked against the repository.

## Repository family

| Repository | Owns | Must not own |
|---|---|---|
| `forge` | public contracts, compiler, runtime, policy, approvals, sandbox/queue/provider ports, control-plane UI | company workflows or connector-specific implementation |
| [`forge.acme`](./forge.acme/) | fake-company workflows, prompts, policies, fixtures, themes, acceptance demos | Forge internals |
| [`forge.gusto`](./forge.gusto/) | Gusto workflows, policies, prompts, service catalog, sandbox profiles | Forge framework code |
| [`forge.buzz`](./forge.buzz/) | Buzz intake/identity/progress/artifact translation and Buzz E2E | workflow durability, provider execution, sandbox lifecycle, generic policy |

Extensions depend on public Forge SDKs only. Forge never imports an extension. See [ADR-008](./docs/adrs/008-extension-repository-topology.md).

## Flagship V1 proof

```text
CLI/API -> WorkflowRequest -> discovery brief -> approval -> sandbox/worktree
        -> Claude or Codex CLI -> tests + judges -> PR-ready artifact
```

The proof includes follow-up resume, a denied security action, human approval, and worker-restart recovery. Jira, Slack, and Buzz are later thin intake/artifact adapters; they do not change workflow logic.

## Principles

- Compile, do not configure.
- Deterministic infrastructure, intelligent execution.
- Policies before permissions; humans approve sensitive effects.
- Extension over replacement and adapters at every boundary.
- Zod safe parsing, strong TypeScript, versioned prompts/assets, and observable identity.
- Research before implementation.

## Development status

This parent workspace is the Forge Git repository. The extension folders are independent Git repositories and are intentionally ignored here. See the [phased plan](./docs/superpowers/plans/2026-08-02-forge-phased-program.md) for the next executable work.

---

# Forge (core)

Generic AI workflow runtime and SDKs.

## Specification (Phase 0)

| Doc | Path |
|-----|------|
| **Master spec** | [`docs/MASTER_SPEC.md`](./docs/MASTER_SPEC.md) |
| Handbook | [`docs/000-overview.md`](./docs/000-overview.md) … [`016-demo-scenarios.md`](./docs/016-demo-scenarios.md) |
| ADRs | [`docs/adrs/`](./docs/adrs/) |
| Research | [`docs/research/`](./docs/research/) |

Agent guidelines: [`AGENT.md`](./AGENT.md) / [`CLAUDE.md`](./CLAUDE.md).

## Packages

`ls packages` is the map. [004-architecture.md](./docs/004-architecture.md)
describes the intended layering, and names several packages that were never
built under those names — the layering held, the names did not. Read the
directory, not the document, for what exists.
