# ADR-007: Policy engine (OPA Wasm)

- **Status:** Accepted · **Implemented** 2026-08-05 (`@forge/policy-opa`)  
- **Date:** 2026-08-02  
- **Evidence:** `014-security.research.md`, `TECH-STACK-RESEARCH.md`

## Decision

- Capability / tool / approval authorization uses **OPA Wasm** (`@open-policy-agent/opa-wasm`) behind `PolicyPort`. Rego is compiled to WebAssembly ahead of time and the module is committed, so the `opa` binary is a developer dependency and sits on no test or CI path.
- Rules and grants reach the module as **data**, never as policy language. A company pack supplies data; it does not author Rego (009 §11).
- **Fail closed** on errors, including a module returning a decision Forge does not recognise. A company may ship its own compiled bundle, so the adapter validates the shape of what comes back rather than trusting it.
- **OpenFeature** is for rollout flags only — never sole authz.
- Held to all of the above by `@forge/policy-conformance`, which every `PolicyPort` implementation answers.

### Amendment, 2026-08-05 — the request shape

The sketch above read `{ principal, action, resource, context } → { allow, obligations[] }`. What shipped is:

```
PolicyRequest { actor, action, environment, capabilities }
  → PolicyDecision = allow | deny | require-approval
```

`require-approval` **is** the obligation, so a separate list buys nothing. More
importantly there is deliberately **no `resource` and no free-text `context`**: a
field carrying workflow content is a field a prompt can steer, and "a prompt
cannot override policy" is a Phase 3 exit criterion. The conformance suite
asserts it directly — a request carrying `resource`, `prompt`, `decision`,
`rules` or `grants` must decide identically to one without them.

The cost is real and worth stating: policy cannot vary by the *thing* being
acted on, only by the action, the actor, the environment and the capability
closure. A per-resource rule needs a distinct action name.

## Alternatives

Prompt-based permissions (forbidden); OpenFeature-only (insufficient).
