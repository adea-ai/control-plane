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
production environment ID, database name, and three endpoints: the private
runtime binding, public migration endpoint, and public runtime-verification
endpoint. The two public endpoints must have identical host/port metadata,
reviewed as the proxy for that same service and environment. The gate first
validates the private runtime binding, then clones its URL and replaces only
that reviewed host/port. Role, password, database and query policy are preserved;
no private hostname is opened from the GitHub-hosted runner. The existing role
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

Inspection, migration execution and runtime-role verification all explicitly use
postgres.js `verify-full`, even when the runtime binding declares `sslmode=require`.
This verifies both certificate chain and hostname using the process trust store.
There is no permissive TLS callback or unverified fallback. A reviewed TLS peer
name can differ from the proxy transport hostname only with an explicitly pinned CA.
For system trust, the public proxy DNS name must be covered by the server
certificate. For a verified private peer behind a public TCP proxy, record
`identity.tls.serverName` and the lowercase SHA-256 digest of the CA certificate
DER bytes in `identity.tls.caSha256`. Supply exactly that PEM certificate through
the GitHub production-environment secret `DATABASE_MIGRATION_CA_CERTIFICATE`.
The contract stores no PEM or credentials. The gate rejects absent, malformed,
multiple or mismatched CA certificates before provider or database I/O and passes
`{rejectUnauthorized: true, servername: reviewedPeer, ca: verifiedPem}` explicitly
to inspection, migration execution and runtime-role verification. System trust
uses `caSha256: null` and requires the peer name to equal the public endpoint.
The private application route must independently trust its certificate chain. If that cannot be established, this gate remains blocked: do not
substitute an unverified URL or weaken TLS. A separately authorized private-network
execution design would require its own review.

The application's shared PostgreSQL connection resolver also selects strict
`verify-full` for accepted TLS modes. That source behavior is separate from live
acceptance: the runtime private hostname, certificate SAN/chain, process trust,
role/database and connectivity must still be independently verified. A passing
public CI connection does not prove the application's private connection works.
The committed live identity remains null until that evidence is supplied.

Local TLS qualification uses OpenSSL-generated temporary synthetic certificates and
loopback PostgreSQL SSLRequest handshakes. It covers trusted, untrusted, expired,
wrong-host and explicit pinned-CA/peer cases, without contacting production.
