# Infrastructure and deployment baseline

The accepted first-party **Cloud** Control Plane target is **Railway compute + Neon PostgreSQL + Cloudflare R2 + Restate**. M9 established that production-shaped profile. The product has exactly three deployment profiles: Cloud, Hosted, and Local. M10 then ports the same Control Plane core and execution semantics to Local desktop and Hosted/VPS deployment profiles.

M9 replaced the earlier AWS/ECS/Terraform implementation with the active Railway/Neon/R2 Cloud
profile. AWS is not a supported deployment option or compatibility layer; the Cloud, Hosted/VPS, and Local options share
application semantics while using different infrastructure adapters.

Each Railway service declares a dependency-aware Turborepo build filter (for example,
`bun run build --filter=@control-plane/workflow-worker...`). The trailing dependency closure is
required because Railway builds from a clean checkout and workspace package imports must be compiled
before the selected service.

## Milestone ownership

- **M9.7 #215 — Railway service builds:** replaced the AWS/ECS-first build/deploy baseline with reproducible Railway service configuration.
- **M9.8 #216 — Restate managed-cloud migration:** replaced Temporal in the active Railway cloud path and defined the Restate service/runtime topology.
- **M9.9 #217 — managed dependencies/configuration:** wired Neon, the existing Control Plane R2 bucket, service authentication, Railway private networking, secrets/configuration, health/readiness, and explicit database migration.
- **M9.10–M9.13 #210–#213 — canonical behavior:** froze public contracts, Profile/Skill behavior, ContextProvider behavior, and operational defaults before portability work.
- **M9.6 #73 — cloud activation gate:** completed the live Railway staging deployment and verification after the implementation/configuration work.
- **M10 — Local & Hosted Portability:** substitutes persistence, storage, secrets, process supervision, topology, and runtime transport adapters while preserving the accepted M9 semantics.

## Managed-cloud provider map

| Capability                              | Accepted M9 provider/boundary                     | Rule                                                                                                                                                                           |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Compute                                 | Railway                                           | Repository-owned/reproducible service configuration; dashboard-only settings are not sufficient release evidence.                                                              |
| Relational state                        | Separate Control Plane Neon PostgreSQL            | Drizzle migrations are explicit; Adea uses a different Neon project/database.                                                                                              |
| Object storage                          | Cloudflare R2 through `ObjectStore`               | Current Control Plane bucket is `ctrl-plane` with Wrangler binding `ctrl_plane`; physical identifiers remain deployment configuration and never enter public/domain contracts. |
| Durable workflows                       | Restate through `WorkflowRuntime`                 | Temporal is superseded for the release path; Restate-specific types stay out of public/domain contracts.                                                                       |
| Service configuration/bootstrap secrets | Railway service/shared variables                  | Values are never committed; configuration is validated at startup.                                                                                                             |
| Dynamic connector/provider credentials  | Provider-neutral credential-vault/secret boundary | Railway environment variables are not a substitute for user-scoped dynamic credential storage. M9.9 documented the active provider implementation behind the port.             |
| Internal networking                     | Railway private networking where applicable       | Only explicitly required authenticated endpoints receive public ingress.                                                                                                       |
| Coordination/cache                      | Replaceable and only where measured need exists   | Never authoritative for durable correctness.                                                                                                                                   |

## Current external-resource state

As of the M9 certification and local-first standby baseline:

- a Railway `control-plane` project with isolated staging and production environments exists;
- dependency-aware monorepo builds are fixed and the active Cloud application topology is `control-api` plus `workflow-worker`;
- the private Restate runtime is separately pinned in `restate.json`; staging retains its persistent volume while all three Cloud services are stopped by default;
- Railway staging maps to Git `staging` and the dedicated Neon `staging` branch; production maps to Git `main` and the Neon `production` branch, but its application sources remain disconnected while cloud availability is disabled;
- existing `neon_auth` tables in that Neon project are not Control Plane identity authority and must not become an application dependency;
- a Cloudflare R2 bucket named **`ctrl-plane`** already exists for the Control Plane managed-cloud ObjectStore, with logical Wrangler binding **`ctrl_plane`**;
- an authenticated Wrangler CLI is available to implementation agents for non-destructive R2 inspection/configuration and synthetic smoke tests;
- staging has completed the live Neon, R2, Restate, restart, and bounded concurrency checks recorded in the M9.6 evidence;
- production remains configured but intentionally unavailable and is not certified by the staging evidence.

Configuration shape or resource existence is not deployment evidence. M9.6 requires an actual successful staging deployment, migrations, health/readiness, representative durable execution, restart/recovery, rollback/forward repair, R2 operations, and measured operational evidence.

## Railway service composition

The active Cloud application services are:

- `control-api` — public authenticated API plus health/readiness;
- `workflow-worker` — private Restate service endpoint.

The private `restate` server is a separately pinned infrastructure runtime, not a Control Plane
application build target.

`runtime-worker`, `runtime-gateway`, and `tool-gateway` are not Cloud services. Their former process
topology is not a compatibility target: runtime execution and tool capabilities must be composed
through the accepted Cloud, Hosted, or Local profile instead of restoring placeholder Railway
services. A process that marks ready and exits is not a service.

`workflow-worker` is the Restate HTTP endpoint for the `execution-lifecycle` workflow. Its endpoint contract is versioned in `infrastructure/railway/restate.json`; M9.9 established the live Restate registration and dependency wiring.

The worker probes Neon before readiness and composes durable execution/attempt activities from the
PostgreSQL repositories. Railway staging selects the explicit Cloud certification runtime. That
runtime receives the exact accepted plan identity through Restate, writes a deterministic terminal
result under the `m9/certification/` R2 prefix, and verifies the stored body and metadata through
`get` and `head` before reporting completion. Replay checks the same object and fails closed on a
conflict. Railway production selects `disabled`, so its worker can pass health and registration while
runtime activities return `CLOUD_RUNTIME_DISABLED` without R2 access; certification traffic cannot
be enabled in the production environment by accident.

The certification runtime proves the M9 Railway + Restate + Neon + R2 lifecycle; it is not a mock Pi
provider and does not claim that the later Adea `agent_hq_cloud` product runtime is certified.
An injected concrete runtime activity port replaces it when that product capability is implemented.

The endpoint validates Restate native request identity with the environment-specific public key.
The matching ED25519 private key is stored only on the Restate data volume and referenced by file;
it is never committed or copied to application services. `control-api` owns the private port-8080
ingress URL. The worker does not receive an ingress URL or a fabricated self-hosted bearer token.

The Railway staging Restate runtime is a private single node pinned to Restate 1.7.7 by immutable
multi-platform image digest. Railway must mount a persistent volume at `/restate-data` and preserve
the configured `control-plane-staging-1` node name across restarts. Restate ingress (8080), Admin API
(9070), and fabric (5122) remain private; only the Admin API `/health` route is used for service
health. This single-node shape is the M9 staging baseline, not a claim of high availability.

The per-service variable and credential-role contract is versioned in `infrastructure/railway/environment.json`. It contains names, classifications, and provider-neutral purposes only; secret values remain in Railway's secret boundary.

`.railway/railway.ts` is the executable Railway Infrastructure as Code definition. It owns the
project graph, sources, build/start commands, health checks, restart behavior, private endpoints,
and Restate volume attachment. Secret values remain provider-managed through `preserve()`; planning
must never use the CLI option that reveals variable values. The deprecated per-service
`railway.json`/`railway.toml` format is not used.

The definition represents the explicit one-replica **activation** shape because Railway's
Infrastructure as Code schema does not accept zero replicas. The local-first MVP baseline keeps
Railway staging and production at zero running replicas by disconnecting application sources and
removing active deployment revisions through the guarded command versioned in
`scripts/railway-standby.mjs`. The command also removes queued, building, and other reactivatable
revisions before proving standby. Service definitions, provider configuration, and volumes remain.
Thus the Cloud profile is configured without being running or available. Staging is activated only
for Cloud integration/certification; production activation additionally requires reviewed release,
secrets, migrations, dependency readiness, health, smoke, and rollback gates.

M9.7 established dependency-aware, reproducible monorepo builds for Railway. The existing
`infrastructure/containers` build pipeline remains available for Hosted/server composition. AWS/ECS-
specific image platform assumptions, ECR publication requirements, task definitions, Terraform
roots, IAM roles, CloudWatch/SNS wiring, and ECS rollout mechanics are not part of the first-party
deployment contract.

## Neon PostgreSQL

The Control Plane cloud database is external to Railway and independently owned.
Railway does not share a connection string between environments: `staging` maps
to the Neon `staging` branch and `production` maps to Neon `production`. Neon
branches are named after the Railway environments they serve; Git source
branches remain `staging` and `main`. The mapping is
versioned in `infrastructure/railway/environment.json`; connection strings and
credentials remain Railway-managed secrets.

Requirements:

1. Use the existing dedicated Control Plane Neon project/database, separate from Adea.
2. Apply repository-owned Drizzle migrations through an explicit migration job/pre-deploy step; ordinary service startup must not silently migrate production.
3. Maintain separate runtime and migration/admin authority. Only services that need relational persistence receive runtime access.
4. Validate schema compatibility before accepting traffic.
5. Exercise reconnect, forward repair, backup/PITR or equivalent recovery, and restore procedures in staging.
6. Keep provider/database identifiers out of public/domain contracts.
7. Treat any unrelated `neon_auth` schema as non-authoritative; leave inert or remove safely only through an explicit M9 decision.

The repository's local PostgreSQL Compose fixtures remain useful for integration tests and server-profile development. They are **not** the M10 product Local persistence profile, which uses embedded SQLite behind `PersistenceProvider`.

## Cloudflare R2

The existing **`ctrl-plane`** bucket is the current Control Plane-owned managed-cloud ObjectStore resource. Its Wrangler binding is **`ctrl_plane`**. Those names are operator/deployment configuration only; Control Plane public/domain contracts continue to use provider-neutral ObjectStore/Artifact references.

M9.9 completed the following Cloud storage gates:

1. verified bucket and account access using the authenticated Wrangler CLI;
2. documented staging-versus-production object isolation before production data exists;
3. configured least-privilege R2/S3-compatible credentials for only the Railway services that require object access;
4. configured endpoint/bucket/environment mapping through server-only deployment configuration;
5. defined lifecycle/retention and omitted CORS because no browser-direct access is required;
6. performed synthetic write/read/delete checks and the same integrity checks through the Control Plane `ObjectStore` adapter from Railway staging;
7. recorded a sanitized resource/configuration manifest without account tokens, access-key secrets, or raw credentials.

**Product storage ownership remains separate.** Adea may use the same Cloudflare account/provider, but it uses a separate Adea-owned bucket or environment-isolated bucket set and separate credentials. Adea must not reuse the Control Plane `ctrl-plane` bucket or its broad credentials as Artifact authority.

Local and Hosted profiles introduced in M10 use filesystem or user-controlled S3-compatible storage by default. Switching `ObjectStore` must not change Artifact identity or public contracts.

## Restate

Restate is the canonical durable workflow runtime across profiles.

- M9.8 completed the **Railway cloud** migration from Temporal to Restate, including networking, health, persistence, restart/redeploy, observability, and in-flight execution behavior.
- M10.1 owns packaging/porting the already accepted Restate workflow implementation to Local and Hosted profiles.

The execution lifecycle races user cancellation and the absolute execution deadline against every
active runtime or graph activity. Terminal control dispatches an idempotent cancellation activity,
then persists `cancelled` or `timed_out`; it also rechecks control immediately before persisting a
normal terminal result. Runtime and graph adapters must therefore expose attempt-bound cancellation
rather than relying on a late completion to resolve the race.

Do not make M10 responsible for getting cloud Restate working for the first time.

## Configuration and secrets

All service bootstrap configuration is typed and validated. Staging/production values are supplied by Railway configuration and approved external providers; secret values never belong in source, images, logs, issue bodies, or generated docs.

Separate **service/bootstrap secrets** from **dynamic user/provider credentials**. Railway variables are appropriate for deployment configuration such as database endpoints, service credentials, Restate configuration, R2 credentials, and the encryption-key reference used by the vault. User-scoped connector/provider credentials are encrypted by `NeonEncryptedSecretProvider` and persisted through `PostgresEncryptedSecretStore`; they cannot be modeled as one environment variable per user credential.

M10 adds Local and Hosted `SecretsProvider` adapters without changing secret-reference/rotation/revocation semantics.

## Deployment, migration, and rollback

The accepted managed-cloud release flow is:

1. Build/test/scan reproducible service images from the complete workspace.
2. Validate repository-owned/reproducible Railway service configuration and exact image/application revision.
3. Validate required Railway variables and external dependency configuration without exposing values.
4. Run the explicit Neon migration step with separately scoped migration authority.
5. Deploy the required service topology and Restate runtime.
6. Verify liveness/readiness through intended public/private paths.
7. Run a representative durable execution and R2 ObjectStore operations.
8. Exercise service/Restate/database reconnect and failed-deploy rollback/forward repair.
9. Run the M9 observability/security/recovery/load evidence against the real staging environment.
10. Record exact commit, configuration versions, migrations, service versions, R2/Neon resource-purpose mapping, resource/cost measurements, and rollback target without credentials.

A failed schema migration blocks application rollout. Applied production migrations are repaired forward unless an explicitly reviewed restore procedure is required.

## Local and Hosted profiles

M10 introduces:

- **Local:** all-in-one Control Plane, Node 24 `node:sqlite`/Drizzle, pinned single-node Restate, filesystem storage, direct RuntimeTransport, no Docker/PostgreSQL/Redis/Temporal/Runtime Gateway requirement for ordinary co-located execution.
- **Hosted `simple`:** containerized all-in-one, SQLite, Restate, filesystem storage, optional co-located runtimes/Cortana.
- **Hosted `server`:** PostgreSQL-backed server composition, Restate, filesystem or S3-compatible storage, split services/Runtime Gateway only where topology requires them.

The supported Compose source is `infrastructure/compose/compose.yaml`. The `simple` profile has one long-lived container and zero external service dependencies. The `server` profile has three long-lived services—Control Plane, PostgreSQL, and Restate—plus an idempotent one-shot migration container. PostgreSQL and Restate remain private on the Compose network; the Control API publishes to host loopback by default. The adjacent runbook owns initial setup, persistent paths, backup/restore, TLS proxying, upgrades, and rollback guidance.

The M9 Railway profile remains the semantic reference while M10 substitutes infrastructure adapters. M10 must keep the M9 cloud smoke/conformance baseline green throughout the extraction.

## Former AWS infrastructure

The former `infrastructure/terraform` AWS/ECS modules and associated AWS operational assumptions are
not part of the active repository deployment path. Any remaining references in ADRs, changelogs, or
historical notes document the superseded design only; they are not a supported deployment,
compatibility layer, release prerequisite, or portability target.
