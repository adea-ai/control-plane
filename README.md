# Adea

Adea is a browser-based workspace with Home and Work workspaces, chat,
tasks, and a plugin marketplace. The spatial 3D scenes (home/work worlds,
character and interior content, room designer) live in the private Agent Sim
engine repo and mount here through an entitlement-gated remote; this
repository ships the shell, scene-manifest protocol, engine loader, and
fallback for builds without an engine pack.

## Stack

- Turborepo, TanStack Start, SolidJS, and TypeScript
- Bun for installation, scripts, and tests
- Scene manifests and telemetry schema via `@adea-ai/spatial`
  (the Three.js runtime, scenes, and asset pipeline live in Agent Sim)
- TanStack Query's Solid bindings for server state and `solid-js/store` for
  client-only coordination
- Shared Solid components from published `@adea-ai/ui`, with theme contracts
  from `@adea-ai/themes` and app-owned adapters in `@adea-ai/app-ui`
  ([decision 0007](docs/decisions/0007-solid-tanstack-start.md))
- Vite 8 (Rolldown) for the app and library builds, `tsc` for declarations and
  type-only packages ([decision 0008](docs/decisions/0008-build-bundler-vite-vs-bun.md))

Published `@adea-ai/ui` source is excluded from the web server's dependency
optimizer so the Solid plugin compiles it for SSR. This also applies to standalone
authentication pages that render shared controls before hydration.

## Local development

```text
bun install
portless
```

Portless runs the web app at [https://adea.localhost](https://adea.localhost)
with a stable named route instead of a fixed development port. Portless requires
Node.js 24 or newer; Bun remains the repository's package manager and test runner.

Workspace bootstrap and temporary guest sessions are persistence-backed. Start the
local PostgreSQL service and load the example server environment before launching
the app:

```sh
cp apps/web/.env.example apps/web/.env.local
docker compose up -d --wait postgres
set -a
. apps/web/.env.local
set +a
bun run --cwd packages/db db:migrate
```

`apps/web/.env.local` is ignored and must never be committed. The `DATABASE_URL`
value is server-only; do not rename it to a `ADEA_PUBLIC_` or `VITE_` variable.

For a direct, non-Portless launch, use `PORT=3004 bun run dev`.

- Home workspace: [https://adea.localhost/?scene=home](https://adea.localhost/?scene=home)
- Work workspace: [https://adea.localhost/?scene=work](https://adea.localhost/?scene=work)
- Room designer: append `&roomDesigner=1` to the selected scene URL (renders
  the engine-unavailable state in builds without Agent Sim)

Cross-app portal defaults use `adea.localhost` and `world.localhost`. Set
`ADEA_PUBLIC_WORLD_URL` when the sibling World app uses a different
Portless name.

The asset sync step stages tracked scene manifests from
`@adea-ai/spatial` into `apps/web/public/assets`, an ignored build directory.
The spatial engine itself lives in the private Agent Sim repository and is
delivered through the entitlement-gated engine remote.

## Plugin marketplace

Adea consumes the authoritative registry through the same-origin server
proxy. The proxy calls authenticated Control Plane APIs for verified core
catalog metadata and installation state. The browser may fetch a smaller
public browsing index directly, but accepts it only after its declared digest
and catalog ID match the verified catalog. Icons can load from publication,
upstream, or third-party URLs. These display paths do not download plugin
source or grant installation or execution authority. The registry's
stable latest pointer is
[`catalog-latest.v1.json`](https://raw.githubusercontent.com/adea-ai/plugins/catalog-assets/catalog-latest.v1.json),
and each verified catalog is pinned by its `catalogId`, which is also its
immutable snapshot path.

The shared marketplace provider verifies the catalog schema, canonical catalog
digest, `integrity.json`, and byte-identical latest pointer before mapping the
entries into the workspace UI. It preserves each source-qualified `pluginId`,
exact `releaseId`, `canonicalContentDigest`, provenance,
`harnessCompatibility`, `securityClassification`, and connector/credential
requirements. `metadata-only` entries are visible as unavailable metadata and
cannot be enabled. A stale last-known-good catalog is labeled stale; a failed
verification is fail-closed.

Adea browses catalog metadata. Add/Enable submits the exact plugin
and release pins, requested harness, and workspace/user identity to Control
Plane. It does not claim local installation state, download upstream content,
or execute plugin content. Control Plane owns authorization, connector and
credential resolution, server-side release verification, installation state,
and execution records. A returned `installed` state does not prove that plugin
files have been materialized or a harness has been activated. See [`docs/marketplace-consumer.md`](docs/marketplace-consumer.md)
for the integration contract and required environment variables.

## Architecture references

- [`docs/architecture/diagram-sources.md`](docs/architecture/diagram-sources.md) contains the version-controlled Mermaid definitions for Adea-owned product, architecture, data, trust, runtime, Artifact, and event diagrams.
- [`.github/labels.yml`](.github/labels.yml) defines the shared issue-label taxonomy without installing a synchronization workflow.
- Canonical product requirements, TDDs, specifications, ADRs, roadmap decisions, and terminology remain in the Adea Google Docs corpus.

## Runtime and asset performance

The spatial engine (InstancedMesh scene fields, frustum culling, Meshopt GLB
and KTX2/Basis decoding, asset optimization, performance budgets) lives in
the private Agent Sim repository. This repository stages only the tracked scene
manifests from `@adea-ai/spatial` into `apps/web/public/assets`. Public build
inputs and the conventional UI do not require a private engine pack. Install
the pinned dependencies and configure local PostgreSQL for persistence-backed
workspace flows and integration tests as described above. Engine rendering
requires a separately prepared pack; without it, the virtual view shows its
unavailable state.

## Verification

```text
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run test:integration
bun run build
bun run test:packaged
bun run test:browser:desktop-client

# Force Chromium headless (useful for CI or local non-interactive runs)
PLAYWRIGHT_HEADLESS=1 bun run test:e2e
```

CI delegates general validation to the shared Code Foundry workflow. The
separate Neon workflow runs the integration inventory as two shards, each against its own isolated branch, behind one required `Migrate Neon Branch` check.
Package unit tests fan out through Turborepo.

`bun run test:unit` includes an 80% line-and-function coverage gate for the
durable authentication, persistence, and repository-boundary code exercised by
`packages/auth/tests/unit`, `packages/db/tests/unit`, and `scripts/*.test.ts`.
It writes an ignored LCOV report to `coverage/lcov.info`. The integration entry
point runs the provider-neutral and PostgreSQL cases together. When no database
variables are exported, it starts the repository's local PostgreSQL Compose
service, verifies the restricted migration/runtime roles, applies migrations
deterministically, and runs the complete integration suite. CI and explicit
Neon runs must provide all three canonical variables (`DATABASE_URL`,
`DATABASE_URL_UNPOOLED`, and `DATABASE_MIGRATION_URL`) for an isolated test
branch; production or owner credentials are not valid test targets.

`bun run build` covers the workspace packages and the TanStack Start
production build. Packaged macOS desktop evidence uses `bun run test:packaged`,
and the desktop client check uses `bun run test:browser:desktop-client`. The root
package does not expose a `test:smoke` script or a generic native-compiler
check. The headless E2E command above provides functional and layout coverage
for shell and chat flows; scene performance gates live with the engine in
Agent Sim.
