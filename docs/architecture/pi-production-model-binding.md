# Production Pi lead binding

This opt-in composition connects the actual control-api startup to canonical
repositories, the model connection service, the vault, private recorded payer
authority and the Node Pi Durable runtime. It creates no credentials or spending
grants and does not enable a provider automatically. Existing startup paths work
without the option; the new publication service denies when unconfigured.

`startControlApi` accepts `piDurableProduction`. Configuration requires an existing
service authenticator, current account and scope authority, canonical execution
repositories, usage ledger, current product reader, immutable profile resolver,
recorded funding directory, expiry release and inference reconciliation ports.
Missing dependencies fail closed. Provider and spending use the same confirmed
execution-bound model facade. Only canonical terminal attempts with released or
reconciled allocations permit cache cleanup; unknown physical sends retain holds.

The trusted product reader supplies the original DB actor and current audience,
message and profile version/revision. CP resolves that exact immutable profile
version to its digest and persists one selected model reference per intent. A
fresh evidence or profile change denies replacement of the accepted winner.
SQLite reopen retains the winner; every read still requires fresh product and
model readiness evidence. Transport and lease principals never replace the actor.

`createProductionProductHttpReader` sends HTTPS POST to
`/api/internal/pi-durable/lead-product/current` with exactly `workspaceId`,
`intentId` and `principalId`. An operator-supplied existing credential provider
must supply the service assertion for audience `adea-lead-product` and existing
`execution:read` scope. Adea independently verifies signature, issuer, pinned key,
workspace, credential kind, expiry and current revocation. CP does not generate
keys or tokens. The complete read, including credential acquisition, has a
five-second deadline; responses are bounded and errors reveal no upstream payload.

Publication uses SDK `getPiDurableLeadPublication`, operation
`pi-durable.lead.publication.current`, POST
`/v1/pi-durable/lead-publication/current`, existing `execution:read` scope.
The request contains only dispatch and preparation references. The response's
`data.publication` binds workspace, intent, dispatch, preparation, execution,
attempt, session, accepted model selection and original actor, plus current CP
authority revision, expiry and SHA256 of the exact retained UTF8 output text.
Trailing newlines are included. Output is never returned by this operation.

The required publication authority port must independently reread current CP
principal/grant/revocation, explicit payer confirmation, original actor and latest
attempt. It must never call Adea's product reader: Adea holds its own current
actor/audience/message/profile locks while comparing all returned pins and digest.
Completed inference and funding readiness alone confer no publication authority.
The CP reader uses retained receipt/preparation/marker and metadata-only native
journal status; it never starts runtime, leases credentials or reserves spend.

Qualification remains separate from the merged fixture journey. Deployment trust,
immutable profile mappings, lock-safe CP authority integration, live provider,
device and full restart/cancellation/publication fault qualification remain open.
Missing configuration leaves production lead and publication unavailable.

## Source-authority review checkpoint (#1178, 2026-10-13)

Verified characterization and the physical/profile qualification still required by
Adea #1178 are separated in
[`pi-source-authority-qualification.md`](pi-source-authority-qualification.md). Nothing
below is physical qualification.

The current contract carries one workspace through product evidence, immutable
profile/model resolution, execution and publication. Companion Adea draft
[#1327](https://github.com/adea-ai/adea/pull/1327) withholds foreign-Agent evidence;
this CP draft retains that boundary and changes no production contract.

The proposed next slice is recorded in Adea's
[`pi-lead-product-composition.md`](https://github.com/adea-ai/adea/blob/fix/1178-foreign-lead-execution-evidence/docs/architecture/pi-lead-product-composition.md).
Review it before shared-contract edits: retain host conversation/product and
publication scope separately from canonical source Agent/profile/model/tool and
existing funding authority, through preparation, retry/restart, dispatch,
continuation and publication. A host-scoped service assertion or enlistment does
not authorize source execution. Missing source authority must remain blocked,
without host profile/model fallback. Context stays isolated per host conversation
and qualified source Agent using upstream Pi-native execution.

Fresh product/HTTP tests on published CP head
`bc1d84647d62babd5f8241bfcdd0b24087f815ff` passed 13 tests, 0 failed. Adea's
published head `5c32e220dac26b0aac6cf0487fe2a8957b02e937` passed its prepared
foreign-source propagation/context/revocation regression in a fresh disposable
loopback PostgreSQL database after 52 canonical migrations and a deterministic
rerun (7 lead-product tests; 73 additional group/lead tests). Existing databases
were not changed. These checks do not qualify physical source tool effects or
live provider execution; full dual-authority execution remains outstanding.

### Additive source contract checkpoint

`PiLeadHostSourceAuthoritySchema` binds canonical host conversation, original
actor, message, audience digest and enlistment pins to a separately qualified
source workspace/Agent and immutable profile pins. Its context reference is a
deterministic identity for the host conversation plus qualified source Agent,
independent of per-turn message/version pins. `PiLeadSourceExecutionBindingSchema`
retains that authority with exact source profile/model and execution/attempt/native
session pins. Neither parsing nor the digest confers source authorization.

The initial abuse cases are host scope substituted for source scope, source
identity omitted, forged authorization fields, cross-group/native-context reuse,
same-name Agent conflation and changed actor/audience/enlistment/profile pins.
Strict parsing and comparison to fresh canonical metadata deny these substitutions.
Existing principal/grant, model, tool and payer authorization must independently
qualify the source before a lifecycle adapter may execute. These additive schemas
are not wired to startup or the existing single-workspace evidence endpoint;
Adea's foreign-Agent guard remains enabled.

`createProductionSourceLeadProductAuthority` adds a separate candidate product
composition. It independently verifies existing host service authority and source
execution authority for the original human, resolves profile/model in source
scope through the existing production authority, and retains both host/source
metadata plus exact profile/model pins in SQLite. The execution evidence's
`scopeRef` binds the complete canonical source snapshot; the existing admission
and runtime paths retain that scope digest. Snapshot changes during awaited
profile/model reads deny, and SQLite reopen cannot adopt a changed source default
or replacement enlistment. Retained metadata is not authorization: every current
read still checks both required authority ports. Startup remains unchanged;
source lifecycle integration and physical effect qualification are subsequent
checkpoints.

Review repair: source product reads recheck the fixed intent deadline after
authorization waits and immediately before synchronous acceptance. Final
acceptance requires a `withCurrentAuthorization` port that holds canonical host
service and source actor/principal/grant authority together; sequential assertion
ports alone cannot configure this candidate. A production lock-backed port is
still an integration requirement. Fake-clock and revocation regressions cross
the final source wait and combined acceptance boundary. The mid-profile
revocation test now returns a valid profile and successful model readiness, so
only current source authorization can deny that case.

### Candidate Node lifecycle composition

`createProductionSourceNodeComposition` wraps the existing Node admission,
preparation, journal, usage and Pi-native runtime. It requires an existing source
transport principal, the source product authority and an independent host-context
qualifier. Compiled plans must use source workspace scope and the exact qualified
Agent/profile; host workspace, legacy project and changed immutable pins deny.
Provider resolution and governed effect boundaries recheck the retained source
binding. Effects resolve the exact native journal attempt and require source
workspace/profile/grant scope before invoking existing current tool authority.
Unqualified child wiring is refused for this bounded slice.

The source sidecar now retains a verifiable host/source scope digest, prompt
digest and original expiry without copying prompt/history. Raw host/context edits
cannot be joined to an unchanged runtime marker. Its retained execution-binding
reader derives execution/attempt/session from the canonical marker, exact plan,
budget and existing native handle. It performs no product callback, reservation,
credential lease or runtime start; current publication authorization remains a
separate required gate. This is candidate lifecycle code, not a qualified running
path. Startup/HTTP wiring, full lifecycle integration and physical-source proof
remain outstanding, and Adea's foreign-Agent guard remains enabled.

### Candidate source publication checkpoint

`PiLeadSourcePublicationSchema` joins the retained host/source execution binding
to the existing CP publication proof, requiring exact source workspace, intent,
original human, execution/attempt/native session and model pins. The execution
binding now carries the fixed canonical `intentExpiresAt`; publication cannot
renew it. `createSourcePiLeadPublicationReader` reads retained metadata without
calling Adea, rechecks existing CP publication authority after awaited metadata,
then requires a combined current CP host-service/source-principal/grant/payer
fence for synchronous acceptance. Fresh CP proof expiry is capped at the original
intent deadline and rechecked after fence acquisition. No output is returned.

The running candidate regression exercises real prepare/admission/SQLite/native
generation/progress/reopen and the real retained publication service, including
callback-free metadata and denied publication after revocation. Its host/source
and funding authority ports remain synthetic. Production combined fences,
Adea delivery integration and the existing authorized physical source tool
destination remain unqualified; this evidence is not a physical-source proof.

Child allocation repeats product and model readiness while holding its canonical
allocation transaction. Model and vault metadata stored on that same persistence
provider use `@control-plane/deployment/read-scope` to read through the open
transaction during this fence. The scope is bound to the exact provider and async
caller; unrelated callers still serialize normally. It exposes no writes or
credential leases, expires when the check returns, and rejects detached pending
reads before allocation can commit. Pending tracking covers each `get`, `list`
and `scan` promise even if its metadata callback has already returned. Nested
scopes over the same provider and transaction also retain that read in the
ancestor scope, so catching an inner rejection cannot permit an outer commit.
The entire same-transaction nested callback is tracked from entry, even before
its first read. An expired ancestor closes every descendant read and refuses
new same-transaction scopes from that expired async context.
Ambient ancestry survives interposed providers and transactions. Only the exact
provider/transaction pair shares pending lifetime fences; independent transactions
remain usable after an unrelated ancestor closes. Fresh metadata reads and writes
find the nearest matching provider scope, without reviving an expired scope or
allowing a captured reader to cross its original caller context.
Recovered child-session binding applies the same read fence around its current
authority callback, retaining the canonical before/after tuple checks and reader
closure. Metadata reads cannot queue behind that callback's own transaction, and
metadata writes cannot join it.
Readers captured from another provider or an expired nested scope refuse before
accessing the transaction. Metadata writes attempted in the fence fail
closed. Product, account, quota, revocation, lineage and expiry checks still run;
no accepted selection or authority result is cached to bypass a current read.
