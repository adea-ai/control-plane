# Deployment-profile portability

Control Plane configuration and a supported durable-state subset can move explicitly among Cloud,
Local, Hosted `simple`, and Hosted `server` without redefining logical identity. Portability is an
operator workflow, not continuous cross-profile synchronization.

## Format and supported state

The independent manifest contract is `control-plane-portable-state-v1`, schema version `1`. Every
manifest records its export ID, source profile, creation time, component and contract versions,
required destination capabilities, source persistence/object-store classes, per-record digests, and
a whole-manifest SHA-256 digest. Stable logical IDs and semantic revisions are preserved.

The provider-neutral subset includes:

- AgentProfile and Skill records and versions;
- ProjectState and selected ProjectState history;
- safe ContextPackage and immutable ExecutionPlan metadata;
- policy, runtime, tool, model, and provider configuration references supplied by a composition;
- selected retained execution history only when explicitly requested;
- connector credential metadata (`credential-metadata`) without status, secret references or
  secret values.

The generic persistence adapter currently maps the catalog, project-state, context-package, and
execution-plan namespaces. A profile composition may supply additional safe records through the same
`PortableStateSource` boundary. Unknown or provider-owned references are reported as unsupported
before mutation.

Cloud and Hosted `server` use `PostgresPortableStateSource` and
`PostgresPortableStateDestination`. They read and write the accepted normalized PostgreSQL domain
tables, reject active executions, order foreign-key-dependent catalog writes, preserve the current
ProjectState revision plus optional older selected revisions, and commit records with migration
provenance in one serializable transaction. They do not use a shadow portability database or copy
raw PostgreSQL storage.

## Security invariants

Default exports never contain reusable secret values, authorization headers, passwords, private
keys, tokens, provider credentials, or private absolute host paths. Secret identities remain opaque
`provider + key + purpose` references and must resolve through a configured destination
`SecretsProvider`. Secret-canary values supplied by the composition are scanned before a manifest is
created.

Credential metadata never carries secret material, so it needs no destination `SecretsProvider`.
Strict manifest validation rejects a credential record with any extra field. Import writes each
credential as `secret_required` (revoked credentials stay revoked) and records a
`credential.imported` audit event; the credential cannot be leased until an operator re-enters its
secret through `POST /v1/credentials/rotate` with the imported revision as `expectedRevision`.

Export fails while an execution is accepted, queued, running, waiting, or cancelling. The operator
must quiesce or checkpoint work explicitly; the migration layer never guesses how to move an
in-flight provider/runtime operation.

## Plan, apply, and recovery

Import is dry-run by default. Preflight verifies the schema and digests, contract/capability
compatibility, destination identity conflicts, unresolved secret providers, unsupported references,
and Artifact actions before mutation. A stale plan is rejected if destination state changes.

Apply writes supported persistence records in one destination transaction and records immutable
migration provenance under the export ID. Replaying the same manifest is idempotent. Reusing an
export ID for a different manifest is a deterministic conflict.

Artifact references are preserved by default. Bytes move only when `copyArtifacts` is explicitly
enabled with both source and destination `ObjectStore` adapters. Source and destination size/SHA-256
must match the manifest. Newly copied bytes are deleted if the state transaction fails; bytes that
already existed are never deleted by rollback.

Keep the source backup and manifest until destination verification completes. On failure, inspect the
machine-readable code, correct capability/secret/conflict state, regenerate the plan, and reapply.
Never edit a signed/digested manifest in place.

## Local and Hosted Simple CLI

The package exposes `control-plane-portability` for SQLite-backed Local and Hosted `simple` stores:

```sh
control-plane-portability export --database ./state.sqlite --profile local \
  --output ./control-plane-export.json --export-id release-2026-08-30 \
  --sensitive-values-file ./portable-export-canaries.json

control-plane-portability verify --manifest ./control-plane-export.json

control-plane-portability plan --database ./hosted.sqlite --profile hosted-simple \
  --manifest ./control-plane-export.json

control-plane-portability import --database ./hosted.sqlite --profile hosted-simple \
  --manifest ./control-plane-export.json --apply
```

`import` without `--apply` is a dry run. Export files are written atomically with owner-only
permissions. The optional canary file is a JSON array of up to 1,000 non-empty strings, with a 4 MiB
file limit and a 4,096-byte limit per string. Keep it owner-readable and delete it when the export
verification is complete. Canary values are read from the file so they do not appear in process
arguments, and a match aborts before the manifest is written. Cloud and Hosted `server` compositions
invoke the same library boundary with their accepted PostgreSQL and S3-compatible adapters. Their
operator composition owns database connection and authorization; the SQLite CLI does not accept
cloud credentials or alter Railway, Neon, or R2 configuration.

## Release evidence

Run `bun run test:m10-conformance`. The suite compares the same versioned cases across all four
profiles and identifies the exact profile, port, and adapter when normalized outcomes diverge. Live
PostgreSQL evidence runs separately against an isolated database on an expiring Neon branch; Local
and Hosted `simple` use disposable SQLite files.
