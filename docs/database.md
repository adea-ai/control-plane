# Control Plane persistence

Control Plane domain persistence is deployment-profile aware behind `PersistenceProvider`. PostgreSQL remains the server-grade/cloud relational implementation; embedded SQLite is the accepted Local and Hosted `simple` implementation. Durable correctness must not depend on Valkey/Redis.

## Accepted profiles

| Profile         | Persistence                                      | Milestone ownership |
| --------------- | ------------------------------------------------ | ------------------- |
| Managed cloud   | Separate Control Plane Neon PostgreSQL + Drizzle | M9                  |
| Local desktop   | Node 24 `node:sqlite` + Drizzle                  | M10.3               |
| Hosted `simple` | SQLite + Drizzle                                 | M10                 |
| Hosted `server` | PostgreSQL + Drizzle                             | M10                 |

Physical schema/index choices may differ by adapter. Logical IDs, revision behavior, idempotency, lifecycle transitions, ordering, provenance, and public contracts must remain equivalent.

Restate durable workflow state is separate from Control Plane domain persistence. LangGraph graph/checkpoint state is also separate. Neither is ProjectState.

## Current managed-cloud Neon state

A separate Neon project named `control-plane` exists. It is distinct from the Adea Neon project.
The repository-owned managed-cloud compositions now connect both `control-api` and
`workflow-worker` to PostgreSQL using application-role credentials. The Control API persists plans,
commands, executions, ProjectState, and ContextPackages; the workflow worker persists execution and
attempt lifecycle transitions and loads the exact accepted plan before runtime dispatch.

- the dedicated Control Plane Neon project has separate `staging` and
  `production` branches named after the Railway environments they serve:
  `staging` is the Railway staging database and `production` is the Railway
  production database. Git deploys from `main`; only the Neon branch names
  differ from the environment flow, and the explicit
  mapping below is the authority for the join;
- Railway's `staging` and `production` environments must each supply their own
  `DATABASE_URL`, `DATABASE_MIGRATION_URL`, and `DATABASE_ADMIN_URL` values;
- the Control Plane Drizzle/domain schema is applied to the staging branch by an
  explicit migration job before staging traffic is accepted, while production
  remains separately migrated through the release process;
- any unrelated `neon_auth` schema is outside the Control Plane domain contract;
- Control Plane application code must not depend on that `neon_auth` schema because Adea owns product user authentication.

Configuration shape alone is not live-environment evidence. M9.6 #73 completed the explicit staging
migration, deployed-service connectivity, least-privilege verification, and bounded reconnect/
recovery checks recorded in the certification evidence. Production migration and promotion remain
separate release operations. Any unrelated `neon_auth` schema remains non-authoritative and unused
by Control Plane application code.

Production/staging tables must be created from repository-owned Drizzle migrations, not manual
console SQL.

## PostgreSQL development and integration fixtures

The repository's existing local PostgreSQL Compose service remains the development/integration fixture for PostgreSQL-backed code and server-profile tests. It is **not** the Local product persistence architecture introduced in M10.

Start the pinned PostgreSQL test/development service without deleting existing local data:

```sh
bun run db:up
```

Stop it without deleting its volume:

```sh
bun run db:stop
```

The PostgreSQL roles remain deliberately separate:

| Role                | Environment variable     | Permitted purpose                                                    |
| ------------------- | ------------------------ | -------------------------------------------------------------------- |
| application/runtime | `DATABASE_URL`           | Ordinary application queries and domain transactions                 |
| migrator            | `DATABASE_MIGRATION_URL` | Schema migrations and owned-object grants                            |
| admin/test/recovery | `DATABASE_ADMIN_URL`     | Provisioning, isolated tests, backup/restore and recovery operations |

Managed-cloud values are injected through the M9 Railway/Neon configuration boundary. Application services receive only the authority they need; migration/admin credentials are never sprayed across all Railway services.

The environment mapping is intentionally explicit and credential-free in source:

| Railway environment | Git source branch | Neon branch  | Application environment |
| ------------------- | ----------------- | ------------ | ----------------------- |
| `staging`           | `main`            | `staging`    | `staging`               |
| `production`        | `main`            | `production` | `production`            |

Naming convention: Neon branches and Railway environments share the environment
name (`staging`, `production`); Git deploys from `main`. This matches the Adea Neon project, which also names
its durable branches after environments (`development`, `staging`,
`production`). Control Plane has no shared `development` Neon branch by policy:
local development uses the pinned Compose PostgreSQL fixture and tests use
disposable isolated databases.

Only the runtime URL is provided to application services. The migration URL is
used by the explicit database migration job, and the admin URL is reserved for
provisioning/recovery operations.

## SQLite Local persistence

M10.3 #202 owns the Local adapter using Node 24's built-in `node:sqlite` with Drizzle. It must support the durable Control Plane entities required by the Local product profile, including ProjectState, ContextPackage/ExecutionPlan metadata, Executions/Attempts, CommandInbox, interactions, ExecutionEvents, runtime/provider metadata, usage and audit records.

Requirements include:

- explicit local data directory and permissions;
- WAL/transaction behavior suitable for the single-host profile;
- deterministic migrations/version checks;
- online backup and tested restore;
- corruption/recovery fixtures;
- secret references only, never reusable credential values;
- conformance against PostgreSQL for deployment-independent domain semantics.

The SQLite provider stages a restore in an owner-only temporary file and verifies
its digest, SQLite integrity, internal schema version and canonical table/index definitions
before replacing the live database. Invalid candidates are rejected as
`SQLITE_BACKUP_INVALID`, leaving the current connection and records available.
Validation normalizes the staged WAL-mode backup to a standalone file; normal
operation re-enables WAL after replacement. This is not backup authenticity or a
cross-process restore lock: operators must still use trusted checkpoints and stop
other database users before restoring. Filesystem failures during replacement and
host-loss recovery require the retained operator checkpoint.

## Schema and naming conventions

The PostgreSQL implementation remains grouped by domain boundary under `packages/database/src/schema`. Schema details are implementation-owned and must not leak into the public API/SDK. SQLite may use a physically different representation where PostgreSQL-only features have no equivalent, but adapter conformance must preserve the public/domain behavior.

## CommandInbox retention and replay

`CommandInbox` is the durable Control Plane idempotency boundary for state-changing commands. The accepted operational policy is defined in M9.13 #213 and applies semantically across persistence adapters.

Key rules:

- identical retries converge on one logical result;
- reuse of an idempotency key with a different canonical payload hash fails closed;
- idempotency records remain available for the declared replay/reconciliation window;
- persistence cleanup may not remove a record while an upstream/downstream component can still legitimately redeliver the protected command.

New execution acceptance rejects a requested inbox retention interval shorter than 30 days
after the supplied receipt timestamp, before creating an execution. Exactly 30 days and longer
requested intervals are accepted. After plan validation, the service samples its trusted clock:
an already-expired new request is rejected before persistence, and the stored deadline is the
later of the requested deadline or 30 days after that trusted acceptance time. Transport or
validation delay therefore cannot consume the minimum replay window. This does not extend
the execution's authorization or workflow deadline.
Replay of an existing unexpired legacy record keeps its recorded result and deadline; the new
minimum is not a migration or an implicit rewrite of old records. Expired legacy records retain
the existing explicit retention-expired response. Deployments must separately reconcile legacy
retention and ensure inbox data is retained at least as long as the protected execution. This
acceptance check alone does not prove cleanup policy or physical retention across profiles.

## ExecutionEvent persistence

Execution events are durable, ordered, redacted records. Required state transitions and their durable event/outbox records must commit atomically within the owning persistence adapter's transaction semantics. Raw prompt, credential, file, provider, or unrestricted runtime payloads are not event-log content.

## Migration workflow

Repository-owned migrations are authoritative.

PostgreSQL:

```sh
cd packages/database
bun run db:generate
bun run db:check
bun run db:migrate
```

Managed-cloud migrations run through an explicit M9 migration/pre-deploy path with separate migration authority. Ordinary service startup must not silently mutate production schema.

SQLite startup runs the ordered forward registry in
`packages/sqlite-persistence/src/migrations.ts`. Each step's SQL checksum is retained as
`migration:<version>` in `control_plane_metadata`, alongside `schema_version`. Startup rejects a
newer version, missing history (except the released legacy v1), or a changed applied checksum.
Legacy v1 adoption first checks its exact table/index definitions and retains existing records.
The registry currently contains only the released v1 schema; append future steps without editing
that baseline. The entire pending sequence and history updates commit in one SQLite transaction.

Before an upgrade, stop new work, drain active writes, and retain a digest-verified backup. A failed
transaction rolls back to the prior version; diagnose and correct the unapplied step before retrying.
After a successful upgrade, use a reviewed new forward step for repair. An older binary cannot
automatically downgrade a newer schema: restore the pre-upgrade backup into an isolated destination,
verify integrity and retained records, and account for post-backup work before an explicit switch.
Migration-runner tests exercise a synthetic v2 upgrade/failure/repair; that is not certification of
an actual future product schema or a measured cross-version recovery objective.

Never edit an applied migration. Correct mistakes with a reviewed forward repair or, where data recovery is required, a separately reviewed restore procedure.

## Integration databases

Integration tests may continue to create isolated PostgreSQL databases for PostgreSQL-adapter and server-profile validation. M10 adds SQLite adapter tests and cross-adapter conformance. Tests must use disposable resources and cannot depend on a developer's persistent production-like database.

## Backup and restore

Recovery is profile-specific:

- **Managed cloud:** Neon backup/PITR or equivalent provider recovery plus logical/export procedures validated in M9/M11.
- **Local/Hosted `simple`:** SQLite backup/restore validated in M10/M11.
- **Hosted `server`:** PostgreSQL backup/restore owned by the operator/reference deployment and validated in M10/M11.

Restore into an isolated destination first, verify schema/integrity/reconciliation, then switch through the normal change process. Never validate recovery by overwriting the active database.
