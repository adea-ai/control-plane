# Infrastructure

The supported profiles are Cloud, Hosted/VPS, and Local.

The first-party Cloud deployment uses Railway compute, Railway PostgreSQL and Cloudflare R2. Adea application compute is Cloudflare Workers, with the existing Hyperdrive pooler connecting to Railway PostgreSQL. A database service is not evidence of an Adea Railway application deployment.

## Production resources

Railway project `18c6a1fd-6b4b-421e-9ec9-fd1550ce9a3f` has production environment `52f5b0ac-2af0-4792-aa56-30d80e5db31e`. PostgreSQL service `67fdd979-8a5b-4c02-b4c5-799a2e5cb3f0` hosts database `railway`. Private runtime connections use `postgres.railway.internal:5432`; external migration verification uses the existing `altaria.proxy.rlwy.net:44407` TCP proxy with verified CA and peer identity. Do not create another proxy.

Control API service `9167a33b-af0f-4780-8614-a5a161697c9c` is the production application target. Its database URL must use `control_plane_app` over the private endpoint. Migrations use `control_plane_migrator`; its privileges cover only `public` and `drizzle`. Adea’s `app` and `auth` schemas are isolated behind separate runtime identities and `adea_prod_migration`. See [the production contract](railway-production-database-cutover.md).

## Runtime and deployment

`.railway/railway.ts` accepts production only. The active production topology promotes the Control API. Durable-workflow components remain separately qualified sandbox infrastructure, not automatically deployed production resources. Production promotion verifies immutable source identity, private runtime bindings and schema readiness. Configuration and successful liveness do not establish application acceptance.

Persistent preproduction environments are absent. Use disposable local/CI sandboxes with synthetic data, credentials and isolated object prefixes. Never direct sandbox tests or preview code to production. R2 remains private, accessed through the ObjectStore/Artifact boundary; retain scoped operational credentials and authoritative integrity checks.

## Secrets and TLS

Keep secret values in supported provider/GitHub secret storage and supply them through secure stdin. Preserve independently rotated operational credentials. Service images package the authenticated public CA and configure `NODE_EXTRA_CA_CERTS` before startup. Database clients retain certificate-chain and hostname verification. Hyperdrive uses verify-full with the uploaded CA, and database query caching remains disabled for authentication, session and permission checks.

## Local and Hosted profiles

M10 introduces:

- **Local:** all-in-one Control Plane, Node 24 `node:sqlite`/Drizzle, embedded SQLite workflow queue (no Restate process), filesystem storage, direct RuntimeTransport, no Docker/PostgreSQL/Redis/Temporal/Runtime Gateway requirement for ordinary co-located execution.
- **Hosted `simple`:** containerized all-in-one, SQLite, Restate, filesystem storage, optional co-located runtimes/Cortana.
- **Hosted `server`:** PostgreSQL-backed server composition, Restate, filesystem or S3-compatible storage, split services/Runtime Gateway only where topology requires them.

The supported Compose source is `infrastructure/compose/compose.yaml`. The `simple` profile runs
one long-lived container with no external service dependencies. The `server` profile runs three
long-lived services (Control Plane, PostgreSQL, and Restate) plus an idempotent one-shot migration
container. PostgreSQL and Restate stay private on the Compose network. By default, the Control API
publishes to host loopback. The adjacent runbook covers initial setup, persistent paths,
backup/restore, TLS proxying, upgrades, and rollback.

The M9 Railway profile remains the semantic reference while M10 substitutes infrastructure adapters. M10 must keep the M9 cloud smoke/conformance baseline green throughout the extraction.

## Former AWS infrastructure

The former `infrastructure/terraform` AWS/ECS modules and associated AWS operational assumptions are
not part of the active repository deployment path. Any remaining references in ADRs, changelogs, or
historical notes document the superseded design only; they are not a supported deployment,
compatibility layer, release prerequisite, or portability target.
