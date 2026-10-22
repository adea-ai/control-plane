# Railway production database contract

Production runs on the existing Railway PostgreSQL service. Tests use disposable local or CI sandboxes with synthetic identities and independent credentials.

The protected production schema gate consumes `DATABASE_MIGRATION_URL`, `DATABASE_MIGRATION_CA_CERTIFICATE`, and `infrastructure/railway/production-database.json`. Pending identity refuses promotion before provider or database I/O.

The reviewed contract distinguishes the private runtime endpoint, reachable migration endpoint, and reachable runtime-role verification endpoint. The public routes must be the exact proxy for the same database service and production environment. The gate validates the private binding first, then changes only host/port for runtime-role verification; username, password, database, and URL policy are preserved.

The fixed identities are `control_plane_migrator` for public-schema migrations and `control_plane_app` for runtime DML. Runtime cannot own database/schema objects, CREATE, TRUNCATE, REFERENCES, or TRIGGER, inherit roles, or hold elevated role flags. Selective grants, including immutable and read-only tables, remain enforced by the migrations and live capability gate. Adea owns separate `app`/`auth` schemas and is outside these grants.

The authenticated CA certificate is supplied separately from credentials and its DER SHA-256 must match source metadata. The migration, inspection, and runtime-verification connections all use certificate and hostname verification. A transport proxy hostname is not assumed to identify the certificate peer.

Service images package the public CA at `packages/database/certs/railway-production-ca.crt` and configure `NODE_EXTRA_CA_CERTS` before the runtime starts. This adds the reviewed trust anchor while retaining ordinary chain and hostname verification for the private database endpoint. No private key is included.

Apply only the canonical migration history, under the existing advisory lock and bounded timeouts, then verify history and runtime grants. A successful liveness check does not prove schema readiness, private connectivity, representative execution, or fresh-account acceptance. Production promotion remains through the protected release workflow.

## Verified production bootstrap, 2026-10-22

The verified service is `67fdd979-8a5b-4c02-b4c5-799a2e5cb3f0` in production environment `52f5b0ac-2af0-4792-aa56-30d80e5db31e`, database `railway`. Runtime uses `postgres.railway.internal:5432`; migration and runtime-role CI verification use `altaria.proxy.rlwy.net:44407` with authenticated CA and peer `postgres.railway.internal`.

The CA DER SHA-256 is `3022dc74d0ca3f397259f884ae46f49ce41a51b6208a71a6a30d7fcf142f9c90`. Leaf SHA-256 is `b3bfc0c18336f8a27bf11a99f7a0a4dc05b5e8736cb144a6f31a0908a1f20b68`; both private and public endpoint identities verified over the existing public proxy. Private keys stayed on the PostgreSQL volume.

All 74 canonical Control Plane migrations applied and replayed without history changes. The actual `control_plane_app` connection passed the repository capability/retention-column gate, including restricted table grants, no memberships, ownership, DDL or database CREATE. Catalog readback confirmed that Control Plane roles cannot use Adea's schemas and Adea roles cannot use Control Plane's public schema. Migration URL and public CA were stored in repository secrets; the private scoped runtime URL and startup trust-file path are configured in Railway without requesting a deployment. The existing successful deployment remains the previous image until protected promotion runs.

These receipts establish database identity, TLS, history and capabilities. Effective image trust packaging, private runtime connectivity, readiness and representative production behavior still require deployment verification.
