# 016 — Demo Scenarios

**Status:** Handbook (normative)  
**Audience:** Demo authors, QA, stakeholders, implementation agents  
**Related:** [015-phases](./015-phases.md) · [012-ui](./012-ui.md) · [013-testing](./013-testing.md) · [014-security](./014-security.md)  
**Research:** [016-company-customization-and-demos.md](./research/016-company-customization-and-demos.md)

---

## 1. Purpose

Demo scenarios are **acceptance-testable proofs** of Forge principles. Each scenario includes a user story, happy/deny paths, an acceptance checklist, and telemetry assertions. They drive Playwright/API tests tagged `@acceptance` and phase exit criteria in [015-phases](./015-phases.md).

**Two proof organizations:**

| Org | Package | Proves |
|-----|---------|--------|
| **Acme** | `examples/acme` | Generic framework — any org shape without core forks |
| **Gusto** | `forge.gusto` | Real company customization via extension package |

---

## 2. Demo design rules

Every scenario must demonstrate at least one principle:

1. Same runtime, different company package  
2. Extension over replacement (no fork)  
3. Human approval before side effects  
4. Policy deny/approve path (not prompt-controlled)  
5. Compile from manifests (no hand-wired public graphs)  
6. Provider switch (e.g. mock ↔ Claude) without workflow rewrite  

**Default CI:** mock provider only. No live LLM in acceptance pipeline.

---

## 3. Scenario index

| ID | Title | Company | Phase | Principles |
|----|-------|---------|-------|------------|
| **A1** | Campaign brief → publish | Acme / marketing | 3–4 | Compile · HITL · Adapters · Prompts |
| **A2** | Invoice anomaly review | Acme / finance | 3 | Policy > prompt · Humans decide |
| **A3** | Brand asset checklist | Acme / design | 4 | Capabilities · Read-only |
| **A4** | PR risk + merge gate | Acme / engineering | 3–4 | Resume · Approval gates |
| **A5** | Cross-domain meta demo | Acme / multi | 4 | Generic framework |
| **G1** | Member benefits inquiry | Gusto / benefits | 5 | Company pack · Policy · HITL |
| **G2** | BenOps ticket triage | Gusto / benops | 5 | Extension · Gated execution |
| **G3** | USP narrative pack | Gusto / usp | 6 | Multi-policy · Customization |
| **G4** | R&D sandbox isolation | Gusto / r-and-d | 6 | Sandbox · Prod deny |
| **G5** | Acme vs Gusto parity | Both | 6 | Same runtime |

---

## 4. Acme scenarios (`examples/acme`)

### A1 — Marketing: Campaign brief → draft assets → human approve → publish request

#### Principle(s) proven

Compile · Human approve · Adapters · Prompt assets

#### Actors

- **Marketing lead** (human approver)
- **Forge agent run** (mock provider)
- **Slack adapter** (fixture)

#### Preconditions / fixtures

- Company manifest: `examples/acme/forge.company.json`
- Domain: `marketing`
- Workflow: `marketing.campaign-brief`
- Prompt asset: `acme.marketing.draft.v1`
- Config ref: `acme.marketing.launch-channel` (fixture channel)
- Mock provider seeded with campaign brief input

#### User story

As an Acme marketing lead, I want Forge to draft a campaign brief and social copy from a product launch brief, then wait for my approval before posting a *publish request* to Slack.

#### Sequence (happy path)

1. Load Acme company manifest, domain `marketing`.
2. Compile workflow `marketing.campaign-brief`.
3. Skill: extract goals/audience from input brief.
4. Skill: draft copy using prompt asset `acme.marketing.draft.v1`.
5. Policy evaluates `external.publish` → **RequireApproval**.
6. Approval inbox shows recommendation + policy reason + exact Slack post parameters.
7. Marketing lead **approves** in UI (or API).
8. Adapter `slack.post` executes with config ref `acme.marketing.launch-channel`.
9. Run completes; audit + fixture post recorded.

#### Sequence (deny / failure path)

1. Steps 1–6 same as happy path.
2. Marketing lead **rejects** (or approval expires).
3. **No** `slack.post` adapter call.
4. Run ends with `outcome=rejected` or `outcome=expired`; audit records decision.

#### Acceptance checklist

- [ ] `forge demo acme marketing.campaign-brief` completes with mock provider
- [ ] Rejection path leaves **zero** Slack fixture calls
- [ ] Approval path records audit event + **exactly one** fixture post
- [ ] Switching provider to alternate mock mid-config still compiles/runs same workflow IR
- [ ] UI shows AI recommendation labelled as non-authoritative
- [ ] Policy reason visible before approve button enabled

#### Telemetry / audit assertions

- Spans: `forge.run.start` → `forge.policy.decide` (obligation: require approval) → `forge.approval.requested` → `forge.approval.resolved` → `forge.run.end`
- Log fields: `promptVersion=acme.marketing.draft.v1`, `policyId` present
- No secrets in logs or span attributes

#### Phase introduced

**Phase 3** (API approval); **Phase 4** (full UI + demo console)

---

### A2 — Finance: Invoice anomaly review

#### Principle(s) proven

Policies before permissions · Humans own the final decision

#### Actors

- **Finance analyst** (approver)
- **Forge agent run**

#### Preconditions / fixtures

- Domain: `finance`
- Fixture invoice set with known anomalies
- Policy: `finance.payment.initiate` → **RequireApproval** (or Deny in strict demo mode)

#### User story

As an Acme finance analyst, I want Forge to flag anomalous invoices and recommend actions, but never approve payments without a human.

#### Sequence (happy path)

1. Ingest fixture invoices.
2. Skill: classify anomalies; produce recommendation report.
3. Agent proposes `finance.payment.initiate` for flagged invoice.
4. Policy: **RequireApproval** — recommendation attached as evidence only.
5. Analyst reviews recommendation vs policy log in UI.
6. Analyst approves → payment adapter called (fixture).
7. Audit: policy decision id + prompt asset versions + approver id.

#### Sequence (deny / failure path)

1. Steps 1–4 same.
2. Skill attempts call **without** granted capability → **fail closed** before policy.
3. Or: analyst rejects → no payment adapter call.
4. Demo explicitly shows **recommendation ≠ authorization** in policy log UI/API.

#### Acceptance checklist

- [ ] Demo shows recommendation ≠ authorization (policy log / UI label)
- [ ] Attempted skill call without capability **fails closed**
- [ ] Audit trail includes policy decision id + prompt asset versions
- [ ] Model cannot skip gate via output text (gate-bypass test)

#### Telemetry / audit assertions

- `forge.policy.decide` with `allow=false` or obligation require approval before any payment span
- `forge.approval.resolved` includes `approverId`
- Event `forge.policy.deny` if capability missing

#### Phase introduced

**Phase 3**

---

### A3 — Design: Brand asset checklist + critique

#### Principle(s) proven

Capability model · Deterministic checks + intelligent critique

#### Actors

- **Designer** (consumer of report; no approval required unless extended)
- **Forge agent run**

#### Preconditions / fixtures

- Domain: `design`
- Read-only design handoff fixture
- Prompt: `acme.design.brand-rules.v1`
- **No write capabilities** granted to run

#### User story

As an Acme designer, I want Forge to check a design handoff against brand rules and produce a critique report without mutating design files.

#### Sequence (happy path)

1. Load read-only design fixture.
2. Skill: checklist against `acme.design.brand-rules.v1`.
3. Skill: generate critique report (markdown/json artifact).
4. Run completes — no side-effect adapters invoked.

#### Sequence (deny / failure path)

1. Agent or plugin attempts write adapter (e.g. `design.files.write`).
2. Policy **denies** — no capability granted.
3. Run may fail or complete with deny audit depending on workflow error policy.

#### Acceptance checklist

- [ ] Report artifact produced
- [ ] **Zero** write adapter calls in fixture telemetry
- [ ] Capability closure test in CI: workflow IR capabilities ⊆ granted set

#### Telemetry / audit assertions

- No `forge.sandbox.create` with write tools unless explicitly granted (negative test)
- `forge.policy.deny` if write attempted
- Report artifact id in run output

#### Phase introduced

**Phase 4**

---

### A4 — Engineering: PR risk summary + merge recommendation

#### Principle(s) proven

Resume · Approval gates · Same runtime as marketing

#### Actors

- **Engineering lead** (approver)
- **Forge agent run**

#### Preconditions / fixtures

- Domain: `engineering`
- Fixture PR + CI results
- Policy: `vcs.merge` → **RequireApproval**
- Mock VCS adapter + fixture store

#### User story

As an Acme eng lead, I want a PR risk summary and merge recommendation, with merge action gated by approval.

#### Sequence (happy path)

1. Load fixture PR + CI data.
2. Skills: summarize diff; map to risk rubric; produce recommendation.
3. Policy: merge requires approval — workflow **interrupts** at checkpoint.
4. Eng lead approves in UI/API.
5. **Resume** workflow; mock VCS adapter merge call.
6. Fixture store shows PR merged.

#### Sequence (deny / failure path)

1. Steps 1–3 same; checkpoint persisted.
2. Eng lead **denies** (or timeout).
3. Resume never calls merge adapter.
4. Fixture store: PR **unmerged**.
5. Worker restart mid-wait → approval still pending/resumable (durability test).

#### Acceptance checklist

- [ ] Resume-after-approval works (workflow checkpoint)
- [ ] Deny leaves PR unmerged in fixture store
- [ ] Pending approval survives worker restart (integration test)
- [ ] Same runtime binary as A1 (no domain-specific fork)

#### Telemetry / audit assertions

- Gap in spans during pending approval; linked `forge.approval.requested` / `resolved`
- `forge.run.end` with `outcome=success` only after approved merge
- Checkpoint id in run metadata (opaque; not LangGraph-shaped in public API)

#### Phase introduced

**Phase 3** (API resume); **Phase 4** (UI)

---

### A5 — Cross-domain proof (meta demo)

#### Principle(s) proven

Generic framework · Extension over replacement

#### Actors

- **Platform engineer** (operator)

#### Preconditions / fixtures

- Acme marketing + engineering domains loaded
- No imports from `forge.gusto` anywhere in run

#### User story

As a platform engineer, I want to run Acme marketing and Acme engineering workflows back-to-back on one Forge process.

#### Sequence (happy path)

1. Boot single Forge runtime (API + worker).
2. Run `marketing.campaign-brief` (A1 path, mock, approve).
3. Without restart, run `engineering.pr-risk` (A4 path, mock, approve).
4. Verify separate domain manifests, separate config refs, shared runtime.

#### Sequence (deny / failure path)

N/A — meta scenario; failure = architecture violation or shared hardcoded channel.

#### Acceptance checklist

- [ ] Single runtime boot; two domain manifests; **no shared hardcoded channels**
- [ ] Architecture test: `packages/**` ↛ `forge.gusto`
- [ ] Architecture test: `examples/acme` ↛ private core internals
- [ ] Both runs produce independent audit trails with correct `workflowId`

#### Telemetry / audit assertions

- Distinct `workflowId` per run; same `service.name` / process
- Company id = `acme` for both

#### Phase introduced

**Phase 4**

---

## 5. Gusto scenarios (`forge.gusto`)

### G1 — Benefits: Member question → grounded answer → escalate if low confidence

#### Principle(s) proven

Company package · Policy > prompt · Human approve

#### Actors

- **Benefits specialist** (approver)
- **Forge agent run**

#### Preconditions / fixtures

- Company: `forge.gusto`; domain: `benefits`
- Workflow: `benefits.member-inquiry`
- Policy packs: `benefits-data`, `pii`, `human-approval-defaults`
- Fixture member inquiry (regulated + benign variants)
- Approved KB fixtures only

#### User story

As a Benefits specialist, I want Forge to draft an answer to a member benefits question using approved knowledge sources, cite sources, and escalate to a human when confidence or policy requires it.

#### Sequence (happy path)

1. Load Gusto company + benefits domain.
2. Skills: retrieve approved KB; draft answer with citations; classify sensitivity.
3. Benign inquiry → may complete without send, or low-risk path per policy.
4. Regulated topic → policy `benefits.advice.regulated` → **RequireApproval**.
5. Specialist approves → `member.message.send` side effect (fixture).

#### Sequence (deny / failure path)

1. Regulated topic triggers approval requirement.
2. Specialist rejects → no message sent.
3. **Prompt injection attempt** in inquiry cannot grant `member.message.send` if policy denies — fail closed test.

#### Acceptance checklist

- [ ] Fixture member inquiry produces **cited** draft
- [ ] Regulated topic forces approval (policy id asserted in test)
- [ ] Prompt cannot grant `member.message.send` if policy denies
- [ ] Runs on **same binary/runtime** as Acme demos
- [ ] Zero Gusto domain logic in `packages/@forge/*`

#### Telemetry / audit assertions

- `forge.policy.decide` references Gusto policy pack version
- Citations in artifact metadata, not raw PII in spans
- `environment` ≠ research unless explicitly R&D domain

#### Phase introduced

**Phase 5**

---

### G2 — BenOps: Operational ticket triage → recommended runbook → gated execution

#### Principle(s) proven

Extension · Deterministic infrastructure · Intelligent triage

#### Actors

- **BenOps operator** (approver)
- **Forge agent run**

#### Preconditions / fixtures

- Domain: `benops`
- Ticket fixture (pager/Jira-shaped via adapter)
- Runbook fixture with N write steps
- Config: batch vs per-step approval (document chosen mode)

#### User story

As a BenOps operator, I want Forge to triage an ops ticket, recommend a runbook, and execute only the approved steps.

#### Sequence (happy path)

1. Ingest ticket fixture.
2. Skill: classify severity; match runbook.
3. Workflow expands runbook steps; write effects gated per policy.
4. **Dry-run mode:** zero write adapters (demo mode flag).
5. Operator switches to execute mode; approves step batch (or all).
6. Approved steps execute against fixtures; remainder cancelled with audit.

#### Sequence (deny / failure path)

1. **Partial approve:** subset of steps runs; unapproved steps **cancelled** with audit reason.
2. **Dry-run:** assert zero writes throughout.

#### Acceptance checklist

- [ ] Dry-run mode executes **zero** write adapters
- [ ] Approve-all executes N fixture writes matching runbook
- [ ] Partial approve executes subset; remaining cancelled with audit
- [ ] Each write preceded by `forge.policy.decide` + approval if required

#### Telemetry / audit assertions

- Count of adapter write spans = approved step count
- Cancelled steps logged with `reason=not_approved`

#### Phase introduced

**Phase 5**

---

### G3 — USP: Product narrative pack → brand/legal approval

> **Naming note:** Gusto domain `usp` is a first-class package; workflows may be refined with stakeholders. Demo models **product/positioning + GTM support** requiring brand/legal approval before external publish. Internal org-unit naming can swap without changing the configuration model.

#### Principle(s) proven

Company customization · Multi-policy packs · Extension

#### Actors

- **USP stakeholder** (approver)
- **Legal/brand reviewer** (optional second role — document if quorum deferred)
- **Forge agent run**

#### Preconditions / fixtures

- Domain: `usp` manifest + plugins
- Internal source fixtures (claims, product data)
- Policies: `external.publish`, `claims.regulated`
- Publish adapter fixtures (external channel)

#### User story

As a USP stakeholder, I want Forge to assemble a product narrative pack from internal sources and route it through brand/legal approval before any external channel publish.

#### Sequence (happy path)

1. Load sources; skills synthesize narrative, extract claims, flag unverified claims.
2. Unverified claims flagged in artifact — blocked from publish list.
3. Policy: external publish + regulated claims → **RequireApproval**.
4. Stakeholder approves; publish adapter posts to fixture channel.

#### Sequence (deny / failure path)

1. Unverified claim detected → blocked or forced human review (no auto-publish).
2. Reject approval → zero publish adapter calls.

#### Acceptance checklist

- [ ] Unverified claim → blocked or forced human review
- [ ] Approval records role + **policy pack version**
- [ ] Zero Gusto logic in `forge/` core (import boundary test)
- [ ] Multi-policy evaluation visible in approval UI (both publish + claims)

#### Telemetry / audit assertions

- `forge.policy.decide` may emit multiple decisions or compound obligation
- `policyPackVersion` in audit record

#### Phase introduced

**Phase 6**

---

### G4 — R&D: Research experiment in sandbox with prod isolation

#### Principle(s) proven

Policies · Adapters · Sandbox boundary

#### Actors

- **R&D engineer**
- **Forge agent run**

#### Preconditions / fixtures

- Domain: `r-and-d`
- Policy pack: `research-sandbox`
- Adapter registry: **mock/sandbox bindings only** for this domain
- Prod adapter bindings exist globally but must be unreachable

#### User story

As an R&D engineer, I want to run experimental agent workflows in a sandbox that cannot touch production adapters.

#### Sequence (happy path)

1. Start experiment workflow in R&D domain.
2. Skills run against mock adapters; sandbox obeys research policy pack.
3. Run completes; telemetry marks research environment.

#### Sequence (deny / failure path)

1. Workflow or agent attempts **prod** adapter binding (e.g. real Slack, prod DB).
2. Policy/capability layer → **Deny** with structured error.
3. No side effects on prod fixtures.

#### Acceptance checklist

- [ ] Prod adapter invocation **fails closed** with structured error
- [ ] Experiment workflow completes against mocks
- [ ] Telemetry marks `environment=research` (or equivalent attribute)
- [ ] Sandbox negative tests pass for this domain (see [013-testing](./013-testing.md))

#### Telemetry / audit assertions

- `forge.policy.deny` on prod binding attempt
- `forge.sandbox.create` with tier appropriate to research
- No prod `tenantId` in research run attributes

#### Phase introduced

**Phase 6**

---

### G5 — Parity demo: Acme vs Gusto on one runtime

#### Principle(s) proven

Same runtime, different manifests + plugins (north-star claim)

#### Actors

- **Principal engineer / evaluator**

#### Preconditions / fixtures

- Both `examples/acme` and `forge.gusto` packages built
- Demo console or CLI

#### User story

As a principal engineer evaluating Forge, I want to see Acme marketing and Gusto BenOps run from the same Forge installation, differing only by company package.

#### Sequence (happy path)

1. `forge run --company acme --workflow marketing.campaign-brief` (mock, approve).
2. `forge run --company gusto --workflow benops.ticket-triage` (mock, dry-run or approve).
3. Demo UI/CLI shows **diff of loaded manifests** (domains, plugins, policy packs).
4. No core restart beyond documented company hot-load rules (or single process throughout).

#### Sequence (deny / failure path)

N/A — failure = requires separate runtime binary or core rebuild on company switch.

#### Acceptance checklist

- [ ] Acme marketing workflow completes
- [ ] Gusto BenOps workflow completes
- [ ] Manifest diff visible in demo UI or CLI output
- [ ] No restart of core required beyond documented company load (or hot-load ADR satisfied)
- [ ] Single OTEL service identity; distinct `companyId` per run

#### Telemetry / audit assertions

- Two `forge.run.*` traces with different `companyId` / `workflowId`
- Shared process metrics unchanged between runs

#### Phase introduced

**Phase 6**

---

## 6. CLI & demo commands (normative targets)

```bash
# Acme
forge demo acme marketing.campaign-brief
forge run --company acme --workflow finance.invoice-review
forge run --company acme --workflow engineering.pr-risk

# Gusto
forge run --company gusto --workflow benefits.member-inquiry
forge run --company gusto --workflow benops.ticket-triage

# Parity (G5)
forge demo parity --acme marketing.campaign-brief --gusto benops.ticket-triage
```

Exact CLI spelling ADR-bound in `@forge/cli`; acceptance tests may use HTTP API equivalents.

---

## 7. Test harness requirements

| Layer | Tool | Scenarios |
|-------|------|-----------|
| API acceptance | Vitest + fetch | A2, A3, G4 deny paths |
| UI acceptance | Playwright | A1, A4, G1, G2, G5 |
| Architecture | depcruise + Vitest | A5, G3, G5 import boundaries |
| Telemetry | OTEL in-memory / test exporter | All scenarios § telemetry |

Tag: `@acceptance` `@demo`. Run full suite on `main` + nightly; PR subset: A2 + compiler smoke minimum.

---

## 8. Fixture & data rules

- Fixtures live in `examples/acme/fixtures` and `forge.gusto/fixtures`.
- No real member PII, production credentials, or live API keys.
- Fixture adapter responses are deterministic (seeded).
- Company-specific channel/repo/Jira IDs are **config refs**, never hardcoded in core.

---

## 9. Phase rollout summary

| Phase | Scenarios expected green |
|-------|--------------------------|
| 3 | A2 (+ A1 API path) |
| 4 | A1, A3, A4, A5 |
| 5 | G1, G2 |
| 6 | G3, G4, G5 |
| 7 | Full suite on staging |

---

## 10. Handbook exit criteria

This document is **done** when:

- [ ] All ten scenarios have user story, sequences, checklist, telemetry section.
- [ ] [015-phases](./015-phases.md) references this index.
- [ ] [013-testing](./013-testing.md) acceptance harness covers each scenario.
- [ ] Stakeholders can run Phase 4+ demo from checklist without engineer assistance.
