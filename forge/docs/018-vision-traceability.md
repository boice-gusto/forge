# 018 — Vision Traceability Matrix

**Status:** Phase −1 exit artifact

**Purpose:** Each planned capability must justify itself against the six-month Forge outcome: a governed CLI/API request becomes a durable, reviewable engineering change without coupling workflow logic to its intake client.

| Six-month assertion | Phase | Package/surface | Acceptance proof |
|---|---:|---|---|
| Clients trigger, never implement, workflows | 1–2 | `types`, `intake`, API, CLI | CLI/API parse to the same `WorkflowRequest` |
| Workflow state survives interruption | 2–3 | runtime, checkpoints, approvals | worker restart and follow-up resume preserve run identity |
| Agents are replaceable bounded compute | 2 | private provider adapters | mock, Claude CLI, and Codex CLI conform to one event contract |
| Code execution is constrained | 2 | sandbox profiles/worktree/Docker | denied host env/path/network action has no effect |
| Quality is evidence, not a claim | 3 | validation, judges, artifact store | test/lint/judge/review artifacts link to one run |
| Humans control sensitive effects | 3 | policy, approvals, audit | rejection/expiry produces zero protected side effects |
| A company extends rather than forks | 4–6 | `forge.acme`, `forge.gusto` | same runtime passes Acme and Gusto scenarios |
| External collaboration remains a thin adapter | 8 | `forge.buzz`, Jira, Slack adapters | unchanged workflow starts from each normalized intake |
| Operators can explain real state | 1–7 | health, events, UI, OTel | requested/granted/observed state and correlated IDs are visible |

## Flagship acceptance contract

`engineering-feature` has these mandatory paths before V1 is claimed:

1. CLI and API requests return one idempotent workflow ID after Zod validation.
2. Incomplete requests run read-only discovery/remediation, never implementation.
3. Approved work provisions a declared sandbox/worktree and starts a private provider session.
4. The workflow records tests, judges, changed-file evidence, review packet, and artifact hashes.
5. A follow-up message resumes the same workflow/session context and emits a new patch version.
6. A secret/path/network attack is denied and redacted without crashing the worker.
7. A parameter-bound approval survives restart and protects publish/PR operations.
8. Bounded repair ends in a clear implementation or infrastructure failure, never an infinite loop.

## Explicit deferrals

- Jira, Slack, and Buzz connectors wait for the CLI/API flagship contract.
- Direct provider APIs, ACPX mesh, MCP server, A2A, visual workflow authoring, marketplace, and managed microVMs are not Phase 1 scope.
- BullMQ and multi-process workers wait until the in-memory contract demonstrates the required dispatch semantics.
