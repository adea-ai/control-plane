# Model gateway and BYO model selection

The legacy managed alias router remains available. The opt-in `model-selection/v1`
path pins one provider account, credential revision, model, execution location,
harness/version/binding, workspace grant and configuration revision. A selected
BYO route must have exactly one matching deployment and never retries another
account or deployment, even when its provider reports a retryable error.

`RuntimeProviderSelectionSchema` and the HTTP schemas have one source in
`packages/contracts/src/model-connections.ts`, published with `@adea-ai/contracts`
and reexported by `@control-plane/model-gateway`. The public `@adea-ai/sdk` adds
`createModelConnection`, `revokeModelConnection`, `listModelConnections`,
`getModelDefaults`, `setModelDefaults` and `resolveModelSelection`. They become
available through the normal package release after authorized integration; existing
published versions do not imply these operations exist. Selection is metadata only;
resolving it does not invoke a model, lease a credential or grant execution authority.
The runtime retains `{selectionRef, selectionRevision}` and resolves the exact
immutable snapshot through `ModelSelectionService.resolveSelection` on reopen.
Every inference invokes `assertReady`; newer defaults affect subsequent admissions.
Revocation, expiry, changed credentials/grants and stale qualification block old work.

## Composition

Inject a durable `ModelSelectionRepository`, the existing `CredentialVault`, and
trusted `ModelQualification` into `ModelSelectionService`. SQLite uses
`PersistentModelSelectionRepository` over `PersistenceProvider`. PostgreSQL uses
`PostgresModelSelectionRepository` from `@control-plane/database`. The in-memory
repository is a deterministic fixture, not a production persistence composition.

`ConfiguredModelQualification` requires exact workspace/account/provider/model,
auth/funding, harness/version/binding and location evidence. Policy permission,
quota and evidence expiry are explicit. Missing, ambiguous or stale evidence
fails closed. A host may supply a qualification port that also evaluates current
residency/entitlement policy and budget; execution budget reservations remain with
the existing admission/usage authority, not this discovery service.

`ModelConnectionAdministration` binds existing vault credential metadata to a
trusted `ModelConnectionGrantAuthority`. Its resolver derives the verified provider
account, supported auth/funding mode, models and workspace grant. Requests cannot
supply a grant or reusable secret. Connection revocation invalidates its grant;
credential-wide revocation continues through existing credential administration.
Reconnect creates a newly authorized connection; it does not revive a revoked one.

`withCredential(selection, {requestId, principalRef, policySnapshot}, operation)`
leases the pinned vault revision for `model:invoke` and the selection reference.
The existing vault consumes the lease exactly once and blocks secret egress.
Construct the supported Pi provider and Models registry, perform inference, and
discard both **inside** `operation(secret)`. Return only the safe normalized result.
Never return a registry, credential-bearing callback, raw provider error or secret.
Credential rotation requires an explicit new selection. Lease capabilities are
transient and never belong in the persisted selection, context or journal.

Regular local Pi `ModelRuntime` credential configuration is distinct from Pi
Durable's explicitly supplied `Models` registry and from Cloudflare bindings.
The R1 implementation owns the supported Pi provider abstraction. This package
adds no custom provider engine, native OAuth extraction or credential transfer.
Qualification of Node SQLite `remote_host` does not qualify Cloudflare or a local
native subscription. Subscription flows stay blocked until their exact provider,
harness, auth mode and location are independently qualified.

## Control API

`ConfiguredModelConnectionService` is an explicit `createControlApiApplication`
binding. Unconfigured deployments return `MODEL_CONNECTIONS_NOT_CONFIGURED`.
All paths use the existing authenticated service envelope and workspace scope.
No new token, auth scope or credential setup is performed by this slice.

| POST path under `/v1/model-connections` | Envelope operation         | Existing scope     |
| --------------------------------------- | -------------------------- | ------------------ |
| `create`                                | `model-connections.create` | `credential:write` |
| `revoke`                                | `model-connections.revoke` | `credential:write` |
| `list`                                  | `model-connections.list`   | `credential:read`  |
| `defaults/get`                          | `model-defaults.get`       | `credential:read`  |
| `defaults/set`                          | `model-defaults.set`       | `credential:write` |
| `selection/resolve`                     | `model-selection.resolve`  | `credential:read`  |

Create/revoke/defaults-set use command envelopes. Create takes only
`{credentialRef, credentialRevision}`; the trusted grant resolver supplies account
metadata. List accepts `{target}` and returns connection metadata plus per-model
`{ready, reasonCode}`. Defaults are independent optional `lead`, `child`, and
`direct` choices `{connectionRef, providerModel}`. Setting them uses
`expectedRevision`; an identical accepted revision replays without another write.
Resolve accepts `{role, target, override?}` and returns a persisted immutable
selection snapshot. This is preparation, not job admission; retries may prepare
additional snapshots but cannot invoke or duplicate model work. The canonical
runtime/job admission selects and retains the one accepted reference.

Readiness errors are bounded codes: missing/expired/revoked credentials or grants,
changed revisions, quota exhaustion, incompatible harness/location, unsupported
auth mode, provider-policy denial and unavailable readiness. Clients map these
codes to reconnect, select another explicitly qualified choice, or retry discovery.
They must never turn an error into an automatic paid/account/provider fallback.

## Accounting and rollout

`byo_api` is an additive paid funding kind. Exact pinned API prices and held costs
are retained as BYO provenance; they are not subscription effects or HQ credits.
Public summaries add optional `byoApiMicrounits` when nonzero, preserving existing
HQ/subscription summary shapes. Existing paid API budget checks still apply.
Database migrations `0066_byo_api_funding.sql` and `0067_model_selections.sql` add
the enum value and metadata table. Apply them through the normal migration role
before enabling the new composition. This task does not apply migrations or
change live database access. Rollback disables the new composition and retains
selection/usage evidence; do not remove the enum while BYO ledger rows exist.
R1 coordinates the runtime-sdk and gateway-protocol funding extension separately.

Focused tests cover strict schemas, defaults/overrides, quota/auth/location faults,
revocation/rotation/expiry, pinned no-fallback routing, one-use vault egress, SQLite
reopen/concurrent CAS and authenticated HTTP. All provider inference evidence in
this slice is deterministic; no real credential or live-provider certification is
claimed. Local PostgreSQL migration/CAS/reopen integration uses synthetic loopback
credentials and passed separately. Exact-head aggregate CI, integrated runtime
and live-provider qualification remain release gates.

Tracks [R2 #931](https://github.com/adea-ai/control-plane/issues/931), with runtime
integration owned by [R1 #930](https://github.com/adea-ai/control-plane/issues/930).
