# Control Plane

Production-shaped TypeScript monorepo for the Control Plane. The repository is organized as a modular monolith with independently deployable composition roots. Stable domain/execution packages remain deployment-neutral; managed cloud, Local, and Hosted profiles select infrastructure through adapters/composition roots.

## Current delivery sequence

- **M9 — Managed Cloud Deployment, Hardening & Evals:** make the Railway + Neon + R2 + Restate managed-cloud profile fully operational and freeze deployment-independent behavior.
- **M10 — Local & Hosted Portability:** port the accepted M9 semantics to embedded Local and user-controlled VPS/container profiles.
- **M11 — Feature Completion & Production Audit:** independently audit managed cloud, Local, and Hosted.
- **M12 — Cross-Product Integration & Release:** connect the approved Control Plane candidate to Adea and optional Cortana release candidates.

M9 replaced the former AWS/ECS/Terraform and Temporal implementation with the active Cloud profile:
Railway + Neon + Cloudflare R2 + Restate. The product has exactly three deployment profiles: Cloud,
Hosted, and Local. M10 ports the same application semantics to Hosted and Local; AWS/ECS/Terraform
is historical context, not an active compatibility or portability target.

## Prerequisites

- Node.js 24.18.0 (`.node-version`)
- Bun 1.4.0 (`.bun-version` and `packageManager`)

Newer compatible Bun 1.x patch releases may run the workspace, but the pinned version is the reproducible baseline.

## Getting started

```sh
bun install --frozen-lockfile
bun run build
bun run lint
bun test
```

Run `bun install` without `--frozen-lockfile` only when intentionally updating dependencies.

Key documentation:

- [`docs/architecture.md`](docs/architecture.md): system ownership, deployment profiles, Restate/RuntimeTransport architecture, and current-vs-transitional implementation state.
- [`docs/infrastructure.md`](docs/infrastructure.md): Railway/Neon/R2/Restate M9 target, migration/rollback flow, and M10 portability boundaries.
- [`docs/configuration.md`](docs/configuration.md): typed service bootstrap/configuration.
- [`docs/database.md`](docs/database.md): Neon/PostgreSQL managed-cloud/server persistence and M10 SQLite Local/simple persistence.
- [`docs/remote-control-relay.md`](docs/remote-control-relay.md): optional outbound Local/Hosted remote control and the HPKE v1 envelope.
- [`docs/profile-portability.md`](docs/profile-portability.md): versioned profile export/import, dry-run/apply, secret exclusions, artifact handling, and recovery.
- [`docs/object-store.md`](docs/object-store.md): provider-neutral object storage and the Cloudflare R2 Cloud adapter.
- [`docs/api.md`](docs/api.md): Control API transport, validation, and error conventions.
- [`docs/contracts.md`](docs/contracts.md): service authentication, canonical identifiers, envelopes, and compatibility policy.
- [`docs/profiles-and-skills.md`](docs/profiles-and-skills.md): immutable AgentProfile/Skill ownership and lifecycle.
- [`docs/runtime-capabilities.md`](docs/runtime-capabilities.md): runtime capabilities, RuntimeNode references, and compatibility states.
- [`docs/execution-constraints.md`](docs/execution-constraints.md): provider-neutral tool/model/policy/limit contracts.
- [`docs/project-state.md`](docs/project-state.md), [`docs/context-packages.md`](docs/context-packages.md), and [`docs/execution-plans.md`](docs/execution-plans.md): durable state and immutable execution authority.
- [`docs/sdk.md`](docs/sdk.md): public contracts/SDK and deterministic integration fixtures.
- [`docs/credential-vault.md`](docs/credential-vault.md): dynamic connector/provider credential boundary.
- [`docs/marketplace-consumer.md`](docs/marketplace-consumer.md): server-side registry discovery, immutable release verification, and idempotent installation contract.
- [`docs/security-hardening.md`](docs/security-hardening.md), [`docs/recovery.md`](docs/recovery.md), [`docs/performance.md`](docs/performance.md), and [`docs/operations.md`](docs/operations.md): production evidence/runbooks.
- [`docs/testing.md`](docs/testing.md): current executable test commands plus M9–M11 evidence ownership.

## Architecture and governance references

- [`docs/architecture/diagram-sources.md`](docs/architecture/diagram-sources.md) contains version-controlled Mermaid definitions for Control Plane-owned diagrams. It must remain consistent with the canonical Google Drive diagram catalog.
- [`docs/runtime-compatibility/README.md`](docs/runtime-compatibility/README.md) explains machine-readable runtime compatibility and certification semantics.
- [`.github/labels.yml`](.github/labels.yml) defines the shared issue-label taxonomy.
- Canonical PRDs, TDDs, specifications, ADRs, roadmap decisions, and terminology remain in the Adea Google Drive corpus; GitHub implementation docs must not contradict those accepted sources.

## Workspace commands

| Command                      | Purpose                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `bun run build`              | Build every app and package through Turborepo                                                          |
| `bun run lint`               | Lint source/configuration and enforce package boundaries                                               |
| `bun test`                   | Run workspace test groups                                                                              |
| `bun run test:acceptance`    | Run the repository acceptance baseline currently implemented in source                                 |
| `bun run check:boundaries`   | Reject undeclared dependencies and cross-package source imports                                        |
| `bun run format`             | Format the repository with Prettier                                                                    |
| `bun run format:check`       | Check formatting without modifying files                                                               |
| `bun run containers:print`   | Print the current service image build plan                                                             |
| `bun run containers:build`   | Build current production-shaped service images                                                         |
| `bun run test:m9-acceptance` | Run the existing M9 hardening/evidence suite; M9.6 additionally requires live Railway staging evidence |

The repository-owned Railway manifest validator is the infrastructure composition check. A passing
local check is not Railway staging evidence until the M9.6 live activation gate is completed.

## Architecture map

### Cloud composition roots

The accepted Cloud application services are `apps/control-api` and `apps/workflow-worker`, backed by
the separately pinned Restate runtime. The former five-process AWS/Temporal-era split is not a
compatibility target. Applications are composition roots, not public product contracts; Local and
Hosted compose the same stable capabilities according to their supported topology.

### Stable interfaces and core domain

- `packages/domain`
- `packages/contracts`
- `packages/control-sdk`
- `packages/events`
- `packages/execution-plan`
- `packages/runtime-sdk`
- `packages/tool-sdk`
- `packages/policy`
- `packages/context`

These packages form the inward-facing platform boundary. They must not expose or depend on deployment/vendor details such as Railway, Neon, R2, SQLite/PostgreSQL drivers, Restate SDK types, LangGraph, Pi, ACP, LiteLLM, E2B, Runtime Gateway transport, or OS-specific secret implementations except through declared stable ports/contracts.

### Infrastructure and adapters

- `packages/database`: current persistence implementations/migrations; M10 adds the accepted SQLite adapter.
- `packages/acp-adapter`: ACP interoperability.
- `packages/telemetry`: observability implementation boundary.
- `packages/testing`: shared fixtures/conformance harnesses.
- `packages/credential-vault`: dynamic connector/provider credential boundary.

M10 formalizes deployment-profile ports for persistence, workflow runtime, object storage, secrets, coordination, process/runtime supervision, service discovery, observability, and runtime transport.

## Runtime transport invariant

Co-located Control Plane/runtime execution uses direct RuntimeTransport/RuntimeDriver access. Runtime Gateway is required only for non-co-located RuntimeNodes. Adea's durable web/mobile remote relay is a separate product-control transport and must not be conflated with Runtime Gateway.

## Package rules

Packages are private/server-only except explicitly public contract/SDK surfaces. Library exports expose declared entry points only; deep imports into another package's source are unsupported. Workspace dependencies must be declared in the importing package's manifest. TypeScript runs in strict mode for every app and package.
