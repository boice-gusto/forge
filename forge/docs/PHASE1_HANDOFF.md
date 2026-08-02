# Phase 1 Handoff

## Delivered foundations

- Strict TypeScript workspace contracts, safe manifest parsing, internal ports, configuration precedence, and a Pino-backed redacting logger.
- Commander/Chalk CLI contract with one-result JSON output, documented exit codes, provider doctor, manifest validation, and constrained local composition commands.
- API live/ready/admin health endpoints with Forge build and request headers; worker readiness model; Tailwind/Vite local status UI and Shadcn configuration.
- Architecture checks, CI ordering, source-secret scan, dependency-license inventory, and an actual measured Phase 1 baseline.

## Local verification

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm test:architecture
pnpm build
pnpm security:secrets
pnpm security:licenses
pnpm measure:phase1
```

Expected result: all commands exit `0`; the test suite reports 23 passing tests at this handoff point.

## Local stack

`forge dev up` manages only the resources declared in `forge/infra/local/compose.yaml`: Redis, Postgres, and OTel. Its defaults avoid common host collisions: Redis `16379`, Postgres `15432`, and OTel `14318`; `FORGE_REDIS_PORT`, `FORGE_POSTGRES_PORT`, and `FORGE_OTEL_PORT` may override them. It fails closed with exit `1` when Docker is unavailable. It does not start arbitrary containers, remove volumes, or target a host-wide teardown.

After starting a Docker daemon:

```sh
pnpm --filter @forge/cli exec tsx src/main.ts dev up --json
pnpm --filter @forge/cli exec tsx src/main.ts providers doctor --json
pnpm --filter @forge/cli exec tsx src/main.ts dev down --json
```

## Known gate

The implementation and compose configuration validate locally, but the current machine had no Docker daemon at verification time. The operational `dev up` acceptance proof remains pending that external dependency; Phase 2 must not claim the Phase 1 local-stack exit demo until it is rerun successfully.
