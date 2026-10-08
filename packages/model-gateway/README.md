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

| POST path under `/v1/model-connections` | Envelope operation            | Existing scope     |
| --------------------------------------- | ----------------------------- | ------------------ |
| `create`                                | `model-connections.create`    | `credential:write` |
| `revoke`                                | `model-connections.revoke`    | `credential:write` |
| `list`                                  | `model-connections.list`      | `credential:read`  |
| `defaults/get`                          | `model-defaults.get`          | `credential:read`  |
| `defaults/set`                          | `model-defaults.set`          | `credential:write` |
| `selection/resolve`                     | `model-selection.resolve`     | `credential:read`  |
| `selection/funding/get`                 | `model-selection.funding.get` | `credential:read`  |

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

## Current authority composition

`createCurrentModelConnectionComposition` in Control API explicitly installs
`CurrentModelAccountAuthorization` into the existing administration and selection
services. The host's `CurrentModelAccountAuthority.readCurrent` must perform an
authenticated current provider/account read for every connection, readiness,
admission and inference boundary. Its strict `model-account-authority/v1` evidence
pins credential revision, provider/account/auth/funding, workspace grant, allowed
connection administrators, exact models and harness/version/binding/location,
entitlement, quota and residency. Previously stored evidence cannot substitute
for this read: `observedAt` must be at least the requested boundary time, no later
than the host clock, and still unexpired. Missing, stale, unknown, revoked or
incompatible state denies with a bounded reason. No production host or real
provider qualification is installed by this package.

`createPiLeadModelAdmissionReadiness` supplies R1's trusted Node
`assertProviderReady({evidence, plan, ids, actorPrincipalId})` callback after
canonical plan/scope validation and before marker, command acceptance, attempt or
budget creation. It resolves only metadata, checks exact target and selection,
reuses the gateway route/policy/capability/residency/entitlement/token checks,
and rereads readiness before returning. `buildRequest` is a server-owned
projection. The original product actor comes from authenticated canonical
product evidence; transport reader, admission and vault lease principals are
separate. The Node owner supplies current kernel scope/product audience checks.

For admitted inference, `createExecutionBoundModelSelectionService` retains only
the strict host-derived `execution-model-selection/v1` binding. It pins workspace,
execution/attempt/request, plan ID/digest/version, policy digest, original actor,
admission/lease principals, model alias, authority revision and selection ref/revision.
`CurrentModelExecutionAuthority.assertCurrent` recomputes the accepted binding and
current kernel scope, actor audience, grant and expiry from server-owned records.
The facade rereads this authority and account/credential readiness before resolving
and inside each credential callback. R1 constructs, uses and disposes its pinned
Pi Models registry inside that callback. No provider implementation or secret may
escape. `createExecutionBoundModelHttpAuthority` similarly wraps the existing
HTTP authority and chains these checks into `assertActive` immediately before
physical send, closing a newly acquired lease when a later check denies. The
existing recorded spending decision, price and per-physical-send ledger retain
ownership of spending and reconciliation; readiness never authorizes funds.

## Explicit payer disclosure

The additive SDK method `getModelSelectionFunding` sends
`model-selection.funding.get` to `POST /v1/model-connections/selection/funding/get`.
Its read envelope requires workspace and caller plus
`{executionId, attemptId, selectionRef, selectionRevision}`. Existing six model
response schemas and signed execution plans do not change.

Hosts compose `createRecordedModelFundingViewResolver` with an authenticated
`AcceptedModelFundingExecutionAuthority.resolveForReader` that authorizes the
transport reader against the accepted product intent/audience and derives the
full execution binding from server records. Caller parameters are references,
never authority. Its `assertCurrent` independently rechecks original actor and
current scope. `RecordedModelFundingAuthority.readCurrent` reads the authenticated
recorded spending decision plus an explicit payer record; it must deny missing,
revoked or unknown payer evidence. The helper validates the existing recorded
grant and price schemas, exact plan/selection/actor/principal/alias/policy/credential
bindings, funding and validity. It does not mint a grant or allocate a budget.

`model-funding-display/v1` always includes workspace, execution, attempt and
selection ref/revision. `ready` adds provider/model/account/auth/funding,
`fundingOwner:{ownerRef,kind,displayName,revision,evidenceRef}`, authorization ref,
authority revision and an expiry bounded by grant and price validity. `blocked`
includes only that binding and a bounded reason code. Connection owner or account
reference never substitutes for payer. No credential lease is created to read the
view. A ready display confers no execution or physical-send authority; the native
spending boundary must reread its own current recorded decision and price.

Deterministic fault and HTTP/SDK tests exercise these compositions without live
provider access. Combined kernel/R1/Adea integration, explicit production account
and payer adapters, funding UI and live-provider qualification remain open under
#931. Unconfigured funding and model hosts return unavailable and must preserve
independent direct/native sessions, persona and drafts without fallback inference.
