# Connector credential vault

`@control-plane/credential-vault` separates dynamic connector/provider credentials from Adea sessions, RuntimeNode identity, ordinary Control Plane service authentication, and deployment bootstrap configuration.

Public credential metadata contains a stable credential ID, workspace/connector ownership, provider name, status, revision, and lifecycle timestamps. Reusable secret values remain behind a provider-neutral secret boundary and never enter public contracts, ExecutionPlans, ContextPackages, Restate state, events, logs, traces, runtime messages, or ordinary errors.

## Deployment configuration is not the credential vault

The accepted M9 managed-cloud profile uses Railway variables for **service/bootstrap configuration** such as database connection references, service authentication, Restate configuration, object-store credentials, and bootstrap/master-secret references.

Railway environment variables are **not** the storage model for arbitrary user-scoped OAuth refresh tokens, API keys, or connector credentials. Dynamic credentials require the audited credential-vault secret provider boundary.

`NeonEncryptedSecretProvider`, backed by the repo-owned `credential_secrets` table through `PostgresEncryptedSecretStore`, is the managed-cloud implementation behind the stable vault contract. The AES-256-GCM encryption key is supplied as a Railway secret and referenced by key identifier; secret values and key material are never committed. AWS Secrets Manager is not an active provider.

M10 then adds Local/Hosted secret-provider adapters without changing credential identity, scope, lease, rotation, revocation, or audit semantics.

## Scoped use

Tool Gateway or another approved server-side adapter requests a short-lived lease only after the required policy decision. A lease is pinned to one workspace, principal, credential revision, operation/resource scope, policy snapshot, and bounded lifetime. It exposes an opaque capability/reference rather than the reusable secret.

Use rechecks expiry, revocation, credential revision, and exact scope before the secret provider makes the value available to the approved callback/executor. Callback/provider results must not be able to echo the reusable credential into normalized output.

## Required secret-provider contract

Every deployment-specific implementation must support the same high-level semantics:

- create/store a new encrypted secret revision or secure reference;
- resolve one authorized revision only inside the declared callback/use boundary;
- rotate by creating a new active revision while preserving stable credential identity;
- revoke current and retained revisions according to policy;
- fail closed on unavailable provider, wrong scope, expired lease, replay, or revocation;
- expose only opaque secret references/metadata outside the provider implementation;
- support leak-canary tests across persistence, workflow state, events, logs, traces, exports, backups, and runtime/public surfaces.

The concrete encryption/KMS/vault mechanism is deployment-specific and must not appear in the public credential contract.

## Rotation and revocation

Rotation adds a new encrypted/provider revision while preserving stable credential and connector IDs. Existing revision-pinned leases remain explicit; new leases select the current revision. Revocation blocks new leases and invalidates active/retained revisions according to the provider contract.

Missing policy, policy-evaluator failure, scope mismatch, expiry, replay, or provider failure all fail closed.

## Backup and migration

Default Control Plane export/import never includes reusable credential values. It may include credential identity and unresolved secret references so an operator can rebind them explicitly at the destination. Cross-profile migration must never silently copy a cloud secret into Local/Hosted storage or vice versa.

## Durable metadata and leases

`CredentialVault` keeps metadata, opaque secret references, leases, audit events and idempotency
receipts behind the `CredentialVaultRepository` port; the `SecretProvider` boundary is unchanged.
Adapters:

| Profile                         | Repository                          | Storage                                                                                     |
| ------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| Managed Cloud, Hosted `server`  | `PostgresCredentialVaultRepository` | `credentials`, `credential_leases`, `credential_audit_events`, `credential_commands` (0064) |
| Local, Hosted `simple`          | `SqliteCredentialVaultRepository`   | `credentials`, `credential-connectors`, `credential-leases`, `credential-audit-events`, …   |
| Tests and ephemeral composition | `InMemoryCredentialVaultRepository` | process memory                                                                              |

`assertCredentialVaultRepositoryConformance` (`@control-plane/credential-vault/conformance`) runs the
same sequence against every adapter: receipt replay, one live credential per workspace connector,
workspace-scoped reads, revision-pinned leases across rotation, single-use consumption under
concurrency, scope mismatch, expiry, revocation of outstanding leases, pagination, and a scan that
the secret canary never reaches persisted state.

Invariants:

- Credential and lease IDs (`crd_`, `crl_`) are server generated. A workspace connector has at most
  one non-revoked credential; revocation frees the binding.
- Leases live at most 300 seconds (also enforced by a PostgreSQL check constraint), pin one
  credential revision, and are consumed by compare-and-set before the secret is decrypted. A
  replayed, concurrent, expired or revoked lease cannot decrypt.
- Rotation adds a revision; earlier revisions remain resolvable only for leases already pinned to
  them. Revocation sets `revoked`, revokes every active lease atomically, then deletes every stored
  revision through the provider. A retried revocation repeats the idempotent deletes.
- `expired` is derived from `expiresAt` at read time and is never persisted. `secret_required`
  marks metadata without usable secret material (profile import); a rotation re-enters the secret.
- Audit events (`credential.created|rotated|revoked|imported`, `lease.issued|used|denied`) carry
  identifiers, revisions, principal references and bounded reason codes only. The PostgreSQL audit
  table is append-only (update/delete rejected by trigger).
- Secret references store a digest of the stored ciphertext envelope, never of the plaintext.
- A vault composed without a `PolicyDecisionPoint` (the Control API) denies every lease.

## Control API

`POST /v1/credentials/{create,rotate,revoke}` require `credential:write`; `POST
/v1/credentials/{get,list}` require `credential:read`. See [`api.md`](api.md#workspace-connector-credentials).
Managed Cloud composes the API with `NeonEncryptedSecretProvider`, `PostgresEncryptedSecretStore`
and the key reference `control-plane-secret-encryption-key/v1` when
`CONTROL_PLANE_SECRET_ENCRYPTION_KEY` is configured; otherwise the routes fail closed with
`CREDENTIAL_VAULT_NOT_CONFIGURED`. Local and Hosted compositions do not yet compose a secret
provider, so their routes stay unconfigured; their SQLite/PostgreSQL repositories are ready for
that wiring.

OAuth authorization-code exchange is not implemented: no OAuth helper exists in this repository.
It is a follow-up that must store the refresh token through the same create/rotate path.

## Tool Gateway leases

`VaultToolCredentialBroker` implements the tool-side lease port: per call it resolves the policy
snapshot for the execution workspace (absence denies), finds the workspace connector's live
credential, leases it (`credential:lease`, default 60 seconds) and consumes it immediately inside
the executor callback. See [`tool-gateway.md`](tool-gateway.md#vault-leased-connector-credentials).

## Profile portability

Exports include `credential-metadata` records (ID, workspace, connector, provider, revision,
timestamps, creator) and never status, secret references or secret values. Imported credentials
arrive as `secret_required` (or stay `revoked`) with a `credential.imported` audit event; an
operator re-enters each secret with `POST /v1/credentials/rotate` using the imported revision as
`expectedRevision`.
