# Service configuration and bootstrap

All deployable services enter through `@control-plane/bootstrap`, which loads typed configuration from `@control-plane/config`, installs shutdown/fatal-error handling, and exposes health/readiness state. Configuration is deployment-profile aware; request data is never allowed to choose infrastructure or environment settings.

## Environments and profiles

`APP_ENV` accepts exactly `development`, `test`, `staging`, or `production`.

Deployment profile is a separate concept from application environment:

- managed cloud — Railway services using Neon, R2 and Restate;
- Local — all-in-one composition using SQLite, local Restate and direct RuntimeTransport;
- Hosted `simple` — containerized all-in-one with SQLite;
- Hosted `server` — PostgreSQL-backed server composition.

The same public/domain behavior must not depend on an environment-specific variable name.

Development and test may load local dotenv files. Staging and production do not load dotenv files automatically; configuration comes from the deployment/runtime secret/configuration boundary.

## Managed-cloud configuration — M9

Railway service/shared variables are the accepted initial source for **service/bootstrap configuration** such as:

- application environment and service configuration;
- service-to-service endpoints/credentials;
- Neon runtime connection reference;
- separately scoped Neon migration/admin reference for the migration job only;
- Restate endpoint/runtime configuration;
- R2 endpoint/bucket/credential references;
- bootstrap/master references for other deployment services.

The Cloud Control API authenticates Adea with signed, scoped service credentials. Railway
configuration supplies the exact issuer, a bounded set of trusted Ed25519 public keys, and the current
emergency-revocation set through `CONTROL_PLANE_SERVICE_AUTH_ISSUER`,
`CONTROL_PLANE_SERVICE_AUTH_TRUSTED_KEYS`, and
`CONTROL_PLANE_SERVICE_AUTH_REVOKED_CREDENTIAL_IDS`. There is no shared opaque service-token
compatibility path.

M9.7/M9.9 defined the exact variable manifest per service, validation rules, public/private
networking, `PORT` behavior, health/readiness, restart/drain behavior, and dependency ownership. The
repository-owned manifest is `infrastructure/railway/environment.json`; M9.8 published the Restate
contract in `infrastructure/railway/restate.json`, and M9.9 wired and verified both against Railway.

`control-api` owns `RESTATE_INGRESS_URL` because callers invoke workflows through Restate ingress.
The Cloud value is the private Railway HTTP endpoint on port 8080; non-private endpoints must use
HTTPS. `workflow-worker` is the Restate service endpoint and instead requires
`RESTATE_REQUEST_IDENTITY_PUBLIC_KEY`, which the Restate SDK uses to reject unsigned calls. The
self-hosted runtime reads the matching private key from its persistent volume through
`RESTATE_WORKER__INVOKER__REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE`. Railway also pins
`RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE` below half of the effective Restate container limit so the
server does not retain its 2 GiB default inside a 1 GiB container. There is no
`RESTATE_SERVICE_AUTH_TOKEN` compatibility variable: self-hosted ingress authentication, private
networking, and Restate-to-service request identity are separate controls.

`workflow-worker` also requires `CONTROL_PLANE_CLOUD_RUNTIME`. Railway staging sets it to
`certification`, which enables the bounded M9 runtime that writes and verifies a terminal result
through the Control Plane R2 `ObjectStore`. Railway production sets it to `disabled`; the worker and
Restate endpoint remain healthy, but execution and interaction activities fail closed with
`CLOUD_RUNTIME_DISABLED` without opening R2. Production cannot execute certification traffic and
execution availability remains disabled until a separately implemented runtime is explicitly
composed for launch. The certification runtime accepts only plans pinned to
`contract://control-plane/m9-cloud-certification/v1`; ordinary execution plans fail before R2
access. Unknown modes fail configuration validation.

Railway deployment metadata is consumed directly: `RAILWAY_GIT_COMMIT_SHA` supplies the source revision and `RAILWAY_DEPLOYMENT_ID` supplies the deployed service version. `COMMIT_SHA` and `SERVICE_VERSION` are provider-neutral explicit overrides for Hosted or other non-Railway supervisors; Railway services do not need redundant reference aliases for them.

Railway's injected `PORT` must be honored by HTTP services or mapped explicitly through repository-owned Railway configuration. Do not assume the historical fixed development ports are the cloud ingress contract.

## Dynamic credentials are separate

Railway environment variables are not the storage model for arbitrary user-scoped connector/provider credentials. Those remain behind the audited credential-vault secret-provider boundary. Service/bootstrap secrets and dynamic user/provider credentials are separate classes with separate lifecycle and least-privilege rules.

Managed Cloud uses `NeonEncryptedSecretProvider` backed by the repo-owned `credential_secrets` table. `CONTROL_PLANE_SECRET_ENCRYPTION_KEY` is a Railway secret used only to encrypt/decrypt dynamic credentials; it does not replace the credential vault or expose one environment variable per user credential. AWS Secrets Manager is not an active dependency.

## Local and Hosted configuration — M10

Local and Hosted compositions consume the same typed configuration model through different adapters:

- packaged Local: host-secure handles for reusable secrets plus local data/component paths selected by the trusted launcher;
- standalone Local: owner-controlled environment/private-file references where supported;
- Hosted: environment/Docker/private-file or external secret-manager references;
- cloud-only provider identifiers such as Railway/Neon/R2 cannot be required by Local/Hosted core startup.

Profile-specific configuration may select persistence, object store, secrets, runtime transport, process supervision and service discovery. It may not redefine Task/Execution/Profile/Skill/ProjectState/ContextProvider semantics.

The standalone Local entrypoint selects the packaged managed Pi RPC client only when
`CONTROL_PLANE_LOCAL_RUNTIME=managed-pi`. It then requires
`CONTROL_PLANE_MANAGED_PI_PROVIDER`, `CONTROL_PLANE_MANAGED_PI_MODEL`,
`CONTROL_PLANE_MANAGED_PI_MODEL_ALIAS`, `CONTROL_PLANE_MANAGED_PI_MODEL_CAPABILITIES`,
`CONTROL_PLANE_MANAGED_PI_PROVIDER_CLASS`, and `CONTROL_PLANE_MANAGED_PI_DATA_RESIDENCY`; the
executable defaults to `pi` and may be overridden by `CONTROL_PLANE_MANAGED_PI_EXECUTABLE`. These
values choose and attest a runtime route but do not carry credentials. The route must satisfy the
immutable model alias, capability, provider-class, provider-deny, and residency policy. The child
process inherits only the documented Pi/home/path allowlist, so service/bootstrap secrets never
become ambient runtime authority. Unknown runtime families and incomplete or ineligible model
selection fail startup.

## Current service surfaces

The accepted Cloud process topology has two application services plus one infrastructure runtime:

| Service           | Cloud surface                                                   |
| ----------------- | --------------------------------------------------------------- |
| `control-api`     | authenticated public API and health/readiness                   |
| `workflow-worker` | private Restate endpoint and workflow-runtime concurrency       |
| `restate`         | private pinned durable-workflow runtime with persistent storage |

The former runtime-worker, runtime-gateway, and tool-gateway process split is not a compatibility
requirement. Local uses an all-in-one Control Plane plus local Restate, and Hosted selects only the
processes its implemented topology requires.

## Validation and diagnostics

- Missing/invalid startup configuration reports names and safe classifications, never values.
- Effective non-secret configuration/profile/version information is exposed for readiness/diagnostics.
- Sensitive keys/values are redacted before serialization.
- Optional providers do not become startup dependencies unless the selected immutable policy explicitly requires them.
- Schema/config incompatibility prevents readiness rather than allowing a partially configured revision to serve traffic.

## Shutdown

`SIGINT`/`SIGTERM` mark the process unready and close registered resources in reverse order. M9.13
froze the accepted graceful drain/cleanup defaults. Local launchers and Hosted supervisors must
implement equivalent semantics without changing domain behavior.

The managed-cloud operational policy is versioned in `@control-plane/config`. Its defaults are a
15-second heartbeat, degraded after two missed heartbeats, offline after three, 60-second inventory
freshness, 30-day CommandInbox and event retention, 7-day terminal command retention, 24-hour
maximum command lifetime, 256 KiB remote metadata, 1 MiB encrypted content/frame limits, 30-second
public request deadlines, and a 30-second graceful drain. Overrides must remain inside the schema's
safe bounds and are included in the effective configuration digest.
