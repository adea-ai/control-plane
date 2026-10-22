# Production PostgreSQL target after provider retirement

Persistent Railway staging and Neon are retired following the user's deletion
report on 2026-10-22. This document records source requirements; it does not
independently verify provider state or authorize resource changes.

The production schema gate reads `DATABASE_MIGRATION_URL` and the reviewed
`infrastructure/railway/production-database.json` contract. The contract is
deliberately pending verified metadata from the exclusive live cutover owner.
Promotion refuses before querying provider variables or opening a database until
that exact identity is recorded and reviewed. No supplied URL can select its own
allowlist, and the retired Neon target is not a fallback.

The live owner must provide non-secret metadata: the database service ID,
database name, migration and runtime endpoint hostnames and ports, plus evidence
that both endpoints identify that same production database. The existing role
contract remains `control_plane_migrator` for migration and `control_plane_app`
for runtime. Credentials are never stored in this file or the target contract.
Endpoint metadata must also establish the supported TLS trust and connection
route; a GitHub-hosted runner cannot assume access to a Railway-private hostname.
Do not mark the contract verified from an intended service name or guessed host.

Once the verified contract is supplied, qualify the exact target with the live
owner's authorized procedure. Keep certificate verification, role identity,
canonical migration-history prefix checks, advisory locking and rechecks,
post-migration exact history, least-privilege table grants, retention-reference
columns and runtime readiness. Source tests use explicit synthetic identities;
their success does not prove the live target has been provisioned or migrated.

Routine pull-request proof remains the required secretless disposable local
PostgreSQL lane, including fresh schema, profile conformance and Hosted Restate
qualification. The retired Neon Actions workflow is preserved unchanged only as
a historical test fixture, outside `.github/workflows`.

The production IaC entry point rejects non-production environments before resource
construction. Optional hosted qualification requires separately reviewed isolated
ephemeral infrastructure, its own database and credentials, synthetic data,
per-run object-store namespace and request identity, bounded lifetime and verified
cleanup. A logical `APP_ENV=staging` inside such a fixture does not require a
persistent Railway staging environment. Certification must remain forbidden on
production. Do not inherit production database credentials or network access.

This source repair does not deploy, bootstrap a database, create credentials,
remove provider variables, recreate staging, or change protected merge controls.
