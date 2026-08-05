# ADR-005: Provider SDK (`@simpill/acp-llm-cli`)

- **Status:** Accepted 2026-08-02; **amended 2026-08-05** — see [Amendment](#amendment-2026-08-05-the-named-package-does-not-exist)  
- **Date:** 2026-08-02  
- **Evidence:** `PACKAGE-EVIDENCE.md`, https://github.com/SkinnnyJay/acp-llm-cli, local submodule

## Context

RAW requires provider abstraction and SimPill/ACPX research. User confirmed ACP harness is **acp-llm-cli**.

## Decision

1. Forge `ProviderPort` is implemented by private adapters.  
2. **Primary coding-agent provider path:** `@simpill/acp-llm-cli` (git/file until npm publish) wrapping Claude/Codex/Gemini/Cursor CLIs.  
3. Ship **`provider-mock`** for demos/tests.  
4. Wire `IPermissionHandler` from acp-llm-cli into Forge policy + `ApprovalPort` (never trust CLI permission alone).  
5. **ACPX** (`acpx`) is optional private mesh transport — not the Provider SDK; never public.  
6. Public SDK never imports `@simpill/acp-llm-cli` or `@agentclientprotocol/*`.

## Consequences

- Dogfoods SimPill patterns (Zod, env, logger).  
- Zod peer may be v3 — normalize at adapter boundary toward Forge Zod v4.  
- Install via `github:SkinnnyJay/acp-llm-cli` until registry publish.

## Alternatives

Direct Anthropic SDK only (less multi-CLI); ACPX-only (less typed factory).

---

## Amendment 2026-08-05: the named package does not exist

**Status:** Accepted. Supersedes decision 2 above and the alternative it rejected.

### What was found

`@simpill/acp-llm-cli` is **not published to npm**. The only way to install it is
the git reference this ADR already anticipated — `github:SkinnnyJay/acp-llm-cli#main`
— and that install is not sufficient on its own: the Claude path additionally
requires a `claude-agent-acp` binary on `PATH` and a live API key before it will
answer anything at all.

That cannot be what the conformance gate runs against. A git dependency whose
resolution depends on a third party's default branch is not reproducible; a
provider that needs a binary and a credential to produce its first event cannot
be exercised in CI at all. The consequence stood in the repository for three
months: Forge had two deterministic providers, `provider-mock` and
`provider-replay`, and had never spoken to a model.

### What replaces it

**`@forge/provider-anthropic`, built on `@anthropic-ai/sdk`** — a published,
MIT-licensed npm package with no binary and no peer requirements, implementing
`ProviderPort` over the Anthropic Messages API with streaming.

The property that makes it CI-safe is that **its HTTP transport is injected**.
The adapter takes a `fetch`; absent one it uses the SDK's own. Every test and the
whole conformance suite pass a scripted transport, so the SDK, its SSE decoder,
its error classes and its abort handling all execute with no network and no
credential. A real key exercises the same code path, differing only in where the
bytes come from.

The credential is read from `ANTHROPIC_API_KEY` in the environment and nowhere
else — never a literal, never a constructor default, never logged, never on an
event. An absent or blank key fails construction, naming the variable, rather
than surfacing on a first prompt that may be days away on the far side of a gate.

### What is lost

1. **The ACP protocol path.** Codex, Gemini and Cursor were reachable through one
   typed factory; they are not reachable through the Anthropic SDK. Multi-CLI
   support is deferred, not refused — `ProviderPort` is unchanged, so a second
   adapter is additive.
2. **`IPermissionHandler`, and with it 008 §6.** That was the hook by which an
   agent's own tool requests were to be routed through `PolicyPort` and
   `ApprovalPort`. The Messages API has no equivalent: it returns a `tool-call`
   event and stops. **This is not a regression in safety, because the gate never
   moved** — the runtime is what checks policy and requests approval before an
   effect dispatches, and it does so for every node whatever produced it. What is
   lost is the *second*, in-session checkpoint 008 §6 describes. Any future
   adapter that hosts an agent loop inside the provider must reinstate it before
   that loop is allowed to act, and 008 §6 remains normative for that case.
3. **Server-side session resume.** The Messages API is stateless, so
   `@forge/provider-anthropic` does not declare the `session-resume` capability
   and refuses to resume. Approval-gated resume is unaffected: the runtime resumes
   a *run* from a checkpoint, not a provider conversation.
4. **Tool definitions are adapter configuration.** `ProviderPort` carries no tool
   schemas — 008 §3's `allowedTools` was not taken up when the port was written —
   so tools are bound in the composition root alongside the model id, and the
   capability intersection of 008 §4 still narrows what may actually run.

### What is unchanged

Decisions 1, 3, 5 and 6 stand. `provider-mock` remains required for CI and demos;
the public SDK still imports no vendor; ACPX remains optional and private. The
architecture scan's vendor list already forbids `@anthropic-ai/*` in public and
company code, and that rule now has a real adapter behind it rather than a
hypothetical one.

### Consequences

- `docs/008-provider-sdk.md` §2, §5, §6 and §12 describe `adapters-provider-acp`
  as the primary path. They now describe a path that does not exist; 008 should be
  reconciled with this amendment, keeping §6 as the normative rule for any adapter
  that does host an agent loop.
- The conformance suite gained one declaration, `emitsToolResults`. A model API
  proposes tool calls and leaves execution to the runtime, so it emits `tool-call`
  and never `tool-result`; the suite previously assumed every adapter answered its
  own calls. The declaration is binding in both directions and the suite also now
  requires the tool scenario to actually produce a call.
