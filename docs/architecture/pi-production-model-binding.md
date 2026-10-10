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
