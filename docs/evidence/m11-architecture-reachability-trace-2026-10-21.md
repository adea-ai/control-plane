# CP #187 — architecture and contract reachability trace and evidence packet

Owner: Fleet 2 / F2W3 — branch `f2w3/cp187-architecture-audit`.

This packet is the CP #187 reachability outcome for the four deployment profiles. It records what
is reachable, what is a dead end, and what the architecture-audit tooling could not previously
detect. It does **not** edit the canonical architecture artifact
(`docs/architecture/control-plane-architecture.v1.json`), its generated report
(`docs/architecture/control-plane-architecture.md`), `tests/m11-architecture-audit.test.mjs`, any
runtime composition, any migration, any `docs/requirements/**` file, or any repository lane
registration. Those stay with their current owners.

| Item                                              | Value                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Repository                                        | `adea-ai/control-plane`                                                                 |
| Branch                                            | `f2w3/cp187-architecture-audit`                                                         |
| Base commit                                       | `27f17bd55e0266439b5b3089163195c9e7a669be` (`chore(main): release 1.105.5 (#1209)`)     |
| Change under review                               | the head of `f2w3/cp187-architecture-audit`; four owned files, sections 8, 12 and 13    |
| Audited candidate recorded by the canonical audit | `6c922d487c3c2e70a047c11c55a1cb4ddbabad26` (`main`, recorded 2026-10-01)                |
| Toolchain                                         | Bun 1.4.3, Node 24.21.0, `darwin-arm64` (`.bun-version`, `.node-version`)               |
| Commands                                          | `bun scripts/architecture-audit.mjs`, `bun test tests/m11-architecture-audit*.test.mjs` |

Everything below is derived from the current tree at the base commit. Where a number comes from
the tree it is reproducible with the commands in section 10. Local executions are **local synthetic
or local process evidence only**: they are not live profile acceptance, not provider evidence, and
not deployed evidence.

**What the profile statements in this packet are.** Every per-profile reachability, capability
binding and port statement here is a **static inventory** result: it is derived by reading the
composition sources, the SDK registry, the OpenAPI document and the persistence manifests in the
tree. It says what the sources bind, not what a running profile did. No profile was deployed, no
provider was called and no runtime was exercised, so nothing here is proof that a profile started,
accepted an operation, or served a route. Where this packet says a capability is "bound" or
"never bound", that is a statement about the sources, and a live run is what would confirm or
refute it.

---

## 1. The four profiles are three composition families

| Profile         | Entry point                                                     | Composition                                                                                   | Application binary                | Digest-covered composition source |
| --------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------- |
| `cloud`         | `apps/control-api/src/index.ts`                                 | `apps/control-api/src/cloud-composition.ts` + `apps/workflow-worker/src/cloud-composition.ts` | `control-api` + `workflow-worker` | both cloud composition files      |
| `hosted-server` | `apps/hosted-control-plane/src/index.ts`                        | `apps/hosted-control-plane/src/composition.ts`                                                | `hosted-control-plane`            | hosted composition file           |
| `hosted-simple` | `apps/local-control-plane/src/index.ts --profile hosted-simple` | `apps/local-control-plane/src/composition.ts`                                                 | `local-control-plane`             | local composition file            |
| `local`         | `apps/local-control-plane/src/index.ts`                         | `apps/local-control-plane/src/composition.ts`                                                 | `local-control-plane`             | local composition file            |

`hosted-simple` is **not a separate application**. It is the `local-control-plane` binary selected
by `CONTROL_PLANE_DEPLOYMENT_PROFILE=hosted-simple`
(`apps/local-control-plane/src/index.ts:90-95`, `resolveEmbeddedDeploymentProfile`). The only
difference the audit records is the `workflow` port: `Local Restate` for `hosted-simple` versus
`embedded SQLite queue (default Local)` for `local`.

**Finding A1 — `local` and `hosted-simple` share one composition digest.**
`discoverArchitecture` digests `apps/local-control-plane/src/composition.ts` for both profiles, so
their `sourceDigest` values are byte-identical. The source that actually separates the two
profiles — `apps/local-control-plane/src/index.ts` (`resolveEmbeddedDeploymentProfile`) — is not in
any digest set. A change to the profile-selection logic therefore cannot be detected by the
per-profile source digest at all. The audit now reports this collision as a warning; re-baselining
the canonical audit with distinct digests needs the canonical artifact owner (W1).

Severity: medium. Owner: canonical architecture artifact owner (W1), with the local runtime owner.
Disposition: give `local` and `hosted-simple` distinct digest-covered composition sources (the
profile-selection entrypoint) and record the two digests separately.

---

## 2. Public operation reachability

The public operation universe is the SDK operation registry
(`packages/control-sdk/src/operations.ts:106`), which the audit and the OpenAPI generator both
derive from. It contains **54 operations**. The canonical audit classifies 25 `verified` and 29
`partially_verified`; no operation is `not_implemented` or `superseded`.

### 2.1 The three contract surfaces agree, and all of them are narrower than what is served

| Surface                                | Count    | Source                                                          |
| -------------------------------------- | -------- | --------------------------------------------------------------- |
| SDK operation registry                 | 54       | `packages/control-sdk/src/operations.ts`                        |
| OpenAPI document (current major 3)     | 54 paths | `packages/control-sdk/openapi/control-plane.v3.json`            |
| NestJS controller routes               | 63       | `apps/control-api/src/**/*.controller.ts`                       |
| Fastify routes registered outside Nest | 1        | `apps/control-api/src/application.ts:32` (`GET /v1/components`) |

Every SDK operation has an OpenAPI operation, and every SDK operation has a controller route with
the **same HTTP method and path**. The contract surfaces are internally consistent; they are simply
not the whole public surface.

### 2.2 Served routes with no SDK or OpenAPI binding (9)

| Method + path                                   | Controller                                                              | Note                             |
| ----------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------- |
| `GET /health`                                   | `apps/control-api/src/health/health.controller.ts:17`                   | unversioned by `VERSION_NEUTRAL` |
| `GET /ready`                                    | `apps/control-api/src/health/health.controller.ts:23`                   | unversioned by `VERSION_NEUTRAL` |
| `POST /v1/executions/admission-stop`            | `apps/control-api/src/executions/admission-control.controller.ts:83`    | operator admission control       |
| `POST /v1/executions/admission-resume`          | `apps/control-api/src/executions/admission-control.controller.ts:105`   | operator admission control       |
| `POST /v1/executions/tool-effects/inspect`      | `apps/control-api/src/executions/tool-effect-recovery.controller.ts:50` | tool effect recovery             |
| `POST /v1/executions/tool-effects/reconcile`    | `apps/control-api/src/executions/tool-effect-recovery.controller.ts:65` | tool effect recovery             |
| `POST /v1/pi-durable/management-current/assert` | `apps/control-api/src/pi-durable/management-current.controller.ts:89`   | Pi durable authority assertion   |
| `POST /v1/system/authenticated`                 | `apps/control-api/src/system/system.controller.ts:21`                   | authenticated principal echo     |
| `GET /v1/system/echo`                           | `apps/control-api/src/system/system.controller.ts:14`                   | unauthenticated echo             |

`GET /v1/components` (`apps/control-api/src/application.ts:32`) is a tenth served route that is
registered on the Fastify adapter directly, outside the Nest controller system, and is therefore
not discoverable from controller sources at all. It is registered only when the profile binds a
component manifest: `local`/`hosted-simple`
(`apps/local-control-plane/src/index.ts:186`) and `hosted-server`
(`apps/hosted-control-plane/src/index.ts:95`) do, the `cloud` entrypoint does not.

**Finding A2 — the reachability audit's operation universe is SDK-only, so nine served routes and
one directly registered route are untraced.** Six of the nine are business or administration
operations (admission control, tool effect recovery, Pi durable authority assertion, authenticated
principal echo); only `GET /health`, `GET /ready` and `GET /v1/system/echo` are service probes.
Because the canonical audit has no row for an operation that is not in the SDK registry, this is
reported as an audit **warning**, not an error: adding a hard error would fail the frozen
canonical artifact that its owner has not yet re-baselined.

Severity: high for the six business routes, low for the three probes.
Owner: the Control API operation registry owner, with the canonical architecture artifact owner
(W1) for the audit row.
Disposition: either bind the six business routes in `ControlApiOperations` and the OpenAPI
document, or record them in the canonical audit as deliberately non-SDK public operations. Do not
delete the routes.

### 2.3 Capability binding per profile (the disabled-binding surface)

**This matrix is a static inventory of the composition sources, not a runtime observation.** It
records which capability options each profile's sources bind; it does not record what a running
profile served. Section 11 keeps the live profile gate open.

`apps/control-api/src/app.module.ts` accepts 22 optional capability bindings. Twenty-one of them
default to an implementation whose name starts with `Unavailable`, `Disabled` or `Empty`, so a
composition that does not supply its own implementation serves a route that always refuses. Only
`piLeadPublicationService` has a real default (`apps/control-api/src/app.module.ts:227`).

| Option                                   | Default implementation                              | app.module.ts line |
| ---------------------------------------- | --------------------------------------------------- | ------------------ |
| `admissionControlService`                | `UnavailableAdmissionControlService`                | 273                |
| `contextPackageResolutionService`        | `UnavailableContextPackageResolutionService`        | 287                |
| `credentialAdministrationService`        | `UnavailableCredentialAdministrationService`        | 253                |
| `executionAcceptanceService`             | `UnavailableExecutionAcceptanceService`             | 292                |
| `executionCancellationService`           | `UnavailableExecutionCancellationService`           | 269                |
| `executionValidationService`             | `UnavailableExecutionValidationService`             | 296                |
| `graphAdministrationService`             | `UnavailableGraphAdministrationService`             | 244                |
| `interactionCommandService`              | `UnavailableInteractionCommandService`              | 264                |
| `marketplaceInstallationService`         | `UnavailableMarketplaceInstallationService`         | 332                |
| `marketplaceRegistryService`             | `UnavailableMarketplaceRegistryService`             | 327                |
| `modelConnectionService`                 | `UnavailableModelConnectionService`                 | 240                |
| `piDurableCurrentToolAuthority`          | `UnavailablePiDurableCurrentToolAuthority`          | 236                |
| `piDurableLeadService`                   | `UnavailablePiDurableLeadService`                   | 231                |
| `profileResolutionService`               | `UnavailableProfileResolutionService`               | 308                |
| `projectStateInitializationService`      | `UnavailableProjectStateInitializationService`      | 318                |
| `projectStateResolutionService`          | `UnavailableProjectStateResolutionService`          | 313                |
| `runtimeDiscoveryRepository`             | `EmptyRuntimeDiscoveryRepository`                   | 323                |
| `runtimeNodeCredentialRevocationService` | `UnavailableRuntimeNodeCredentialRevocationService` | 259                |
| `serviceAuthenticator`                   | `DisabledServiceAuthenticator`                      | 304                |
| `toolEffectRecoveryService`              | `UnavailableToolEffectRecoveryService`              | 300                |
| `workspaceCatalogService`                | `UnavailableWorkspaceCatalogService`                | 248                |

Per profile, the capabilities that the profile's own composition sources **never bind** are served
by the unavailable default:

| Profile         | Never bound                                                                                                                                                                                                                                  | Count |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `cloud`         | `runtimeNodeCredentialRevocationService`, `toolEffectRecoveryService`                                                                                                                                                                        | 2     |
| `hosted-server` | `admissionControlService`, `credentialAdministrationService`, `marketplaceInstallationService`, `marketplaceRegistryService`, `modelConnectionService`, `piDurableCurrentToolAuthority`, `piDurableLeadService`, `toolEffectRecoveryService` | 8     |
| `hosted-simple` | `marketplaceInstallationService`, `modelConnectionService`, `piDurableCurrentToolAuthority`, `piDurableLeadService`, `runtimeNodeCredentialRevocationService`                                                                                | 5     |
| `local`         | `marketplaceInstallationService`, `modelConnectionService`, `piDurableCurrentToolAuthority`, `piDurableLeadService`, `runtimeNodeCredentialRevocationService`                                                                                | 5     |

Beyond "never bound", several capabilities are bound only under an explicit configuration, so the
default deployment still serves them from the unavailable default:

- `local` / `hosted-simple`: `credentialAdministrationService` requires `LOCAL_SECRET_ENCRYPTION_KEY`
  (`apps/local-control-plane/src/index.ts:153-166`); `toolEffectRecoveryService` requires the graph
  tool configuration (`apps/local-control-plane/src/index.ts:167-169`); `marketplaceRegistryService`
  requires the marketplace registry to be built (`:136`, `:170`).
- `cloud`: `credentialAdministrationService` is absent unless a secret-encryption key is configured
  (`apps/control-api/src/cloud-composition.ts:131`); `modelConnectionService`,
  `piDurableCurrentToolAuthority` and `piDurableLeadService` require the Pi durable production
  composition (`apps/control-api/src/index.ts:192-207`).

### 2.4 Non-HTTP entry surfaces (IPC, relay, gateway, MCP)

The operation universe in section 2 is the **Control API** surface: the SDK registry, the OpenAPI
document and the Nest controllers. Three further entry surfaces exist in the tree and are reached
_after_ an operation is accepted, through the per-profile `runtimeTransport` port:

| Entry surface                   | Where                                                                                                                                                                                           | How a profile reaches it                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime gateway IPC (WebSocket) | `apps/runtime-gateway`, handshake at `GET /runtime-gateway/v1/connect` (`apps/runtime-gateway/src/websocket-server.ts:194`), versioned envelope protocol in `packages/runtime-gateway-protocol` | `hosted-server` through `DurableRemoteWorkflowRuntime`; `cloud` through `DisabledCloudRuntime`, `CloudCertificationRuntime` or an explicit `DurableRemoteWorkflowRuntime`; `local` and `hosted-simple` **reject** it (`LOCAL_RUNTIME_TRANSPORT_MUST_BE_DIRECT`, `apps/local-control-plane/src/composition.ts:477-479`) |
| Remote control relay (HPKE)     | `packages/remote-control-relay` (`protocol.ts`, `relay.ts`, `keyring.ts`, `key-store.ts`, `crypto.ts`), hosted through `RemoteControlHostAdapter`                                               | optional in `local`/`hosted-simple` (`apps/local-control-plane/src/composition.ts:508-512`) and `hosted-server`; the composed manifest reports `remoteControl: 'disabled'                                                                                                                                              | 'outbound'` (`apps/local-control-plane/src/composition.ts:744`, `apps/hosted-control-plane/src/composition.ts:712`) |
| Tool gateway / MCP              | `apps/tool-gateway` (`mcp-adapter.ts`, `tool-registry.ts`, `tool-execution.ts`)                                                                                                                 | a separate service in front of `packages/tool-execution`; the ACP entry is `packages/acp-adapter` (`AcpDriver`, `AcpAdapter`)                                                                                                                                                                                          |

These are **not** public Control API operations and must not be added to `ControlApiOperations`:
they are runtime and tool surfaces downstream of an accepted operation. The audit tool therefore
correctly keeps them out of the operation universe, and the per-profile `runtimeTransport` and
`workflow` port bindings are where they are recorded.

**Finding A9 — the IPC and relay entry surfaces have no reachability row in the canonical
audit.** The canonical `compatibilityMatrix` has `COMPAT-RUNTIME-MATRIX`, but that row is about
the runtime _certification_ artifact (`docs/runtime-compatibility/runtime-certifications.v1.json`,
6 certifications, all `supported`) and not about entry-surface reachability. Nothing in the
canonical audit states, per profile, whether the runtime gateway IPC, the remote control relay or
the tool gateway is reachable, refused, or composed at all. The audit tooling now surfaces the
per-profile capability binding matrix (section 2.3), but the transport and relay surfaces
themselves are still only described in prose.

Severity: medium. Owner: the runtime gateway, relay and tool gateway owners, with the canonical
architecture artifact owner (W1). Disposition: add per-profile reachability rows for the IPC,
relay and tool-gateway entry surfaces, using the port bindings the audit already measures.

### 2.5 Which capabilities share the core

This is a static inventory of the workspace manifests and the composition sources. It says which
packages are core to the layering and which adapters a profile's sources may bind; it is not a
runtime observation of any profile.

Every profile composes the same 14 core packages; the rest of the 45 workspaces are adapters that
a profile may or may not bind. The core is a DAG rooted at `@control-plane/contracts`:

| Core package                | Workspace dependencies                                                        |
| --------------------------- | ----------------------------------------------------------------------------- |
| `packages/contracts`        | —                                                                             |
| `packages/config`           | `contracts`, `telemetry`                                                      |
| `packages/context`          | `contracts`, `domain`                                                         |
| `packages/deployment`       | —                                                                             |
| `packages/domain`           | `contracts`                                                                   |
| `packages/events`           | `contracts`, `domain`, `telemetry`                                            |
| `packages/execution-plan`   | `context`, `contracts`, `domain`, `runtime-sdk`                               |
| `packages/orchestration`    | `context`, `contracts`, `domain`, `execution-plan`, `runtime-sdk`, `tool-sdk` |
| `packages/policy`           | `contracts`                                                                   |
| `packages/runtime-sdk`      | `contracts`                                                                   |
| `packages/telemetry`        | —                                                                             |
| `packages/tool-sdk`         | `contracts`                                                                   |
| `packages/usage-ledger`     | `contracts`                                                                   |
| `packages/workflow-runtime` | `config`, `contracts`, `deployment`, `domain`, `orchestration`, `runtime-sdk` |

The audit proves two structural facts about this core on every run: no core package depends on an
adapter package, and the workspace runtime dependency graph has no cycle. Everything that differs
between the four profiles is an **adapter binding**, which is exactly what the per-profile port
map and the capability binding matrix in section 2.3 enumerate. The capabilities that share the
core are therefore the ones whose implementation lives in the core packages above; the ones that
do not are the 21 disabled bindings and the 31 adapter workspaces that a profile may leave
unbound.

**Finding A3 — every profile serves at least two capabilities only from an unavailable default,
and the canonical audit records none of it.** The canonical audit's per-profile rows carry a prose
`assessment` and a single `gap`, but no capability-level binding matrix, so the reachability
surface of the 21 disabled bindings is invisible in the artifact.

Severity: high. Owner: the profile composition owners (`managed-cloud-runtime`,
`hosted-runtime`, `hosted-simple-runtime`, `local-runtime`) and the Control API module owner.
Disposition: bind or explicitly retire each capability per profile, and record the binding matrix
in the canonical audit once its owner re-baselines the artifact.

---

## 3. Final-candidate readback

The canonical audit names its candidate explicitly:
`"candidate": { "commit": "6c922d487c3c2e70a047c11c55a1cb4ddbabad26", "ref": "main", "recordedAt": "2026-10-01T05:35:06.688175Z" }`.
That commit exists in this checkout and **is an ancestor of the branch base** `27f17bd5`, so the
readback is exact rather than approximate. Reading the audited surfaces at the recorded candidate
and at the branch base gives:

| Audited surface                              | Recorded candidate `6c922d48` (2026-10-01) | Branch base `27f17bd5` (current) | Canonical audit records                                                                                       |
| -------------------------------------------- | ------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| SDK public operations                        | 20                                         | 54                               | 54                                                                                                            |
| PostgreSQL SQL migrations                    | 58                                         | 74                               | "27 SQL migrations" (`COMPAT-POSTGRES-MIGRATIONS`) and "49 forward Drizzle migrations" (`PERSIST-MIGRATIONS`) |
| SQLite ordered migrations / `SCHEMA_VERSION` | 2                                          | 5                                | "SCHEMA_VERSION=2" (`COMPAT-SQLITE-SCHEMA`)                                                                   |
| OpenAPI major                                | 1                                          | 3                                | "OpenAPI v2" (`COMPAT-PUBLIC-OPERATIONS`)                                                                     |

**Finding A8 — the canonical audit is a mix of two generations, and its recorded candidate does
not describe it.** The operation inventory, the package inventory and the profile digests were
regenerated against a much later tree than the commit the artifact names, while several prose
figures were never regenerated at all. The figures that match the recorded candidate
(`SCHEMA_VERSION=2`) are correct _for that candidate_ and stale now; the figures that describe the
current tree (54 operations) contradict the candidate the artifact claims to audit; and the
migration figures (27, 49) match neither generation.

Severity: medium. Owner: canonical architecture artifact owner (W1).
Disposition: re-record `candidate.commit` against the commit the artifact actually describes, then
regenerate every prose figure in `compatibilityMatrix` and `persistenceParity` from the measured
inventory the tooling now reports, and make the audit assert the figures rather than stating them.

---

## 4. Contract, OpenAPI, schema, migration and SDK compatibility matrix

The canonical audit's `compatibilityMatrix` is the inventory of record. Its classification is
re-verified here against the current tree.

| ID                                     | Canonical classification | Independent verification at the base commit                                                                                                                           | Result                             |
| -------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `COMPAT-PUBLIC-OPERATIONS`             | verified                 | 54 SDK operations, 54 OpenAPI paths, 54 matching controller routes; 9 served routes unbound                                                                           | **contradicted in scope** — see A2 |
| `COMPAT-PACKAGE-LOCK`                  | verified                 | `bun.lock` workspace versions lag the manifests for 3 workspaces                                                                                                      | **contradicted** — see A4          |
| `COMPAT-POSTGRES-MIGRATIONS`           | verified                 | 74 SQL migrations and 74 journal entries, not "27 SQL migrations"                                                                                                     | **contradicted** — see A5          |
| `COMPAT-SQLITE-SCHEMA`                 | partially_verified       | `SCHEMA_VERSION` is 5, not 2                                                                                                                                          | **contradicted** — see A5          |
| `COMPAT-RUNTIME-MATRIX`                | verified                 | `bun run compatibility:check` parses `docs/runtime-compatibility/runtime-certifications.v1.json` (6 certifications, all `supported`) and every evidence path resolves | reproduced                         |
| `COMPAT-EXPORTS`                       | verified                 | `bun run check:boundaries` — 1229 files in 45 packages, 0 boundary violations                                                                                         | reproduced                         |
| `COMPAT-DEPENDENCY-DIRECTION`          | verified                 | no core→adapter dependency and no cycle in the discovered workspace graph                                                                                             | reproduced                         |
| `COMPAT-CODEOWNERS`                    | verified                 | `.github/CODEOWNERS` is a single wildcard rule (`* @0xPlayerOne`), not per-package ownership                                                                          | reproduced, coarse — see A6        |
| `COMPAT-CONTEXT-COMPILER-REACHABILITY` | partially_verified       | not re-verified here; owned by `context-integration` under #188                                                                                                       | open                               |
| `COMPAT-CORTANA-ADAPTER-REACHABILITY`  | partially_verified       | not re-verified here; owned by `context-integration` under #188                                                                                                       | open                               |
| `COMPAT-DOCUMENTATION`                 | partially_verified       | not re-verified here; owned by `documentation-governance` under #195                                                                                                  | open                               |

### Finding A4 — `bun.lock` records a stale version for three workspaces

| Workspace              | `package.json` | `bun.lock` | `release-please-manifest.json` |
| ---------------------- | -------------- | ---------- | ------------------------------ |
| `apps/control-api`     | 1.34.2         | 1.34.1     | 1.34.2                         |
| `apps/workflow-worker` | 1.18.2         | 1.18.1     | 1.18.2                         |
| `packages/telemetry`   | 1.8.2          | 1.8.1      | 1.8.2                          |

`COMPAT-PACKAGE-LOCK` is classified `verified` and names "bun.lock workspace versions" as one of
its representations, but no gate compared the lockfile version to the manifest version. The
architecture-audit tooling now reports this as a warning. It is reported as a warning rather than
an error because the frozen canonical artifact records the stale `lockVersion` values and turning
it into an error would fail the tree before the lockfile is repaired.

Severity: medium. Owner: the release and lockfile owner (release-please configuration and
`bun.lock`). Disposition: refresh `bun.lock` for the three workspaces and make the version
comparison an error once the canonical audit is re-baselined.

### Finding A5 — the canonical audit's migration and schema figures are stale

| Canonical row                     | Canonical text                                                                      | Actual at the base commit                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPAT-POSTGRES-MIGRATIONS`      | "27 SQL migrations"                                                                 | 74 SQL migrations (`packages/database/drizzle/0000_*.sql` … `0073_scope_version_pairing.sql`) and 74 entries in `packages/database/drizzle/meta/_journal.json` |
| `PERSIST-MIGRATIONS` (PostgreSQL) | "49 forward Drizzle migrations with schema drift check"                             | 74 forward migrations; `bun run db:check` (`drizzle-kit check`) reports "Everything's fine"                                                                    |
| `COMPAT-SQLITE-SCHEMA`            | "SCHEMA_VERSION=2"                                                                  | `SCHEMA_VERSION = 5` (`packages/sqlite-persistence/src/migrations.ts:169`), with ordered migrations 1–5                                                        |
| `PERSIST-MIGRATIONS` (SQLite)     | "Ordered atomic forward registry with applied SQL checksums and legacy v1 adoption" | v1 adoption plus v2 expiry indexes, v3 execution scope, v4 scope schema version, v5 project-required triggers                                                  |

The audit tooling never compared those figures with the tree, so the drift was invisible. The
tooling now measures the migration registry of both dialects on every run — PostgreSQL SQL files
against Drizzle journal entries, and the SQLite ordered migration versions — and reports the
measured inventory, so the next re-baseline uses recorded numbers rather than remembered ones.
A PostgreSQL registry whose SQL files and journal entries disagree is now an error.

Severity: medium. Owner: canonical architecture artifact owner (W1) with `database-migrations`.
Disposition: re-baseline the canonical audit against the measured inventory (74 PostgreSQL
migrations, SQLite `SCHEMA_VERSION` 5) and make the audit assert those figures mechanically.

### Finding A6 — CODEOWNERS is a single wildcard

`.github/CODEOWNERS` contains only `* @0xPlayerOne`. `COMPAT-CODEOWNERS` is classified `verified`
against a "repository ownership policy" and "CODEOWNERS", but the repository has no per-package
ownership, so the audit's 45-package inventory has no machine-readable owner. The audit records
domain ownership boundaries, but never compares any of them to `CODEOWNERS`.

Severity: low. Owner: repository administration. Disposition: either narrow the `verified`
classification or publish a per-package ownership file that the audit can check mechanically.

### SDK contract surface

`packages/contracts/src/versioning.ts:14` declares the current contract as major 3, and
`PublicContractManifest.supported` still lists majors 1, 2 and 3. `packages/control-sdk/openapi/`
ships `control-plane.v1.json`, `control-plane.v2.json` and `control-plane.v3.json`; only v3 is
regenerated from the SDK registry, and v1/v2 exist as frozen compatibility baselines.
`bun --cwd=packages/control-sdk run openapi:check` passes, so the published v3 document matches
its generator. `COMPAT-PUBLIC-OPERATIONS` nevertheless cites "OpenAPI v2" in its representations,
which is stale relative to the v3 document the audit actually reads.

Severity: low. Owner: canonical architecture artifact owner (W1). Disposition: refresh the
representation list to name the v3 document.

---

## 5. SQLite / PostgreSQL semantic parity matrix

The canonical `persistenceParity` rows are reproduced here with the parity verdict re-checked
against the current tree.

| ID                         | Canonical          | PostgreSQL                                                                               | SQLite                                                                                       | Re-verification                                                                   |
| -------------------------- | ------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `PERSIST-CATALOG`          | verified           | `PostgresCatalogRepository`                                                              | `SqliteVersionedCatalogRepository`                                                           | both repositories present and exported                                            |
| `PERSIST-COMMAND-INBOX`    | verified           | `PostgresCommandAcceptanceRepository` (typed columns, CAS)                               | `SqliteCommandAcceptanceRepository` (revisioned records)                                     | reproduced; SQLite CAS covered by `packages/sqlite-persistence` suite (369 pass)  |
| `PERSIST-CONTEXT-PACKAGE`  | verified           | `PostgresContextPackageRepository`                                                       | `SqliteContextPackageRepository`                                                             | both present                                                                      |
| `PERSIST-EXECUTION`        | verified           | typed execution/attempt tables                                                           | `SqliteExecutionRepository` (domain-validated JSON in revisioned records)                    | reproduced                                                                        |
| `PERSIST-EXECUTION-PLAN`   | verified           | `PostgresExecutionPlanRepository`                                                        | `SqliteExecutionPlanRepository`                                                              | both present                                                                      |
| `PERSIST-OUTBOX-EVENTS`    | verified           | inbox/outbox/execution-event tables                                                      | `SqliteExecutionEventRepository` (append, publication CAS, pending query, reopen durability) | reproduced; `packages/events` suite 24 pass                                       |
| `PERSIST-PROJECT-STATE`    | verified           | project state, revisions, mutations, receipts, proposals                                 | revisioned namespaces + `StatePromotionProposal` CAS                                         | reproduced                                                                        |
| `PERSIST-RECONCILIATION`   | verified           | `PostgresReconciliationCheckpointRepository`                                             | `SqliteReconciliationCheckpointRepository` (observation-hash idempotency, version CAS)       | reproduced; `tests/m9-production-hardening.test.mjs` 7 pass                       |
| `PERSIST-RUNTIME-COMMANDS` | verified           | runtime command/delivery/receipt/checkpoint repositories                                 | runtime command, event receipt/effect, checkpoint repositories                               | reproduced                                                                        |
| `PERSIST-BACKUP-RESTORE`   | partially_verified | operator/Neon backup + portability export/import; no `PersistenceProvider` backup method | online backup/restore with SHA-256 and `quick_check`                                         | reproduced; gap #194 stays open with `deployment-operations`                      |
| `PERSIST-MIGRATIONS`       | partially_verified | 74 forward Drizzle migrations + drift check                                              | ordered atomic registry with SQL checksums                                                   | reproduced; figure stale — see A5; gap #194 stays open with `database-migrations` |
| `PERSIST-RETENTION`        | partially_verified | typed expiry/soft-delete/publication metadata; deletion fails closed                     | schema v2 partial expiry indexes; automatic deletion blocked                                 | reproduced; figure stale — see A5; gap #194 stays open with `sqlite-retention`    |

**Finding A7 — the SQLite side is materially behind the PostgreSQL side on retention and
deletion, and the canonical row states it.** The canonical row already records "automatic
deletion blocked pending authoritative eligibility" for SQLite against a PostgreSQL side that has
typed expiry and deletion entry points. The parity verdict `partially_verified` with gap #194 and
owner `sqlite-retention` is accurate; this packet does not re-open it. No new parity gap was found
beyond the stale figures in A5.

---

## 6. Independent verification of retained state-machine, race and restart evidence

Every evidence path named by the canonical `lifecycleCoverage` rows exists, and each cited test
file was executed locally in this checkout.

| Concern                      | Canonical evidence                                                                                    | Local run                                                                                                                                                          | Result                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `state-machine-and-cas`      | `packages/sqlite-persistence/src/repositories.test.mjs`, `packages/database/src/integration.test.mjs` | `bun --cwd=packages/sqlite-persistence test` → 369 pass / 0 fail; `packages/database/src/integration.test.mjs` needs a live PostgreSQL instance, not executed here | SQLite CAS reproduced; PostgreSQL CAS not executed (no live database) |
| `approval-and-interaction`   | `tests/m3-durable-execution.test.mjs`                                                                 | `bun test tests/m3-durable-execution.test.mjs` (with m2/m10) → 14 pass / 0 fail                                                                                    | reproduced                                                            |
| `cancellation-and-timeout`   | `packages/domain/src/execution-lifecycle.test.mjs`                                                    | `bun --cwd=packages/domain test` → 193 pass / 0 fail                                                                                                               | reproduced                                                            |
| `idempotency-and-inbox`      | `tests/m10-portability-conformance.test.mjs`                                                          | included in the 14 pass above                                                                                                                                      | reproduced                                                            |
| `immutable-pinning`          | `tests/m2-core-domain.test.mjs`                                                                       | included in the 14 pass above                                                                                                                                      | reproduced                                                            |
| `outbox-and-event-delivery`  | `packages/events/src/delivery.test.mjs`                                                               | `bun --cwd=packages/events test` → 24 pass / 0 fail                                                                                                                | reproduced                                                            |
| `reconciliation-and-restart` | `tests/m9-production-hardening.test.mjs`                                                              | `bun test tests/m9-production-hardening.test.mjs` → 7 pass / 0 fail                                                                                                | reproduced                                                            |
| `retention-and-deletion`     | `packages/config/src/operational.test.mjs`                                                            | `bun --cwd=packages/config test` → 61 pass / 0 fail                                                                                                                | reproduced                                                            |

Package and export / provider boundary verification, run against the same tree:

| Gate                                    | Command                                                    | Result                                                                   |
| --------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| Workspace package/export boundary       | `bun run check:boundaries`                                 | `Checked 1229 files in 45 packages; 0 boundary violations`               |
| Digest writer ownership                 | `bun run check:digest-writers`                             | `digest writer check passed: 39 flows matched exact reviewed exceptions` |
| PostgreSQL migration drift              | `bun run db:check`                                         | `Everything's fine` (drizzle-kit check, 74 migrations)                   |
| Contract/SDK compatibility              | `bun run compatibility:check`                              | pass                                                                     |
| Published OpenAPI matches its generator | `bun --cwd=packages/control-sdk run openapi:check`         | pass                                                                     |
| Canonical ordering                      | `bun run check:canonical-ordering`                         | pass (part of the lint lane)                                             |
| Repository smoke lane (44 files)        | `bun scripts/run-bun-test-group.mjs smoke --timeout 30000` | 629 pass / 5 skip / 0 fail in 531 s                                      |

**These are local process results. They are not live profile acceptance.** The PostgreSQL
integration path (`packages/database/src/integration.test.mjs`) was not executed because it
requires a live database; it is recorded as an outstanding gate, not as a pass.

---

## 7. Dead ends, fakes and disabled bindings

| Kind                      | Instance                                                                                                                               | Where                                                                                                                                                        | Status                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Disabled binding          | 21 Control API capability bindings default to `Unavailable*`/`Disabled*`/`Empty*`                                                      | `apps/control-api/src/app.module.ts:227-333`                                                                                                                 | reported; see A3                                               |
| Disabled binding          | `UnavailableExecutionAcceptanceService` is the local composition's fallback when no activities and no runtime transport are configured | `apps/local-control-plane/src/composition.ts:481-484`                                                                                                        | already classified `partially_verified` in the canonical audit |
| Disabled binding          | `DisabledGraphSegmentActivities` throws `GRAPH_EXECUTION_DISABLED`                                                                     | `apps/workflow-worker/src/cloud-composition.ts:49-52`, `apps/local-control-plane/src/composition.ts:530`, `apps/hosted-control-plane/src/composition.ts:502` | already classified in the canonical audit                      |
| Disabled binding          | `createUnavailableRetirementEvidenceVerifier`                                                                                          | `apps/local-control-plane/src/retirement-evidence-verifier.ts:358`                                                                                           | local-only evidence absence                                    |
| Dead end (public surface) | 9 served routes with no SDK/OpenAPI binding, plus `GET /v1/components`                                                                 | section 2.2                                                                                                                                                  | reported; see A2                                               |
| Fake / stale record       | canonical audit migration and schema figures (27 / 49 / `SCHEMA_VERSION=2`)                                                            | section 4                                                                                                                                                    | reported; see A5                                               |
| Fake / stale record       | `bun.lock` workspace versions                                                                                                          | section 4                                                                                                                                                    | reported; see A4                                               |
| Fake / stale record       | `COMPAT-PUBLIC-OPERATIONS` cites "OpenAPI v2" while the audit reads v3                                                                 | section 4                                                                                                                                                    | reported; see A5                                               |
| Unverified binding        | `local` and `hosted-simple` share one digest                                                                                           | section 1                                                                                                                                                    | reported; see A1                                               |

No "fake" implementation was found — no stub that reports success while doing nothing. Every
unavailable implementation found throws or refuses explicitly.

---

## 8. Architecture-audit tooling repairs

All repairs are in `scripts/architecture-audit.mjs`. None of them changes the rendered report, so
the W1-owned `docs/architecture/control-plane-architecture.md` stays byte-identical and
`bun run architecture:check` keeps passing on the current tree.

| #   | Repair                                    | Before                                                                                                                                                                          | After                                                                                                                                                          |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Method-aware controller reachability      | `controllerPaths` held bare path strings and only `@Post` routes; `controllerReachable` matched on path alone, so a route served under a different verb satisfied the operation | `discoverControllerRoutes` records `{method, path, controller}` for every verb and reachability matches method **and** path                                    |
| T2  | Correct version resolution                | a controller whose version was not a quoted literal (for example `VERSION_NEUTRAL`) was dropped entirely, hiding `/health` and `/ready`                                         | `discoverVersioningDefaults` reads the application's own URI-versioning defaults; `VERSION_NEUTRAL` serves unversioned, an absent version inherits the default |
| T3  | Order-insensitive profile port comparison | `JSON.stringify` compared the port maps, so a semantically identical map with a different key order read as drift                                                               | comparison uses `canonicalJsonStringify` (code-point key order), which is what a map means                                                                     |
| T4  | Evidence containment                      | `access()` accepted any path, including absolute and `../` paths outside the repository, and accepted directories                                                               | evidence must be a repository-relative regular file inside the checkout                                                                                        |
| T5  | OpenAPI path-item filtering               | every key of an OpenAPI path item was treated as an operation, so a `parameters`/`summary` key would become a bogus public operation                                            | only HTTP verbs are treated as operations, and the operation ordering is stable                                                                                |
| T6  | Unbound OpenAPI operation detection       | the OpenAPI document was only searched for SDK operations; an OpenAPI operation with no SDK binding was invisible                                                               | it is now an error: `OpenAPI advertises an operation with no SDK binding: …`                                                                                   |
| T7  | Served-route gap detection                | unbound served routes were invisible                                                                                                                                            | reported as a warning with the exact method and path of every unbound route                                                                                    |
| T8  | Disabled-binding discovery                | the `Unavailable*` default family and the per-profile binding matrix were invisible                                                                                             | discovered from the Control API module and reported per profile                                                                                                |
| T9  | Persistence parity inventory              | `persistenceParityInventory` was unvalidated dead data                                                                                                                          | it must now agree with the parity rows it summarises                                                                                                           |
| T10 | Workspace/lockfile version comparison     | only the release-please manifest was compared with the manifests                                                                                                                | the Bun lockfile version is compared too, and drift is reported                                                                                                |
| T11 | Composition digest collision              | `local` and `hosted-simple` sharing a digest was invisible                                                                                                                      | reported as a warning                                                                                                                                          |
| T12 | Measured migration inventory              | the canonical audit's migration and schema figures were never compared with the tree                                                                                            | both dialects are measured on every run, the measured inventory is reported, and a PostgreSQL registry whose SQL files and journal disagree is an error        |

### 8.1 Corrections after the base head

Three further repairs were made after the base head, each from a root review of the published
draft pull request. They are recorded here so this packet stays complete; the full evidence for
each is in `docs/evidence/m11-architecture-audit-binding-detector-handoff-2026-10-21.md`.

| #   | Repair                               | Before                                                                                                                           | After                                                                                                                       |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| T13 | Binding detector reads parsed source | the detector matched names, so a commented example, a type-only declaration or an explicit `undefined` binding read as a binding | the source is parsed, so only a runtime object-literal assignment binds; a comment, a type or an `undefined` value does not |
| T14 | Evidence containment by real path    | the evidence check resolved the path, verified containment lexically and then followed symlinks for the file test                | the root and the target are compared as canonical real paths, so an in-tree symlink pointing outside is rejected            |
| T15 | Parse cache identity                 | the parse cache was keyed by the relative path and validated by size and modification time, so two roots could share an entry    | the entry is keyed by the canonical target path and validated by the content hash                                           |

None of the three changes a measured value: the architecture audit's complete output stays
byte-identical, and the per-profile capability matrix stays as section 2.3 records it.

New exports used by the regression file: `discoverVersioningDefaults`, `discoverControllerRoutes`,
`discoverCapabilityBindings`, `bindsCapabilityOption`, `discoverMigrationInventory`,
`evidencePathError` and `discoverPublicOperations`.

### Deterministic negative drift checks

`scripts/m11-architecture-audit-regression.test.mjs` (new, dedicated) contains 29 tests. Each one
mutates a clone of the canonical audit, of the discovered state, or of a synthetic fixture, and
asserts that the tooling fails closed. None of them edits the canonical artifact, and none of them
writes into the checkout: the fixtures are built in a temporary directory and removed afterwards.

| Test                                                                          | Asserts                                                                                                                                                  |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| canonical audit validates                                                     | zero errors on the current tree                                                                                                                          |
| generated report stays byte-identical                                         | the repaired tooling still renders the W1-owned report unchanged                                                                                         |
| method-aware reachability                                                     | the same path under a different verb is **not** reachable; a removed route is **not** reachable                                                          |
| every served verb discovered                                                  | `GET /health`, `GET /ready`, `GET /v1/system/echo`, `POST /v1/…`, `POST /v3/…` are all discovered; every discovered route is a verb and an absolute path |
| OpenAPI documentation keys ignored                                            | a `PARAMETERS` path-item key produces no operation and no error                                                                                          |
| unbound OpenAPI operation rejected                                            | error `OpenAPI advertises an operation with no SDK binding: POST /v1/not-in-the-sdk`                                                                     |
| reordered port map accepted, rebinding rejected                               | key order alone is not drift; a changed binding value is drift                                                                                           |
| evidence rejected when it escapes, is absolute, is a directory, or is missing | four distinct errors                                                                                                                                     |
| persistence parity inventory drift rejected                                   | error `persistence parity inventory drifted from the persistence parity rows`                                                                            |
| served routes without an SDK binding surfaced                                 | the exact nine routes are named in the warning, and no tenth is invented                                                                                 |
| capability bindings pinned                                                    | the 21 disabled options and the four per-profile unbound sets are pinned, so a composition change fails the test                                         |
| binding scan is not fooled                                                    | type members, member access and `options.x` are not bindings; object keys and shorthand properties are                                                   |
| shared digest reported                                                        | the `local`/`hosted-simple` collision is named                                                                                                           |
| lockfile version drift reported                                               | a mutated `lockVersion` produces the warning                                                                                                             |
| migration registry measured                                                   | SQL files and Drizzle journal entries agree, the last tags match, and the SQLite versions are ordered and contiguous                                     |
| migration registry drift rejected                                             | error `PostgreSQL migration registry drifted: …` when the SQL files and journal entries disagree                                                         |
| commented binding is not a binding                                            | a line comment, a block comment and a trailing comment do not bind; a comment beside a real binding does not hide it                                     |
| type-only declaration is not a binding                                        | a `type` alias, an `interface`, an optional member and a class property signature do not bind                                                            |
| explicit `undefined` is not a binding                                         | `undefined`, `void 0` and a shorthand over an `undefined` variable do not bind; `undefined ?? fallback` does                                             |
| real runtime bindings are retained                                            | an object key with a real value, a shorthand, a shorthand over a declared value, a conditional spread guard and a quoted key all bind                    |
| a comment cannot conceal a missing default in a real profile source           | a commented binding appended to the real `apps/control-api/src/index.ts` is still not read as a cloud binding                                            |
| per-profile binding counts pinned                                             | the measured counts (20 / 13 / 16 / 16) and the disjointness of each profile's bound and unbound sets                                                    |
| evidence symlink that escapes the repository is rejected                      | an in-tree symlink to an outside target is rejected directly and end to end                                                                              |
| ordinary in-tree evidence is retained                                         | a regular in-tree file and an in-tree symlink that stays inside the root remain citable                                                                  |
| unresolvable evidence path is rejected                                        | a symlink loop is rejected as unresolvable rather than mistaken for a missing file                                                                       |
| two checkout roots are parsed separately                                      | two roots whose files share a relative path, byte length and modification time but differ in content produce different answers                           |
| a changed source is re-parsed                                                 | the same path rewritten with the same byte length and modification time is parsed again                                                                  |
| the conservative first-declaration rule is documented                         | a shadowed shorthand resolves by file order, not by lexical scope; the limit is pinned so it stays visible                                               |

---

## 9. Findings routed to exact source owners

No runtime, migration, requirement or composition file was changed. Every finding below is routed
to the owner of the exact source that owns the fix.

| Finding                                                           | Exact owner                                                                           | Severity        | Disposition                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| A1 shared `local`/`hosted-simple` digest                          | canonical architecture artifact owner (W1) with the local runtime owner               | medium          | distinct digest-covered composition sources                                           |
| A2 nine served routes unbound (plus `GET /v1/components`)         | Control API operation registry owner; canonical artifact owner (W1) for the audit row | high / low      | bind in the SDK and OpenAPI, or record as deliberately non-SDK public operations      |
| A3 capability binding matrix absent                               | profile composition owners and the Control API module owner                           | high            | bind or retire each capability per profile; record the matrix                         |
| A4 `bun.lock` workspace version drift                             | release and lockfile owner                                                            | medium          | refresh `bun.lock`; promote the comparison to an error after re-baseline              |
| A5 stale migration / schema / OpenAPI figures                     | canonical artifact owner (W1) with `database-migrations`                              | medium          | re-baseline from the measured inventory                                               |
| A6 CODEOWNERS is a single wildcard                                | repository administration                                                             | low             | narrow the classification or publish per-package ownership                            |
| A7 SQLite retention/deletion parity                               | `sqlite-retention` (existing #194 gap)                                                | high (existing) | unchanged; already open under #194                                                    |
| A8 recorded candidate does not describe the artifact              | canonical architecture artifact owner (W1)                                            | medium          | re-record the candidate and regenerate every prose figure from the measured inventory |
| A9 IPC/relay/tool-gateway entry surfaces have no reachability row | runtime gateway, relay and tool gateway owners with the canonical artifact owner (W1) | medium          | add per-profile reachability rows for the IPC, relay and tool-gateway surfaces        |

### Exact-path custody note

`scripts/architecture-audit.mjs` and the new regression file were checked against the shared
cross-fleet ownership index (`/tmp/opencode-three-fleet-20261020-fresh/data/cross-fleet-ownership.json`,
read 2026-10-21, `updatedAtUtc` 2026-10-21T10:03:30Z) and the Fleet 2 ledger
(`/private/tmp/opencode-fleet-2-20261021/data/ownership-ledger.json`). The index records F2W3's
claim on `scripts/architecture-audit.mjs` with no competing owner; no other indexed path refers to
the audit script or to the new regression file. The Claude lane section of that index records
`adea-ai/adea` paths and does not establish custody over `adea-ai/control-plane`, and the ledger
records the Claude custody state as unverified. Neither the canonical architecture artifact, the
generated report, `tests/m11-architecture-audit.test.mjs`, nor the lane registration file was
touched.

**Collision to report, not resolve — the new regression file cannot live in `tests/`.** The
repository's lane system requires every `tests/**` file to be registered:

- `scripts/run-bun-test-group.mjs` (`discoverTestInventory`) walks `apps/`, `packages/` and
  `tests/` only, so it never sees a `scripts/**/*.test.mjs` file at all. Such a path is in neither
  the discovered set nor any lane list, so it is reported neither as `unowned` nor as `missing`,
  and the drift check stays silent about it.
- `tests/repository.test.mjs` asserts the `e2e` and `smoke` lane lists by exact deep equality, so
  a registration also has to be mirrored into that file.

Both files are shared test-runner and Code Foundry artifacts outside this worker's owned paths
(the lane registration is explicitly excluded), and both belong to the test-runner owner. A file
under `apps/` or `packages/` is not an alternative: `scripts/workspace-boundaries.mjs` rejects a
relative import that leaves the package directory, so a test there cannot import
`scripts/architecture-audit.mjs` at all. The regression file therefore lives next to the tool it
tests, at `scripts/m11-architecture-audit-regression.test.mjs`, following the existing precedent
`scripts/runtime-node-identity-admin.test.mjs`.

**Consequence for the runner owner:** `scripts/` is outside the lane system
(`testRoots = ['apps', 'packages', 'tests']`), so the file is neither lane-registered nor covered
by `oxlint --deny-warnings tests`, and the lane drift check is blind to it: a path outside
`testRoots` is in neither the discovered set nor any lane list, so it is reported neither as
`unowned` nor as `missing`. To make it a CI lane member, the runner owner has to extend the
lane roots to `scripts/` — or move the file into a covered root and register it in
`scripts/run-bun-test-group.mjs` and `tests/repository.test.mjs` together. Until
that happens the file runs with
`cd scripts && bun test --timeout 30000 m11-architecture-audit-regression.test.mjs`.

---

## 10. Reproducing this packet

The focused, static checks that cover the owned tooling are the first block. They need only Bun
and the workspace `node_modules`; they do not need a workspace build, a coverage run or a live
service. The full lane block follows for a checkout that is allowed to build and run the wider
suite.

```
bun scripts/architecture-audit.mjs                                        # canonical audit; warnings are the findings above
bun test tests/m11-architecture-audit.test.mjs                            # existing owner coverage
cd scripts && bun test --timeout 30000 m11-architecture-audit-regression.test.mjs   # new regression coverage
cd .. && bun x oxfmt --check scripts/architecture-audit.mjs scripts/m11-architecture-audit-regression.test.mjs
cd .. && bun x oxlint --deny-warnings scripts/architecture-audit.mjs scripts/m11-architecture-audit-regression.test.mjs
```

The wider suite (a workspace build, a full lint lane, the smoke lane and the package test suites)
was last run at the head recorded in
`docs/evidence/m11-architecture-audit-binding-detector-handoff-2026-10-21.md`. Re-running it needs
cross-fleet capacity to be rechecked first.

```
bun install --frozen-lockfile
bun run build
bun run check:boundaries
bun run check:digest-writers
bun run db:check
bun run compatibility:check
bun --cwd=packages/control-sdk run openapi:check
bun --cwd=packages/domain test
bun --cwd=packages/events test
bun --cwd=packages/config test
bun --cwd=packages/sqlite-persistence test
bun test tests/m2-core-domain.test.mjs tests/m3-durable-execution.test.mjs tests/m10-portability-conformance.test.mjs
bun test tests/m9-production-hardening.test.mjs
```

Final-candidate readback (section 3):

```
git cat-file -e 6c922d487c3c2e70a047c11c55a1cb4ddbabad26^{commit}
git merge-base --is-ancestor 6c922d487c3c2e70a047c11c55a1cb4ddbabad26 27f17bd55e0266439b5b3089163195c9e7a669be
git ls-tree --name-only <candidate> packages/database/drizzle/ | grep -c '\.sql$'
git show <candidate>:packages/control-sdk/src/operations.ts | grep -c "operation: '"
git show <candidate>:packages/sqlite-persistence/src/migrations.ts | grep -c 'version: [0-9]*, statements:'
```

The canonical audit reports these warnings on the current tree:

```
workspace package versions drifted from the Bun lockfile: apps/control-api 1.34.2/1.34.1, apps/workflow-worker 1.18.2/1.18.1, packages/telemetry 1.8.2/1.8.1
Control API serves 9 HTTP route(s) with no SDK operation binding: …
Control API exposes 21 capability binding(s) that default to an unavailable implementation: …
cloud: never binds 2 capability binding(s) …
hosted-server: never binds 8 capability binding(s) …
hosted-simple: never binds 5 capability binding(s) …
local: never binds 5 capability binding(s) …
profiles local and hosted-simple share one composition source digest …
measured migration inventory: PostgreSQL 74 migration(s) up to 0073_scope_version_pairing.sql, SQLite schema version 5
```

---

## 11. Outstanding gates — explicitly not claimed

1. **Live profile gates.** No profile was deployed, no provider was called, no Railway/Neon/Restate
   deployment was exercised, and no live Pi or ACP runtime was driven. Every profile row in the
   canonical audit stays `partially_verified`, and this packet does not upgrade any of them.
2. **Final-candidate readback against a frozen integrated candidate.** The readback in section 3
   compares the canonical audit's recorded candidate `6c922d487c3c2e70a047c11c55a1cb4ddbabad26`
   (2026-10-01) with this branch's base `27f17bd5`. It does **not** compare against a frozen
   _integrated_ candidate that includes the other workers' changes, because no such candidate
   exists in this checkout: the branches of the other Fleet 2 workers and the Fleet 1/3 work are
   separate and no integrated head is available here. Re-reading the audited surfaces against that
   integrated candidate stays an open gate for the canonical artifact owner.
3. **#186 reconciled snapshot.** `bun run requirements:check` requires an authenticated GitHub CLI
   to read the issue set; no credential is available in this environment, so the gate could not be
   run and the reconciled #186 snapshot was **not** consumed. The requirements ledger and every
   `docs/requirements/**` file stay with their owner.
4. **PostgreSQL integration path.** `packages/database/src/integration.test.mjs` was not executed
   (no live database). It remains an outstanding gate, not a pass.
5. **Canonical artifact re-baseline.** A1, A2, A3, A5, A6 and A8 all require the canonical
   architecture artifact and its generated report, which stay with their owner until an explicit
   handoff.
6. **Lane registration.** The new regression file is not in any CI lane, and is not covered by
   `oxlint --deny-warnings tests`, because `scripts/` is outside the lane system (section 9). The
   runner owner decides whether to extend the lane roots to `scripts/` or to move and register the
   file in a covered root.
7. **Draft PR.** No draft pull request was created: this environment has no valid GitHub
   credential (the `gh` token is invalid, there is no git credential for `github.com`, no SSH key
   and no `.netrc` entry for GitHub), and creating one is out of scope. The change is committed
   locally on `f2w3/cp187-architecture-audit` for root to review and publish.
8. **Human gates.** No human acceptance, review, sign-off, provider qualification or deployed
   confirmation is claimed anywhere in this packet.

---

## 12. State of this packet at the current head

The four owned files on `f2w3/cp187-architecture-audit` are:

| Path                                                                          | Role                                                                                      |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `scripts/architecture-audit.mjs`                                              | the audit tooling: discovery, the canonical validation and the report renderer            |
| `scripts/m11-architecture-audit-regression.test.mjs`                          | the dedicated regression file: 28 deterministic negative drift checks                     |
| `docs/evidence/m11-architecture-reachability-trace-2026-10-21.md`             | this packet                                                                               |
| `docs/evidence/m11-architecture-audit-binding-detector-handoff-2026-10-21.md` | the handoff packet for the three root-review corrections and the proposed CI lane handoff |

**What this packet establishes.** The four-profile reachability trace, the contract, OpenAPI,
schema, migration and SDK compatibility matrix, the SQLite and PostgreSQL parity matrix, the dead
ends and disabled bindings, and the findings routed to their exact source owners. Every one of those
is a **static inventory** result over the tree at the base commit, reproducible with the commands in
section 10.

**What this packet does not establish.** No profile was deployed, no provider was called, no
runtime was exercised and no artifact was published. The per-profile statements are not
runtime-profile proof, and none of the four canonical profile rows is upgraded by this packet. The
live profile gates in section 11 stay open, and CP #187 is not complete on the strength of this
packet.

**What changed after the base head.** Three corrections from root's review of the published draft
pull request, recorded in section 8.1 and evidenced in the handoff packet. None of them changes a
measured value: the architecture audit's complete output is byte-identical across the reviewed
heads, and the capability matrix in section 2.3 is unchanged.

## 13. Canonical CI discovery path for this regression suite (reproducible evidence)

**The canonical CI does not discover or run this regression suite, and the fix is one line in a
shared runner this branch does not own.** Nothing in this section edits that runner; the
registration is proposed in 13.3 for root's decision.

### 13.1 The facts, and how to reproduce them

Canonical validation runs the repository's lane scripts — `bun scripts/run-bun-test-group.mjs
<lane>` — and the lane discovery walks these roots only:

```js
const sourceRoots = ['apps', 'packages'] // the unit lane
const testRoots = [...sourceRoots, 'tests'] // the integration lane
```

This suite lives at `scripts/m11-architecture-audit-regression.test.mjs`, which is **outside every
discovery root**. Three reproducible confirmations:

```console
$ grep -n "const sourceRoots\|const testRoots" scripts/run-bun-test-group.mjs
9:const sourceRoots = ['apps', 'packages']
10:const testRoots = [...sourceRoots, 'tests']

$ for r in apps packages tests scripts; do printf "%-9s " "$r"; ls "$r/m11-architecture-audit-regression.test.mjs" 2>/dev/null || echo "(absent)"; done
apps      (absent)
packages  (absent)
tests     (absent)
scripts   scripts/m11-architecture-audit-regression.test.mjs

$ grep -n "root" bunfig.toml
2:root = "tests"

$ bun test scripts/m11-architecture-audit-regression.test.mjs      # from the repository root
The following filters did not match any test files in --cwd="<repository>":
 scripts/m11-architecture-audit-regression.test.mjs
125 files were searched [8.00ms]
$ echo $?
1
```

The last one is the sharpest statement of the gap: bun's own root-scoped discovery does not match
the file, and that invocation **exits 1** with the unmatched-filter message above. That
invocation is loud rather than silent, so a person who runs it from the repository root sees the
gap immediately; what stays silent is the canonical lane, which never discovers the file at all.
The suite is reachable only from its own directory:

```console
$ cd scripts && bun test m11-architecture-audit-regression.test.mjs
 29 pass
 0 fail
 199 expect() calls
Ran 29 tests across 1 file. [1.29s]
```

The contrast that shows the audit itself is covered: the architecture audit's **own** test is
registered in the lane runner (`scripts/run-bun-test-group.mjs:76` →
`tests/m11-architecture-audit.test.mjs`), so the audit runs in CI while its regression suite does
not.

### 13.2 The suite is reproducible at this head

Three consecutive runs at `bcea5ae46bd30179b66124b76e76ea9528a7b266`:

| Run | Result                               | Wall   |
| --- | ------------------------------------ | ------ |
| 1   | 29 pass / 0 fail, 199 expect() calls | 1.62 s |
| 2   | 29 pass / 0 fail                     | 1.33 s |
| 3   | 29 pass / 0 fail                     | 1.14 s |

The suite covers the three contract areas this branch owns: the **parser** (reachability by HTTP
method, served-verb discovery, OpenAPI path-item keys, unbound operations, capability bindings,
reordered profile port maps), the **cache isolation** (two checkout roots whose files share a path,
size and time, and a source whose contents change while its size and time do not) and the
**symlink escape** (an in-tree symlink pointing outside the repository is rejected, an in-tree
symlink is still citable, a resolution loop is refused, a directory is not a file).

### 13.3 The minimal registration proposed for root (not applied)

The registration belongs to the shared lane runner, which this branch must not edit, so it is
proposed rather than applied. The narrowest change that gives the file a canonical lane without
touching any other owner's file:

```diff
--- a/scripts/run-bun-test-group.mjs
+++ b/scripts/run-bun-test-group.mjs
@@ const repositoryRoot
 const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
 const sourceRoots = ['apps', 'packages']
 const testRoots = [...sourceRoots, 'tests']
+// Test files that live outside the discovery roots but belong to the unit lane.
+// Registered one by one so no other owner's file changes lane membership.
+const extraUnitTestFiles = ['scripts/m11-architecture-audit-regression.test.mjs']
 const repositoryGroups = {
@@ export async function discoverTestFiles(group)
     .filter(
       (path) => path.endsWith('.test.mjs') && isIntegrationTest(path) === (group === 'integration')
     )
     .map((path) => relative(repositoryRoot, path))
+    .concat(group === 'unit' ? extraUnitTestFiles : [])
     .toSorted()
```

Effect: the file joins the **unit** lane (its measured cost is about 1.3 s of that lane's ceiling),
`discoverTestInventory` owns it, so the lane inventory reports no unowned or missing file, and the
hardcoded e2e/smoke lists with their per-file cost tables stay untouched. The alternative — adding
`scripts` to `sourceRoots` — would also move `scripts/runtime-node-identity-admin.test.mjs`, which
belongs to another owner, into the unit lane, so it is not proposed.

**This packet does not establish CI coverage for the regression suite.** Until the registration is
approved and applied by the shared runner's owner, the suite runs only when it is invoked directly
from `scripts/`, and the canonical CI cannot fail on a regression in it.

### 13.4 The discovery result is check-bound, and no owned registration path exists

Two facts are now recorded by a check rather than by prose, so neither can silently rot.

**The discovery result is check-bound.** The owned regression file now contains
`binds the canonical lane discovery result for this regression suite`. It imports the shared lane
runner read-only — `scripts/run-bun-test-group.mjs` is never edited — and asserts three things at
the current head:

| Assertion                                          | Verified value                                                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the suite is in no canonical lane                  | `unit` false, `integration` false, `e2e` false, `smoke` false                                                                                                        |
| the lane drift check does not name it              | `discoverTestInventory()` does not throw, and no drift message contains the suite's path, so the file is reported neither as `unowned` nor as `missing`              |
| the architecture audit's own test is still covered | `tests/m11-architecture-audit.test.mjs` **is** in the `smoke` lane, and the canonical Code Foundry Validation / Gate runs the unit, integration, E2E and smoke lanes |

The first assertion is the drift signal. It **fails the moment the shared runner registration is
applied**, because the direct invocation and the proposal in 13.3 are then stale. That was verified
against a scratch copy of the runner with the registration applied: the lane then reports the
suite, and the shared runner file itself was byte-identical before and after that probe.

**No owned registration path exists.** The unit lane would discover a `packages/**` or `apps/**`
test by itself, but the suite cannot live there: `scripts/workspace-boundaries.mjs` rejects an
import that leaves the package directory. That was confirmed by probe rather than by reading: a
throwaway file at `packages/contracts/src/_cp190_boundary_probe.mjs` importing
`../../../scripts/architecture-audit.mjs` produces

```
packages/contracts/src/_cp190_boundary_probe.mjs: import ../../../scripts/architecture-audit.mjs leaves @control-plane/contracts
```

and `bun run check:boundaries` exits 1. The probe file was removed and the checkout was clean
afterwards. A `tests/` placement would need registration in the shared runner and in
`tests/repository.test.mjs`, and `scripts/` is outside every discovery root. **Every remaining
route to a canonical lane therefore crosses a shared file**, which is why this branch proposes the
registration in 13.3 instead of applying it.

---

## 14. The external half of the inward rule (CP #187 acceptance)

### 14.1 The gap

CP #187's acceptance criteria state: "No core package directly requires Neon, R2, Railway,
Redis/Valkey, Runtime Gateway transport, OS keychain, or another deployment implementation."

The audit proved the **workspace** half of that rule — a `core-port` package may not depend on an
`adapter-infrastructure` workspace package (the core/adapter loop in `validateArchitectureAudit`).
It never read a core package's **external** dependencies, even though the discovery already records
them (`externalDependencies`, rendered in the package table of the canonical report). A core package
could therefore require a deployment implementation directly — `postgres` for Neon/PostgreSQL,
`@aws-sdk/client-s3` for R2, a Redis or Valkey client, `keytar` for the OS keychain, or the HPKE
remote transport — and the canonical audit still validated with no error. The rule was therefore
narrower than the acceptance criterion it exists to prove.

### 14.2 The correction

`scripts/architecture-audit.mjs` now checks the external half of the same rule against an explicit,
reviewable list of the npm packages that bind the named implementations. A **development**
dependency is not shipped with the package and is not checked; the workspace half is unchanged.

| Rule                                                         | Message                                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| A core package requires a deployment implementation directly | `<package>: core package depends on deployment implementation <dependency>` |

The list is `postgres`, `@neondatabase/serverless`, `@aws-sdk/client-s3`, `ioredis`, `redis`,
`@valkey/valkey-glide`, `keytar`, `@hpke/core` and `@hpke/dhkem-x25519`. Railway is
repository-owned deployment configuration rather than a package, so it stays covered by the profile
configuration rules. No measured value changes: the canonical audit still validates with no errors
(`Validated 45 packages, 54 operations, and 4 profiles`), and the package table is unchanged.

### 14.3 The regressions

`scripts/m11-architecture-audit-regression.test.mjs` gains two deterministic cases:

- `rejects a core package that directly requires a deployment implementation` — a core package that
  declares `postgres` fails the audit with the new message.
- `does not read a development dependency as a deployment implementation` — the same package in its
  development dependencies does not fail the rule.

The first case fails when the new rule is removed and passes with it; the second passes in both
states, which is what makes the development-dependency distinction a pinned rule rather than an
accident.

### 14.4 What this section does not claim

- **No live acceptance.** The rule is proved by source regressions over synthetic package
  inventories. It certifies the audit's own detection, not a deployed profile: every profile row
  stays `partially_verified`, and no provider, database, deployment or native session was used.
- **No shared-runner change.** The lane registration proposed in 13.3 is still only proposed. This section
  edits no CI workflow, no lane registration and no file owned by the shared runner's owner; the
  regression suite still runs only when invoked directly from `scripts/`.
- **No PostgreSQL integration.** The rule is about dependency declarations, not migrations or a
  live database.
- **No human, provider or production acceptance** is claimed, and CP #187 is not closed.
