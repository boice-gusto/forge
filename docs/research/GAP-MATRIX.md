# Phase 0 Gap Matrix

**Status:** Complete (2026-08-02)  
**Purpose:** Map RAW topic list → research artifact → handbook owner. Drive remaining verification work.

| RAW topic | Research artifact | Handbook | Verification status |
|-----------|-------------------|----------|---------------------|
| Executive summary | This matrix + MASTER_SPEC | `000`, `MASTER_SPEC` | Spec write |
| Vision | RAW principles | `001` | Spec write |
| Problem statement | `016-company-customization-and-demos.md` (renamed) | `002` | Spec write |
| Project constitution | RAW | `003` | Spec write |
| Engineering principles | RAW + SimPill AGENTS | `003` | Spec write |
| Architecture | `004-006-007-architecture-runtime-compiler.md` | `004` | Spec write |
| Monorepo layout | Arch research + ADR-001 | `004`, ADR | Spec write |
| Phase 0 → production | Company demos research §4 | `015` | Spec write |
| Research workflow | RAW | `005` | Spec write |
| ADR requirements | `005` + ADR template | `005`, `docs/adrs/` | Spec write |
| Plugin SDK | Company demos research | `009` | Spec write |
| Workflow compiler | Arch research | `007` | Spec write |
| LangGraph abstraction | `TECH-STACK-RESEARCH.md` + PACKAGE-EVIDENCE | `006`, `007`, ADR-002 | **Verified npm** `@langchain/langgraph@1.4.8` |
| Provider abstraction | `008-provider-sdk.md` + acp-llm-cli source | `008`, ADR-005 | **Verified local** `@simpill/acp-llm-cli@0.1.2` |
| ACPX integration | `008` + PACKAGE-EVIDENCE | `008` | **Verified npm** `acpx@0.13.0` (optional private) |
| SimPill integration | PACKAGE-EVIDENCE + acp-llm-cli | `004`, `008`, `011` | **Verified local + npm** |
| Sandbox architecture | `010-sandbox.md` | `010`, ADR-003 | Research-grade; Docker/Testcontainers ADOPT |
| Queue abstraction | TECH-STACK + arch | `006`, ADR-004 | **Verified npm** `bullmq@5.x` (reported 6.0.5) |
| Observability | `011-observability.research.md` (new) | `011`, ADR-006 | **Verified npm** OTel API + langsmith |
| UI specification | `012-ui.research.md` (new) | `012` | Research + AI Elements ADOPT-LATER |
| Prompt architecture | `017-prompts.research.md` (new) | `003`, `007`, `009` | Spec write |
| Judge architecture | `018-judges.research.md` (new) | `006`, `009` | Spec write |
| Company configuration | Company demos research | `009`, `004` | Spec write |
| Forge vs Forge-gusto | Company demos research | `000`, `004`, `009` | Spec write |
| Demo scenarios / Acme / Gusto / user stories | Company demos research | `016` | Spec write |
| Testing / quality gates | `013-testing.research.md` | `013`, `015` | **Verified npm** vitest/playwright/dep-cruiser/testcontainers |
| Security / threat model | `014-security.research.md` | `014` | Spec write |
| Acceptance / deliverables / milestones | Phases + demos | `015`, `016`, `MASTER_SPEC` | Spec write |

## Critical gaps closed in this pass

1. Prompt architecture research note  
2. Judge architecture research note  
3. UI research note  
4. Observability research note  
5. Package Evidence with npm + local acp-llm-cli deep-read  
6. ADR stubs under `docs/adrs/`  
7. Research rename: company demos no longer collide with sandbox as `010-*`

## Remaining unknowns (explicit)

- AI SDK major pin (npm shows `ai@7.0.48`; align adapter ADR at implement time)  
- OPA Wasm latency budget (measure Phase 2)  
- Firecracker self-host vs managed (E2B-class) for prod — deferred past MVP  
- Gusto “USP” org-unit naming (open domain ADR in company package)  
- Zod peer on acp-llm-cli currently `^3.23.8` while Forge constitution targets Zod v4 — adapter must normalize  
