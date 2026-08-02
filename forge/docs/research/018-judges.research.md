# Research: Judge Architecture

**Feeds:** `006`, `009`, `013`, `016`  
**Status:** Phase 0 research  
**Principle:** Deterministic infrastructure. Intelligent execution. Humans own final decisions on high-risk paths.

---

## Verdict

A **judge** is a typed evaluation step that scores or classifies an artifact (draft, PR risk, invoice anomaly). Judges may use LLMs **or** deterministic rules. Their output is structured (`JudgeResult`), never a permission grant. High-risk outcomes route to `ApprovalPort`.

---

## Taxonomy

| Kind | Example | Engine |
|------|---------|--------|
| Deterministic | Schema compliance, regex PII scan, policy simulation | Pure functions / OPA |
| Heuristic | Risk score from static signals | Typed scoring function |
| LLM judge | Quality rubric over draft | ProviderPort + versioned prompt |
| Ensemble | Weighted combine | Compiler IR `JudgeEnsemble` node |

---

## Contract

```ts
type JudgeResult = {
  judgeId: string;
  version: string;
  verdict: "pass" | "fail" | "review";
  score?: number; // 0..1
  reasons: string[];
  evidence: Record<string, unknown>; // Zod-validated per judge
  recommendedAction?: "approve" | "reject" | "escalate";
};
```

**Normative:**

1. `verdict: "review"` or `recommendedAction: "escalate"` → runtime opens approval gate when policy requires.  
2. LLM judges use versioned prompts; temperature/model pinned in skill/judge manifest.  
3. Judges cannot call side-effect tools.  
4. Fail closed: judge error → `review` + escalate, never silent pass.

---

## IR placement

Compiler emits `JudgeNode` after produce steps and before side-effect / merge / publish nodes. Policies may force a judge even if workflow omits one (company policy pack).

---

## Alternatives

| Approach | Tradeoff |
|----------|----------|
| Only human review | Too slow for low-risk |
| Only LLM self-grade | Gaming / injection risk — pair with deterministic checks |
| External eval SaaS only | OK as sink; Forge still owns gate |

---

## Demo hooks

- Acme A2 invoice anomalies: deterministic + LLM judge → approval  
- Gusto G1 benefits: escalation judge before human  
