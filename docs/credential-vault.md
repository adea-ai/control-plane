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
