# 017 — Vision Validation

**Status:** Handbook (normative before Phase 1 implementation)

## The six-month test

If Forge succeeds, a team can submit a sufficiently defined request through CLI or API and receive a durable, evidence-linked, policy-controlled workflow that researches, changes an approved repository in an isolated sandbox, runs deterministic validation and judges, waits for exact human approval, and produces a reviewable artifact. The same workflow later accepts Jira, Slack, or Buzz intake without changing its business logic.

Forge is not an AI framework or a long-running chatbot. **The workflow owns the work; agents perform bounded compute.**

## Traceability rule

Every package, dependency, abstraction, and feature must name which assertion below it enables. If it enables none, defer it.

| Assertion | Required proof |
|---|---|
| Clients trigger, never implement, workflows | CLI/API/Jira/Slack/Buzz normalize to one `WorkflowRequest` |
| Workflow state is durable | restart and follow-up resume retain workflow/artifact identity |
| AI is bounded compute | provider session is capability-limited, ephemeral, and replaceable |
| Engineering outcomes are objective | tests, lint, judges, review artifact, and unchanged unauthorized paths |
| Governance is real | denial, exact-operation approval, audit, redaction, and sandbox isolation tests |
| Extensions are real | Acme, Gusto, and Buzz run without core imports |

## Phase −1 exit criteria

- [ ] Every Phase 1–7 deliverable maps to one six-month assertion.
- [ ] The flagship demo has happy, denial, follow-up, restart, and recovery paths.
- [ ] Existing ADRs either support the flagship demo or are amended before coding.
- [ ] The status table labels every capability **Implemented**, **Experimental**, **Research**, or **Vision**.
- [ ] A contributor can explain Forge’s boundary with Buzz, LangGraph, BullMQ, providers, and company extensions from this document alone.

## Flagship V1 story: ticket-to-reviewed-change

```text
CLI/API -> Intake Gateway -> Discovery -> Engineering Brief -> approval
       -> sandbox + worktree -> Claude/Codex provider -> deterministic tests
       -> judges + review artifact -> exact human approval -> PR-ready artifact
```

The first implementation uses CLI/API only. Jira, Slack, and Buzz are later thin adapters. A workflow ID, trace ID, provider-session reference, sandbox ID, artifact IDs, and git SHA link every stage.

## First-class status table

| Status | Meaning |
|---|---|
| Implemented | verified by a passing automated acceptance test |
| Experimental | runnable but not a production exit criterion |
| Research | evidence exists; no implementation commitment yet |
| Vision | intended direction; no implementation claim |
