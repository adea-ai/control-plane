# Control Plane

Production-shaped TypeScript monorepo for the Control Plane. The repository is organized as a modular monolith with independently deployable composition roots. Stable domain/execution packages remain deployment-neutral; managed cloud, Local, and Hosted profiles select infrastructure through adapters/composition roots.

## Current delivery sequence

The current milestone display labels define implementation order; GitHub URL/database IDs are stable identifiers and can differ from those labels. [GitHub milestones](https://github.com/adea-ai/control-plane/milestones) own live status, dependencies and acceptance.

- **M11–M18: Pi Durable implementation.** Build workspace leads/global conversation foundations, Pi runtime/authority, durable jobs/native harness bridges, responsive lead/project UX, authorized groups, graph retirement, runtime/profile simplification and migration acceptance. The selected architecture is planned; individual changes require their own qualification evidence.
- **[M19: Feature Completion & Production Audit](https://github.com/adea-ai/control-plane/milestone/11).** Complete the retained original issues #186–#197 and current follow-ups against the integrated Pi candidate. Security, authority and data-preservation repairs needed by the migration proceed alongside it.
- **[M21: Cross-Product Integration & Release](https://github.com/adea-ai/control-plane/milestone/10).** Certify and release the integrated Control Plane, Adea and optional Cortana profiles after their dependencies qualify.

The original M9 managed-cloud and M10 portability work remains historical implementation and evidence context. The managed-cloud reference uses Railway + Neon + Cloudflare R2 + Restate; Hosted retains its supported simple/server Compose profiles and Restate, while Local retains embedded SQLite and direct transport. These paths remain until qualified replacement and cutover. Local uses no Restate process under owner-approved #548. AWS/ECS/Terraform and Temporal are historical, not active targets. Superseding an engine or renumbering a milestone does not waive recovery, authority, retention, rollback or profile acceptance. See the [planned target and retained diagram sources](docs/architecture/diagram-sources.md).

## Prerequisites

- Node.js 24.21.0 (`.node-version`)
- Bun 1.4.2 (`.bun-version` and `packageManager`)

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
- [`docs/runtime-node-identity-operations.md`](docs/runtime-node-identity-operations.md): operator-owned RuntimeNode key registration, one-use credential issuance, and revocation.
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
| `bun run format`             | Format the repository with oxfmt                                                                       |
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
