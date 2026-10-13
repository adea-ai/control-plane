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
