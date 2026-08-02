# Forge

Forge is a typed engineering-workflow platform. It compiles versioned workflow assets into deterministic execution: policy, durable state, sandboxes, queues, approvals, artifacts, and observability surround bounded AI work.

**The workflow owns the work; agents perform bounded compute.**

## Start here

Read the [Master Specification](./forge/docs/MASTER_SPEC.md) before writing product code. It links the handbook, accepted ADRs, research evidence, Phase −1 vision validation, and the phased implementation plan.

Current status: **Phase −1 / Phase 0 documentation and decisions**. Runtime code has not started.

## Repository family

| Repository | Owns | Must not own |
|---|---|---|
| `forge` | public contracts, compiler, runtime, policy, approvals, sandbox/queue/provider ports, control-plane UI | company workflows or connector-specific implementation |
| [`forge.acme`](./forge.acme/) | fake-company workflows, prompts, policies, fixtures, themes, acceptance demos | Forge internals |
| [`forge.gusto`](./forge.gusto/) | Gusto workflows, policies, prompts, service catalog, sandbox profiles | Forge framework code |
| [`forge.buzz`](./forge.buzz/) | Buzz intake/identity/progress/artifact translation and Buzz E2E | workflow durability, provider execution, sandbox lifecycle, generic policy |

Extensions depend on public Forge SDKs only. Forge never imports an extension. See [ADR-008](./forge/docs/adrs/008-extension-repository-topology.md).

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

This parent workspace is the Forge Git repository. The extension folders are independent Git repositories and are intentionally ignored here. See the [phased plan](./forge/docs/superpowers/plans/2026-08-02-forge-phased-program.md) for the next executable work.
