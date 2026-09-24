# Architecture baseline

The Control Plane is a TypeScript modular monolith with independently deployable composition roots. Stable domain and contract packages point inward; infrastructure and vendor integrations attach through adapter-bound ports. The same core execution semantics are required across the managed-cloud, Local, and Hosted deployment profiles.

## System ownership

| System                 | Owns                                                                                                                                                                                         | Does not own                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Adea**               | Product identity, workspace authorization, persistent user-facing Agents/Tasks, RuntimeNode registration, product events, execution-location UX, and web/mobile remote coordination          | Control Plane execution policy, ProjectState, durable workflow semantics, or provider corpora |
| **Control Plane**      | AgentProfile/Skill resolution, ProjectState, ContextPackages, ExecutionPlans, durable execution, runtime/tool/model/provider policy, orchestration, usage, and normalized execution evidence | Adea product tables/UI state or Cortana corpus/native memory                                  |
| **RuntimeNode / host** | Concrete execution location and RuntimeDriver/local-service capabilities                                                                                                                     | Product authorization or Control Plane routing/orchestration policy                           |
| **Concrete harness**   | Native agent loop, native sessions, provider authentication, harness-local tools/configuration                                                                                               | Stable Control Plane contracts or product identity                                            |
| **ContextProvider**    | Separately owned evidence/memory/corpus and provider-specific authorization                                                                                                                  | ProjectState or Control Plane execution authority                                             |

Cross-product integration uses public/versioned contracts. No product reads another product's database directly or treats another product's storage credentials as its own authority.
This is the no-cross-database-access rule.

## Repository ownership

- `apps/control-api` owns synchronous API composition and health endpoints.
- `apps/workflow-worker` is the Restate durable-workflow composition root for the managed-cloud profile.
- `apps/runtime-worker` owns separated Hosted/server runtime-worker composition where that topology is required.
- `apps/runtime-gateway` owns transport for non-co-located RuntimeNodes.
- `apps/tool-gateway` owns tool-facing Hosted/server composition where separated deployment is required.
- `packages/domain`, `contracts`, `events`, `execution-plan`, `policy`, `context`, `runtime-sdk`, and `tool-sdk` own stable models and ports.
- `packages/database`, `telemetry`, `bootstrap`, and named adapters own infrastructure details.

Applications may select concrete adapters. Stable packages must not import applications, provider-specific deployment SDKs, or another package's source tree.

## Deployment profiles and milestone sequence

The accepted implementation sequence is:

1. **M9 — Managed Cloud Deployment, Hardening & Evals:** establish a working Railway + Neon + R2 + Restate managed-cloud reference and freeze deployment-independent contracts/behavior.
2. **M10 — Local & Hosted Portability:** extract/consume infrastructure ports and add Local/Hosted adapters while preserving the M9 semantic baseline.
3. **M11 — Feature Completion & Production Audit:** independently audit managed cloud, Local, and Hosted as one portable product.
4. **M12 — Cross-Product Integration & Release:** connect independently approved Adea and optional Cortana release candidates.

This implementation order is distinct from Adea product rollout. The Control Plane cloud profile is implemented in M9 even though `agent_hq_cloud` remains a later user-visible Adea execution-location option.

### Managed cloud — M9 reference

- Railway compute/service lifecycle.
- Separate Control Plane Neon PostgreSQL.
- Cloudflare R2 through the S3-compatible `ObjectStore` boundary. The current Control Plane resource is bucket `ctrl-plane` with Wrangler binding `ctrl_plane`; these identifiers are deployment configuration, not domain identity.
- Restate as the canonical durable workflow runtime for cloud and hosted profiles.
- Railway private networking for internal service calls where applicable.
- Railway service/shared variables for bootstrap/service configuration.
- Dynamic connector/provider credentials remain behind the credential-vault secret boundary rather than becoming per-user environment variables.

Control Plane R2 storage and Adea Artifact storage are separate authorities even if they use the same Cloudflare account/provider. Each product uses separately scoped buckets/environment sets and credentials; Control Plane's `ctrl-plane` bucket is not Adea Artifact storage.

**Promotion triggers and the production deploy step.** A published `workspace-v*` release (and manual dispatch with a `workspace-v*` tag) triggers `container-promotion.yml` to validate the tagged candidate, build the images, scan them, publish to GHCR, attest the digest, and then promote the attested digests to Railway production. The deploy step's trigger is the event, not the release: a published `workspace-v*` release deploys production automatically as part of the same promotion run, while a manual `workflow_dispatch` deploys only when invoked with `deploy: true` (the replay path for re-promoting an already-attested release). Deploy verification requires Railway to report the promoted `image@sha256:…` source **and** digest on both production services; `/health` must then report the release's commit (baked as `SOURCE_SHA` → image `COMMIT_SHA`, no service-level pin), `/ready` must answer 200, and unauthenticated `/v1` requests must fail closed with 401.

**Production image build path (canonical).** `.github/workflows/container-promotion.yml` builds the `control-api` and `workflow-worker` release images once from the repository's digest-pinned `infrastructure/containers/Dockerfile`, with the deployable service selected by the baked `APP_NAME`. Before publication, that exact local image passes the pinned Trivy CRITICAL/HIGH gate and produces a CycloneDX SBOM. The workflow then publishes it to the public GHCR release namespace, records and attests the registry digest, and changes each Railway production service to the corresponding `image@sha256:…` source. Deployment verification requires Railway to report both that exact source reference and digest. Railway source builds and Railpack inference are not supported production paths.

### Local — M10, Restate-free since CP1 (#548)

- all-in-one Control Plane composition;
- Node 24 `node:sqlite` through Drizzle behind `PersistenceProvider`;
- embedded SQLite durable queue and in-process workflow runtime serving the same workflow contracts as Restate;
- filesystem object storage;
- direct co-located RuntimeTransport/RuntimeDriver path;
- no Docker, PostgreSQL, Redis/Valkey, Temporal, or Runtime Gateway requirement for ordinary execution.

### Hosted — M10

- `simple`: all-in-one + SQLite + Restate + filesystem storage;
- `server`: PostgreSQL + Restate + filesystem or S3-compatible storage, with split services/Runtime Gateway only where topology requires them;
- user-controlled secrets, data, host, and deployment lifecycle.

## Technology decisions

| Technology        | Status                                     | Current architectural decision                                                                                                                        |
| ----------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript        | accepted                                   | Primary application and package language under strict workspace settings.                                                                             |
| NestJS            | accepted                                   | HTTP/service composition and dependency-injection framework where server composition requires it.                                                     |
| Fastify           | accepted                                   | HTTP adapter beneath NestJS and for lightweight transport boundaries.                                                                                 |
| PostgreSQL        | accepted server/cloud adapter              | Neon for the M9 managed-cloud profile; recommended for Hosted `server`.                                                                               |
| SQLite            | accepted Local/simple adapter              | Node 24 `node:sqlite` + Drizzle for M10 Local and Hosted `simple`.                                                                                    |
| Drizzle           | accepted                                   | Persistence schema/migration layer behind deployment-specific adapters.                                                                               |
| Restate           | accepted canonical workflow runtime        | Cloud and hosted profiles; M9.8 establishes the Railway implementation. Local runs the same workflow contracts on the embedded SQLite queue (#548).   |
| Temporal          | historical migration provenance            | Not an accepted release dependency or active runtime.                                                                                                 |
| LangGraph         | adapter-bound                              | Optional bounded graph/multi-agent execution inside a Restate-owned durable lifecycle.                                                                |
| Pi                | adapter-bound                              | Default managed harness behind RuntimeAdapter/RuntimeDriver contracts.                                                                                |
| ACP               | adapter-bound                              | External-harness interoperability protocol.                                                                                                           |
| MCP               | adapter-bound                              | Tool interoperability adapter; not the internal authority model.                                                                                      |
| LiteLLM           | adapter-bound                              | Initial managed model-gateway adapter where required.                                                                                                 |
| E2B               | adapter-bound                              | Initial hosted isolated-compute adapter.                                                                                                              |
| Railway           | accepted initial managed-cloud compute     | M9 first-party cloud target; provider-specific details remain outside domain contracts.                                                               |
| Neon              | accepted managed-cloud PostgreSQL provider | Separate Control Plane project/database; explicit migrations and least-privilege runtime authority.                                                   |
| Cloudflare R2     | accepted managed-cloud object store        | Control Plane current bucket `ctrl-plane`; explicit cloud storage only, behind `ObjectStore`, with product/environment credentials separately scoped. |
| AWS/ECS/Terraform | removed migration provenance               | No longer present in the active deployment path or supported as a provider option.                                                                    |

## Persistence and data ownership

The Control Plane owns a separate persistence boundary from Adea and Cortana.

- Managed cloud: Neon PostgreSQL.
- Local: embedded SQLite.
- Hosted `simple`: SQLite.
- Hosted `server`: PostgreSQL.

Physical schemas may differ by adapter, but logical IDs, revisions, idempotency, lifecycle, provenance, and public contracts may not. Restate workflow state is separate from Control Plane domain persistence. LangGraph checkpoint state is separate from both. Provider corpus/native memory remains provider-owned.

Cross-profile movement uses the versioned `control-plane-portable-state-v1` manifest and
provider-neutral persistence/object-store boundaries. It is an explicit, quiesced operator action;
it is not background synchronization or direct database copying. See
[`profile-portability.md`](profile-portability.md).

The repository's existing local PostgreSQL Compose fixtures are integration/server-profile development infrastructure; they are not the M10 Local product database.

## Object storage ownership

`ObjectStore` is deployment-neutral. The M9 Control Plane cloud implementation uses the Control Plane-owned Cloudflare R2 bucket/configuration; M10 Local/Hosted use filesystem or user-controlled S3-compatible storage. Physical provider identifiers do not enter stable contracts.

Adea owns a different Artifact authorization/lifecycle boundary and must use its own bucket/credentials for first-party Artifact promotion. Sharing a Cloudflare account does not authorize one product to read, write, delete, scan, retain, or issue capabilities for the other product's objects.

## Runtime transport

`RuntimeAdapter` owns normalized execution semantics. `RuntimeDriver` performs concrete operations where the runtime lives. `RuntimeTransport` selects how normalized commands reach the driver:

- `DirectLocalRuntimeTransport` for co-located Control Plane + RuntimeDriver;
- `RemoteRuntimeGatewayTransport` only for non-co-located RuntimeNodes.

Adea's durable web/mobile remote relay is a separate product-control transport and must not be conflated with Runtime Gateway.

## Context and memory

Context/memory providers are optional. Zero providers is a valid baseline. The Control Plane owns provider selection/failure policy and validates bounded `ContextContribution`s; Cortana or another provider owns its corpus, native memory, ACLs, revisions, retention, and credentials. Retrieval is read-only. Durable provider writes begin as controlled `MemoryWriteProposal`s.

## Infrastructure ports

M10 formalizes deployment-specific choices behind ports such as:

- `PersistenceProvider`
- `WorkflowRuntime`
- `ObjectStore`
- `SecretsProvider`
- `CoordinationProvider`
- `RuntimeTransport`
- `ProcessRuntimeProvider`
- `ServiceDiscovery`
- `ObservabilityProvider`

M10 must preserve the M9 Railway cloud implementation behind these ports while adding Local/Hosted implementations. A portability refactor that changes deployment-independent product semantics is an architecture regression.

## Current implementation versus accepted target

M9.7 removed the former AWS/ECS/Terraform deployment path, M9.8 removed the former Temporal runtime
from active code/configuration, and M9.9 established the live Neon/R2/Railway dependency wiring.
Historical ADRs, changelogs, and issue records retain migration provenance; they are not supported
deployment options or active runtime dependencies.
