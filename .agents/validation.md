# Validation

How to validate changes in this repository. Applies to every task that modifies code, configuration, or tests.

## Commands

This repository uses Bun and Turborepo. The canonical commands are:

```sh
bun run format:check     # oxfmt formatting check
bun run lint             # oxlint + turbo boundaries
bun run type-check       # Workspace types + OpenAPI and migration-schema drift
bun run build            # TypeScript build via Turborepo
bun run test             # Per-package tests (turbo) + repository acceptance tests
bun run openapi:check    # OpenAPI contract validation (control-api only)
bun run db:check         # Drizzle migration-schema validation
bun run test:acceptance  # Complete M1 foundation, Terraform, and container acceptance
```

`bun test` (bare) is scoped to `tests/` via `bunfig.toml`; per-package tests run through `turbo run test` in `bun run test`.

Database integration tests require a live PostgreSQL instance:

```sh
bun run db:up            # Start local Postgres on 127.0.0.1:54329
cd packages/database && RUN_DATABASE_INTEGRATION=true bun test src/integration.test.mjs
```

## Rules

- Run focused tests first, then the complete applicable set for release, security, workflow, dependency, and configuration changes.
- TypeScript/JavaScript: oxfmt formatting, oxlint linting, type-check, build, and Bun's native test runner for unit/integration tests; use the project's native browser runner for E2E tests.
- Do not add Vitest. Preserve specialized native runners such as Matchstick for The Graph and Hardhat for smart contracts.
- If a check cannot run, state the exact reason. A skipped check is not a passing check.
- `npx code-foundry init` for a new checkout, or `npx code-foundry doctor` to diagnose setup drift.

## Tests and coverage

- Add or update tests for behavior changes and regressions.
- Keep unit, integration, E2E, and smoke coverage in the suite where each applies.
- Preserve project-specific coverage thresholds (`coverage_minimum: 80` in `.github/code-foundry.yml`); do not lower them to make CI green.
- Keep test data deterministic and remove secrets from logs and fixtures.
- Use the narrowest test command while iterating, then run the affected package or workspace suite.
