# Research: Prompt Architecture

**Feeds:** `003`, `007`, `009`, constitution  
**Status:** Phase 0 research  
**Principle:** Prompts are versioned assets. Never random strings. Prompts never grant permissions.

---

## Verdict

Prompts are **typed, versioned, content-addressed assets** registered in manifests. The compiler binds prompt refs into IR. Runtime loads by `(promptId, version)` only. Capability expansion via prompt text is forbidden — policy owns allow/deny.

---

## Model

```ts
// Conceptual — public @forge/manifest
definePrompt({
  id: "benefits.explain-enrollment",
  version: "1.2.0",
  description: "Explain enrollment options",
  input: PromptInputSchema,   // Zod
  output: PromptOutputSchema, // Zod (structured when possible)
  template: { kind: "text", body: "..." }, // or multipart / messages[]
  metadata: { owner: "benefits", risk: "low" },
});
```

| Rule | Normative |
|------|-----------|
| Identity | `id` + semver `version`; immutable once published |
| Storage | Company/example package `prompts/`; core ships only generic library prompts |
| Binding | Workflows reference `promptRef: { id, versionRange }` — compiler pins exact version into artifact |
| Variables | Typed input schema only; no free-form string concat of secrets |
| Structured output | Prefer Zod-validated JSON; reject on safeParse fail |
| Localization | Optional locale variants as sibling assets, same id namespace |
| Evaluation | Dataset + judge refs optional in metadata (see judges research) |

---

## Never

- Inline magic prompt strings in runtime/adapters  
- Prompt text that claims elevated tools/capabilities  
- Unversioned “latest” in production (dev-only flag)  
- Logging full prompts with secrets — redaction via observability adapter  

---

## Alternatives considered

| Approach | Why reject for Forge |
|----------|----------------------|
| Prompts only in LangSmith Hub | Couples core to LangSmith; use as optional sync sink |
| Free-form string templates | Breaks typing, versioning, audit |
| Prompt = policy | Violates “policies before permissions” |

---

## Acceptance (for handbook / Phase 2+)

1. Architecture test fails if `apps/*` or adapters contain unversioned prompt literals for product flows.  
2. Compiler error if workflow refs unresolved prompt.  
3. Demo shows prompt bump `1.2.0` → `1.3.0` requires recompile / new artifact fingerprint.  
