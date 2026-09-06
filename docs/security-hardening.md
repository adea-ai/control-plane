# Production security invariants

Control Plane treats every external request, RuntimeTransport frame, provider response, model/tool output, checkpoint payload, Artifact, database record imported from another profile, and event as untrusted data. Authorization derives only from authenticated principals, immutable ExecutionPlan constraints, scoped grants, and versioned policy decisions.

## Deployment-aware trust boundaries

The threat review uses STRIDE categories alongside the profile-specific controls below.

| Boundary                                   | Primary threats                                                           | Required controls                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Client / Adea → Control Plane          | spoofing, cross-workspace access, replay                                  | purpose-bound credentials, workspace scope, idempotency, normalized denial                                              |
| Direct Local Control Plane → RuntimeDriver | local privilege confusion, path/process escape                            | trusted local IPC/in-process allowlist, capability/scope validation, no policy bypass because components are co-located |
| Control Plane → non-co-located RuntimeNode | node/workspace substitution, replay, stale ownership                      | authenticated Runtime Gateway, command ID/digest/expiry, revocation, durable duplicate-effect ledger                    |
| Adea remote relay → Local/Hosted host  | ciphertext replay/tamper/wrong recipient                                  | HPKE recipient/AAD binding, expiry/replay checks, endpoint-only plaintext, cloud-safe metadata                          |
| Model/tool/MCP/provider adapters           | prompt injection, confused deputy, secret egress                          | policy before execution, exact pins, scoped leases, bounded output validation                                           |
| Persistence / Restate / events / telemetry | tenant leakage, tampering, secret/content leakage                         | workspace scope, integrity/idempotency, adapter-specific permissions, redaction, audit                                  |
| Sandbox                                    | path traversal, metadata access, ambient credentials, resource exhaustion | bounded paths/network/resources/time/output, ephemeral capability references                                            |

## Credential classes

Credential roles are deliberately separate:

- human/browser/desktop sessions;
- Adea ↔ Control Plane service credentials;
- RuntimeNode authentication/signing credentials;
- RuntimeNode/host E2E content-encryption keys;
- deployment/service bootstrap secrets;
- dynamic connector/provider credentials;
- local/private content encryption keys;
- external harness/provider-native credentials.

One class cannot substitute for another.

### Managed-cloud bootstrap configuration

M9 uses Railway service/shared variables for service/bootstrap configuration such as Neon connection references, service credentials, Restate configuration, R2 credentials, and bootstrap/master-secret references. Values never belong in source, images, issue bodies, public schemas, or ordinary logs.

### Dynamic connector/provider credentials

Arbitrary user-scoped OAuth refresh tokens, API keys, and connector credentials remain behind the audited credential-vault/secret-provider boundary. They are **not** modeled as one Railway environment variable per user credential. Managed Cloud uses `NeonEncryptedSecretProvider` with the repo-owned `credential_secrets` table and an externally supplied AES-256-GCM key. AWS Secrets Manager is not a supported dependency.

M10 adds Local/Hosted secret-provider adapters while preserving credential identity, lease, scope, rotation, revocation, and audit semantics.

## Persistence and workflow security

- M9 managed cloud uses separate Control Plane Neon PostgreSQL; Adea uses a different database.
- M10 Local and Hosted `simple` use SQLite; Hosted `server` uses PostgreSQL.
- Restate workflow state is separate from Control Plane domain persistence.
- LangGraph checkpoint state is separate from Restate and ProjectState.
- No deployment profile may widen workspace, provider, runtime, tool, model, secret, Artifact, or project authority merely because components are co-located.
- Reusable secrets are references/leases in durable state, not raw values.

## Enforced invariants

- Cross-workspace reads/writes fail closed without leaking existence.
- Child/delegated work may narrow but never widen parent authority.
- Prompt/model/tool/provider/memory content cannot create grants or bypass approval.
- Provider retrieval cannot mutate ProjectState or provider memory.
- Non-idempotent ambiguous effects enter `reconciliation_required`; missing acknowledgements do not authorize blind retry.
- Runtime Gateway applies only to non-co-located RuntimeNodes; Local direct execution cannot use a gateway hop as an implicit privilege/recovery bypass.
- LocalProjectGrant path scope remains canonical after symlink/path resolution.
- Sensitive local/private execution content remains on the selected user-controlled location unless an explicit transfer/promotion policy authorizes movement.
- Cloud/relay systems do not require plaintext HPKE-protected remote content.

## M9 security evidence

Existing M9 isolation, secret-canary, production-readiness, dependency, and CodeQL evidence remains
useful. M9.6 reran the applicable controls against the actual Railway + Neon + R2 + Restate staging
candidate and recorded the results in the certification evidence.

Required cloud checks include:

- Control API application and service-authentication tests;
- `apps/control-api/src/application.test.mjs`;
- `apps/runtime-gateway/src/authentication.test.mjs`;
- Railway public/private ingress and service identity;
- Neon runtime versus migration authority;
- Restate endpoint/access/logging boundaries;
- R2 bucket/credential scope;

The private Railway Restate server signs service-protocol requests with its volume-backed ED25519
identity key, and `workflow-worker` validates the corresponding public key through the Restate SDK.
Restate ingress and admin remain private. Self-hosted Restate has no application-level bearer-token
control on those ports, so the Cloud profile does not model one; any future public ingress requires
an authenticating proxy that strips infrastructure credentials before journaling.

- the selected dynamic credential-vault provider, lease/rotation/revocation and leak-canary behavior;
- build/deploy logs for secret leakage;
- provider/tool/model optionality and no-provider startup;
- Runtime Gateway authentication/reconnect where used.

Historical AWS/IAM/ECS controls do not substitute for Railway evidence.

## M10 security evidence

M10 adds tests for:

- Local IPC/direct RuntimeTransport authorization;
- SQLite file/WAL/backup permissions and secret exclusion;
- OS-secure secret handles and standalone-local secret references;
- Hosted environment/Docker/private-file/external-manager secret references;
- Compose/TLS/reverse-proxy boundaries;
- host-side HPKE decrypt/response/key rotation/revocation;
- Local/Hosted export/import validation;
- no silent cloud failover or content upload.

## Secret-canary sinks

Canaries must cover at least:

- Railway builds/deploy logs and service diagnostics;
- Neon migration/runtime errors;
- Restate inputs/state/logs;
- R2 metadata/errors;
- SQLite/PostgreSQL databases and backups;
- public APIs/SDK/events;
- Runtime Gateway/direct RuntimeTransport;
- credential-vault callbacks/leases;
- HPKE relay persistence/telemetry;
- LangGraph checkpoints;
- Artifact metadata;
- exports/imports;
- incident reports and ordinary telemetry.

## Incident evidence

Preserve stable request/workspace/execution/attempt/workflow/runtime identifiers, credential **kind** rather than value, policy/version/digest, command/event IDs, affected release/configuration, first/last observed timestamps, reconciliation classification, containment actions, and recovery result.

Do not copy prompts, repository/file content, provider payloads, memory values, HPKE plaintext/private keys, cookies, tokens, or reusable secrets into tickets or telemetry. Rotate/revoke exposed credentials before history cleanup and retain the sanitized audit trail.

## Milestone release rule

M9 certifies managed-cloud security, M10 adds Local/Hosted security/conformance, and M11 independently audits all profiles. A historical passing test cannot waive a security control whose implementation boundary changed during M9/M10.
