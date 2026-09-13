# Authenticated context command delivery boundary

This service builds on the separate context-command ledger from #474. It does not
fabricate an execution, attempt, or RuntimeConnection for a context read.

Validation counts below record incremental snapshots. The latest gateway-client
validation is 1,343 passing tests (1,134 unit, 129 E2E, 80 smoke), with type-check,
lint/boundaries and formatting passing; coverage87.24% lines84.72% functions.

Commands are persisted before sending. Send failure leaves a dispatched record for
bounded reconnect enumeration; delivery requires a composition-owned sequence
allocator and rechecks active channel ownership after the durable update. Expired
commands become terminal without being sent. New grants longer than 24 hours are
rejected.

ACKs, results, and errors bind node, workspace, active channel ownership, generation,
and semantic payload digest to the persisted command. ACKs also match its last
delivery sequence. Successful results require the configured result store to return
a validated Artifact ID before terminal CAS. Result-store failures and a channel
replacement during storage cannot settle the command. A stable completion digest
detects altered terminal replays; classified errors do not retain raw provider
diagnostics. Terminal records cannot be reopened.

The gateway message router classifies context frames using the durable ledger in
the authenticated source's workspace. Context frames do not enter runtime-execution
event normalization. Unknown context commands retain the existing runtime route;
unsupported context progress frames fail closed. No caller-selected family field
is added to ACK/result contracts.

Focused tests exercise failed sends, stale channels/sequences, cross-workspace
frames, ACK/result replay, changed terminal content, failed Artifact persistence,
replacement during persistence/lookup, bounded results, and overlong grants. An
actual SQLite test closes and reopens the database before reconnect dispatch and
again before terminal replay, proving that the delivery state and completion digest
survive reconstruction without another result-store call.

The late-positive-ACK regression first failed with `CONTEXT_COMMAND_ACK_CONFLICT`;
it now returns the unchanged terminal record. Sixteen focused domain/delivery tests
passed with 101 assertions. Full repository tests passed 1,320 tests (1,113 unit,
127 E2E, 80 smoke), with type-check and subsequent lint/boundary/format validation
passing. SQLite is an explicit test-only dependency of the gateway package; Bun's
lockfile refresh also updates existing workspace version metadata, without adding
external packages. Post-rebase validation is recorded separately in the PR.

No SQL migration is needed for the optional completion digest in the stored JSON.
Older strict record readers cannot read that new field: deploy compatible readers
before enabling this delivery writer. No deployed composition uses this writer yet.
Rollback should stop its activation and preserve command history, not remove replay
digests from terminal records.

## Remaining acceptance

The separate node-local inbox now has a domain contract and transactional SQLite
repository. It keeps original command identity separate from gateway delivery
state, enforces at least 30 days of retention, reserves scoped operations atomically,
and uses versioned transitions. Executing calls can become reconciliation-required;
they cannot return to execution after recovery. Terminal results cannot reopen.
Accepted work may expire without starting a provider. SQLite close/reopen,
concurrent admission, cross-workspace reads, index-write rollback and terminal
replay are covered.

The RuntimeWorker ContextNodeHandler now consumes that inbox through required
authorization and provider-driver ports. It persists executing state before the
provider call, caps execution by timeout and remaining grant lifetime, retains
uncertainty after exceptions/timeouts, and exposes observational reconciliation
without automatically executing again. Authorization is bounded and checked before
admission, replay and result settlement; reconnect checks use the incoming channel
while preserving the original durable provider command. Four SQLite-backed handler
tests cover admission denial, concurrent redelivery, terminal replay, timeout and
restart/reconciliation, and revocation before output disclosure. Full validation
passes 1,329 tests (1,122 unit, 127 E2E, 80 smoke), lint/boundaries and format.
This remains component evidence: production transport and registry wiring, real
provider reconciliation implementations and remote-profile acceptance are missing.

The adapter now also exports a concrete CortanaHttpClient. It POSTs the existing
adapter request shape to a trusted configured read endpoint, with explicit optional
Authorization and no ambient credentials. HTTPS is required except explicitly
enabled loopback HTTP for local composition/testing. Redirects, URL credentials,
query strings and fragments are rejected; response JSON is streamed under a byte
limit and caller/deadline cancellation. The client makes one request and does not
claim server-side idempotency or reconciliation. Actual local HTTP tests verify
operation correlation and adapter bundle normalization, redirect rejection,
streaming bounds, malformed responses and an already-aborted caller. This does
not establish a live Cortana API contract; endpoint compatibility, node-driver
binding, scoped credentials and production composition still require validation.

ContextHttpProviderDriver now connects the node handler to that concrete client.
Its trusted configuration binds workspace, node, provider and mapped project;
command payloads cannot select endpoints or credentials. It uses the same extracted
bundle validator as the adapter (scope, revision pins, digests, token accounting,
evidence/memory authorization), additionally checking age and bounding inline
result bytes. A real local HTTP plus SQLite test verifies one read, durable bundle
replay after database reconstruction, and rejection of a changed project before
network access. The HTTP contract has no operation-status endpoint: reconciliation
explicitly returns unknown without issuing another read. No automatic recovery of
an uncertain external HTTP operation is claimed. Full suite: 1,335 passing tests
(1,128 unit, 127 E2E, 80 smoke); lint/boundaries and format pass. The node HTTP
driver still requires production registry, grant-authority and socket composition.

ContextNodeChannel now frames node acceptance/results for an authenticated socket
composition. Admission is durable before ACK, results come from durable inbox state,
and every outgoing frame requires current-channel and scoped-disclosure checks.
Same-command calls are serialized locally to avoid treating a live call as crashed;
in-flight receive calls are bounded at 128. Unknown effects produce no false terminal
failure. A real local WebSocket test drops the first result, reconstructs SQLite,
and verifies ACK/replayed ACK/result with exactly one provider invocation. It also
rejects a replaced channel. This test injects channel authority and the provider;
it does not prove production authentication or the complete gateway lifecycle.
Full suite: 1,336 passing tests (1,129 unit, 127 E2E, 80 smoke), plus lint/boundaries
and formatting. Production gateway composition and authoring wait/result retrieval
remain necessary to connect this bridge to the complete workflow.

The root E2E lane now runs the composed path in
`tests/m11-context-transport-e2e.test.mjs`: adapter-generated command, real gateway
WebSocket upgrade/lifecycle/router, signed synthetic-device authentication,
gateway/node SQLite repositories, node channel and concrete HTTP driver, and
filesystem Artifact validation before adapter normalization. Both ordinary and
deliberately lost first-result cases return evidence/memory with exactly one HTTP
provider call; the lost case records two gateway delivery attempts. Credential
revocation rejects subsequent gateway sends. Full suite: 1,338 passing tests
(1,129 unit, 129 E2E, 80 smoke); lint/boundaries and formatting pass.
The identity authority and compatible HTTP endpoint are test fixtures. The test
now uses the concrete gateway read client and heartbeat-driven context recovery
described below. Production authoring composition, policy authority and multi-profile
deployment acceptance remain unproven.

The ObjectStore-backed result implementation now verifies command-scoped metadata,
bounded JSON bytes, checksums, and completion digests before returning a deterministic
Artifact ID. Readback is mandatory; uploaded references are resolved only through
command-scoped keys. Real filesystem plus SQLite reconstruction, duplicate replay,
cross-workspace metadata rejection, and semantic tampering are tested. All 1,321
repository tests pass (1,114 unit, 127 E2E, 80 smoke), as do type, lint, boundary,
and formatting checks. This is local provider evidence, not remote object-store
or production activation evidence. Follow-up fault tests verify lost PUT acknowledgement
leaves delivery unsettled, retry verifies existing bytes without another PUT, and
oversized/non-object JSON/invalid UTF-8 uploads cannot settle delivery. Production
upload credential scoping still needs implementation and validation. Production
composition must provide the authenticated lifecycle sender, authoritative node
coordination, and durable sequence allocation. RuntimeNode context-driver execution
and node-side deduplication are implemented as described above but not activated in
production composition. Full multi-profile socket transport,
revocation/reconnect races, multi-profile replay, and provider authoring integration
remain required. These service/SQLite tests do not prove exactly-once external
reads or complete M11.

## Gateway read client

ContextGatewayReadClient replaces inline dispatch/wait glue in both composed E2E
cases. Shared request validation binds objective, operation, project, principal,
scope and budgets to the command before admission. Required policy authority runs
before dispatch and before/after Artifact reads. Polling is bounded by caller
cancellation and the request/grant deadline. Cancellation stops waiting, not provider
effects: queued or dispatched records are preserved. Signal checkpoints prevent
late authorization or sequence allocation from causing a cancelled wait to send.
Revocation during an Artifact read prevents disclosure without erasing terminal
history. Focused tests and composed E2E pass 19 tests/108 assertions, including an
uncooperative authority and cancellation before/after send. Production policy and
durable sequence allocation remain required composition ports.

## Durable channel sequences

The lifecycle now exposes an ownership-fenced sequence allocator backed by a
transactional SQLite repository. Reconnect, pending runtime dispatch and direct
context reads share reservations when configured. Reservations commit before
send; failed sends and lost commit acknowledgements burn numbers rather than
reuse them. Tests cover concurrent reservations, database reopen, channel-generation
isolation and exhaustion, plus the composed signed WebSocket path. Legacy runtime
composition without this port remains supported but is not durable-sequence evidence.
PostgreSQL allocation and production configuration remain required; no deployed
composition is activated. Full suite: 1,346 passing tests (1,136 unit, 130 E2E,
80 smoke), with build, type-check, lint/boundaries and formatting passing.
Coverage is 87.26% lines and 84.75% functions against unchanged 80% thresholds.

PostgresRuntimeChannelSequenceRepository adds the corresponding transaction-scoped
advisory lock and durable counter. Migration 0042 creates only the new sequence
table, with a database constraint bounding the next counter (including the exhausted
sentinel). Apply the additive migration before configuring this repository. Rollback
disables its use and preserves counters; dropping or resetting counters is not a safe
rollback while a channel can still send. Scope identity includes workspace, node,
gateway instance, connection and generation. A focused isolated Neon test passes
nine assertions for eight concurrent allocations, lost commit acknowledgement,
repository reconstruction, minimum advancement, generation isolation and exhaustion.
The full isolated PostgreSQL suite passes 33 tests and 416 assertions in 258.6 seconds.
The local suite passes 1,346 tests (1,136 unit, 130 E2E, 80 smoke), with 87.20% line
and 84.69% function coverage. Build, types and migration-schema checks pass.
No staging or production database was migrated, and production composition remains
unactivated. Migration-generated JSON is normalized by the repository formatter.

## Lifecycle-driven context recovery

ContextCommandRecoveryService runs one bounded page on channel activation and on
each heartbeat. The lifecycle retains the cursor only for that connection, resets
it on replacement, and requires a durable sequence repository when recovery is
configured. Context and runtime recovery share the allocator. Recovery reauthorizes
each pending command before and after sequence reservation; denial leaves durable
intent untouched and sends nothing. A failed recovery page is not advanced.
The signed WebSocket E2E lost-result case now sends a heartbeat instead of directly
calling delivery, and recovers the stored result with exactly one HTTP provider
call. Focused tests also cover replacement cursor reset, missing allocator rejection,
paging and grant revocation during reservation: 37 tests, 198 assertions.
Full local validation passes 1,349 tests (1,138 unit, 131 E2E, 80 smoke), build,
types, lint/boundaries and formatting; coverage is 87.21% lines / 84.71% functions.
The configured authorizer now uses the durable grants described below. This is not production wiring,
a full socket-reconnect matrix, or evidence that an uncertain external HTTP call
can safely be repeated. Production composition and multi-profile acceptance remain.

## Durable context grants

ContextCommandGrantAuthority reads current stored grants for each authorization,
binding workspace, node, provider, principal, project and scope, allowed retrieval
capabilities, token ceiling and evidence/memory permissions. It rejects absent,
malformed, expired or revoked grants and commands outside the grant validity period.
SqliteContextCommandGrantRepository supports trusted administrative creation and
idempotent permanent revocation; an existing authorization reference cannot be
recreated or broadened. Grant lookup is workspace-scoped. Reopen, concurrent revoke,
scope mismatches, expiry and over-budget requests are tested. The gateway also
reauthorizes after sequence allocation to catch revocation during reservation.
Both composed transport cases use separate gateway/node SQLite grant stores and the
real authority for dispatch, node execution/replay and result disclosure. Grant
provisioning is fixture-owned; this is not authenticated production administration
or proof of revocation propagation between hosts. No secrets are stored in grants.
Rollback must preserve revoked records and disable activation, not erase grants
or reuse their references. PostgreSQL grant storage, trusted provisioning/replication,
provider registry and production composition remain required.
Focused validation: 25 tests / 184 assertions. Full suite: 1,351 passing tests
(1,140 unit, 131 E2E, 80 smoke), build, types, lint/boundaries and formatting.
Coverage: 87.16% lines / 84.70% functions; thresholds unchanged.

PostgresContextCommandGrantRepository adds the same create-once and permanently
revocable contract with a composite workspace/reference primary key and row-locked
revocation. Migration 0043 creates the additive grant table; apply it and the
deployment's normal application-role table permissions before activation. Repository
reads validate the stored scope against projected lookup keys. The isolated Neon
focused test passes nine assertions for concurrent creation, concurrent revocation,
repository reconstruction, cross-workspace separation and denied reactivation.
The full isolated PostgreSQL suite passes 34 tests / 425 assertions in 253.1 seconds.
Local validation passes 1,351 tests (1,140 unit, 131 E2E, 80 smoke), build, types
and migration-schema checks; coverage is 87.06% lines / 84.57% functions.
No parent database is modified. This still does not provide production grant administration, propagation
to remote nodes, provider selection or composition-root activation. Rollback preserves
grant rows, especially revocations; dropping the table is not a safe live rollback.

## Authoritative read binding

ContextRuntimeNodeReadBinder replaces hand-built binding metadata in the composed
transport tests. It selects the node from the configured stored grant, checks the
requested provider/project/workspace and current channel, constructs the same
command as the adapter for authorization, then reserves a durable sequence and
rechecks grant and channel ownership. Cancellation checkpoints prevent late binding
work from returning usable metadata. Command IDs use 128 random bits; the caller's
operation ID remains the deduplication key, and trace identity comes from trusted
invocation context. A zero sequence exists only in local preflight validation and
is never returned or sent; failed reservations are not reused. Command admission
and operation deduplication remain owned by the durable delivery ledger.
Focused validation passes 22 tests / 131 assertions, including grant revocation,
cancellation and channel replacement during allocation, distinct command IDs,
stable operation keys and both real transport cases. Full local suite passes
1,352 tests (1,141 unit, 131 E2E, 80 smoke), build, types, lint/boundaries and
formatting. Coverage is 87.09% lines / 84.59% functions.
Provider selection, trusted grant provisioning/replication, remote identity
deployment and supported composition-root activation remain required. No production
resources or database migrations changed in this binding step.

## Gateway provider composition

GatewayContextProviderResolver implements the existing authoring providerResolver
port. Each resolution reads a trusted current registry snapshot, bounds it to 32
entries, rejects wrong workspace/principal and duplicate connection identities,
and composes the grant authority, binder, gateway client and existing provider
selection/normalization. Registry reads and subsequent work share a bounded deadline;
late registry completion cannot allocate or dispatch. Disabled policy skips the
registry entirely. Empty and stale-provider snapshots retain existing omission
semantics; the composition never fabricates fresh health timestamps. Transport
retries are disabled here; durable recovery owns redelivery and uncertain effects.
Both signed transport E2Es now resolve through this composition, including selection,
grant checks and normalized contributions. Focused checks pass 23 tests / 144
assertions. Full suite passes 1,353 tests (1,142 unit, 131 E2E, 80 smoke), build,
types and formatting; coverage is 87.10% lines / 84.56% functions. The explicit
gateway-to-context workspace dependency is reflected in the lockfile and architecture
inventory; no external package version changed. Registry snapshots and grant
provisioning are still fixture-owned. A production registry source, administrative
authorization/replication and composition-root activation remain necessary.

## Durable provider registry

ContextProviderRegistration defines versioned provider snapshots and optional
revision/output pins. SqliteContextProviderRegistrationRepository atomically writes
the registration and its workspace/principal active index. Updates use expected
versions, preserve provider/connection/principal/scope/grant identity, and reject
backwards health observations. Revocation removes only the active index entry;
the retained revoked record prevents recreation or reactivation. This retains the
current revoked registration, not a full historical revision audit trail. Active
registrations are capped at 32 per workspace/principal, enforced in the same write
transaction. Reads are bounded and validate index-to-record scope consistency.
Both composed E2Es now load bindings from SQLite rather than an array callback.
Focused tests pass seven tests / 131 assertions, including failed index-write
rollback, concurrent creates, stale updates, scoped lookup, pin persistence,
reopen, revocation and the active-capacity bound. Full validation passes 1,354 tests
(1,143 unit, 131 E2E, 80 smoke), build, types, lint/boundaries and formatting.
Coverage is 87.11% lines / 84.55% functions. No SQL migration or external resources
changed in this step. PostgreSQL registry storage, trusted administrative/health
publication and deployment composition are still required. Fixture-owned writes
are not production administration evidence, and rollback must retain revoked records.

## PostgreSQL provider registry

PostgresContextProviderRegistrationRepository stores the same versioned registrations
in additive migration 0044_narrow_la_nuit. Workspace/connection primary identity and
workspace/principal/state indexing support bounded active reads. Transaction-scoped
advisory locks serialize identity creation and scoped capacity checks across repository
instances. Updates preserve identity, reject stale versions and backwards health,
and retain irreversible revocation. Stored JSON is checked against projected scope
columns on reads and updates. No existing table or production data is rewritten.

Live Neon verification on a disposable staging child passed the focused registry
test (14 assertions), including 33 concurrent attempts with exactly 32 accepted,
concurrent first creation, stale updates, scoped reads, repository reconstruction
and permanent revocation. The complete PostgreSQL suite passed 35 tests / 439
assertions in 292.88 seconds, including migrations and the existing transaction,
execution, interaction, usage and recovery checks. The temporary branch was deleted
and its absence verified; staging and production were not modified. Credentials
were injected in memory, with no local environment-file changes.

Local validation passed 1,354 tests (1,143 unit, 131 E2E, 80 smoke), all 41 package
builds, type/migration/compatibility/architecture checks, lint and formatting.
Coverage was 86.94% lines / 84.47% functions. Production grant provisioning and
revocation propagation, trusted provider administration/health publication, recovery
fairness under denied grants and composition-root activation remain open. These
repository tests do not establish production administration or deployment acceptance.

## Recovery isolation for denied grants

The grant authority now exposes a typed definitive denial. Recovery catches only
that denial around each authorization check and continues through the bounded
page, including when permission is revoked after sequence reservation. Denied
intent remains durable and unsent; the cursor advances across denied records so
eligible later commands are not starved. Any reserved sequence stays consumed.
Authority/store errors, allocator errors (even a denial-shaped allocator error),
and delivery failures still propagate. No string-message matching or authorization
bypass is used, and no denied command is falsely marked completed or cancelled.

Focused validation passes 24 tests / 152 assertions, including mixed denied/eligible
commands, both grant-check positions, preservation of queued intent, and failure
propagation. Full validation passes 1,355 tests (1,144 unit, 131 E2E, 80 smoke),
build, types, lint/boundaries and formatting. Coverage is 86.94% lines / 84.45%
functions. Recovery deadline/cancellation, production administration and deployment
activation remain required; this fixes denial isolation, not all recovery gates.

## Bounded recovery and partial progress

Recovery now races a configurable page deadline (10 seconds by default, validated
between 1 ms and five minutes) and the connection's cancellation signal. Timers
and listeners are cleaned up on every exit. Delivery checks cancellation between
asynchronous boundaries, including after sequence reservation and dispatch-state
persistence, and forwards the signal to the authenticated lifecycle sender. That
sender rechecks cancellation after channel lookup and authorization before the
synchronous socket write. Replacement/disconnect/shutdown abort the connection's
recovery signal. The foreground read client forwards cancellation to delivery too.

On a deadline after partial progress, recovery returns the last fully visited
command as the next cursor and marks the page timed out. It never advances past
the in-flight ambiguous command. This permits later pages without repeatedly
starting at the first already-visited record. A timeout before any progress still
fails. Cancellation does not undo committed state, consumed sequences or a send
already initiated, and arbitrary dependencies must honor the supplied signal if
they perform their own delayed side effects.

Focused validation passes 44 tests / 255 assertions: late authority/allocator
completion, committed dispatch with a delayed persistence response and no send,
partial-page continuation, and connection replacement/shutdown signal propagation.
Both signed transport E2Es pass. Full validation passes 1,358 tests (1,147 unit,
131 E2E, 80 smoke), build, types, lint/boundaries and formatting; coverage is
86.96% lines / 84.45% functions. No production service was activated. Trusted
administration, cross-host revocation, health publication and deployment acceptance
remain required.

## Operator administration boundary

The operator-only `bun run context:admin` path provisions grants and provider
registry snapshots through the existing SQLite/PostgreSQL repositories. It accepts
only a bounded JSON document from an absolute regular file opened with no-follow
semantics, validates an explicit backend target, and emits generic diagnostics
without request contents or database URLs. PostgreSQL requires an explicit expected
host and database name matching `DATABASE_URL`; SQLite rejects relative and symlink
database targets. Grant replay is exact and idempotent, registration is expected-
version CAS and requires a matching current grant, and retirement is fail-closed:
revoke the grant first, then publish a revoked registration. The command is an
OS/database administration boundary, not a public API authorization shortcut.

Focused subprocess validation passes six tests / 147 assertions, including grant
and registration provisioning, exact replay/conflict handling, wrong-target rejection,
permanent revocation, restart lookup, malformed/oversized input, symlink input and
generic error output. The CLI does not synthesize health, replicate grants between
stores, or activate a production composition root. PostgreSQL CLI execution against
a live branch and production operator credential review remain external gates.

## Production composition roots

The runtime gateway and runtime worker now compose their context-command stacks from
explicitly configured stores instead of test-only construction. `composeRuntimeGateway`
builds the command, grant, registration, sequence and coordination repositories over an
explicitly configured SQLite path (idempotent migrate) or PostgreSQL credentials (no
migration; migration authority stays separate). It wires the delivery service,
grant-backed recovery authorization, the WebSocket lifecycle and server, and a provider
resolver whose bindings read the operator CLI's registration store at request time.
Host-provided ports (object store, upgrade authentication, metrics, reachability,
trace IDs) are validated at composition time; absent ports refuse startup. Unrelated
message families (inventory, delivery acknowledgements, events) fail closed with
RUNTIME_GATEWAY_ROUTE_NOT_COMPOSED until their own composition exists. `start()` no
longer starts an empty shell in any environment: without injected components it
composes from explicit environment configuration or refuses. `composeContextNode`
wires the node handler with grant enforcement over the explicitly configured node-local
store plus a transport current-channel assertion; PostgreSQL grant stores require an
injected durable node inbox (no adapter exists) and fail closed otherwise.

Focused E2E passes five tests / 40 assertions: provisioning strictly through
ContextProviderAdministration into both stores, signed-channel delivery and execution,
a dropped result recovered durably across a gateway restart with deliveryAttempts 2 and
no repeated provider read, revocation in both stores denying gateway recovery and
node-side authorization, a second restart keeping revocation denied, and fail-closed
start() for gateway and worker. SQLite composition coordination is single-instance by
documented limitation (no SQLite durable channel ownership adapter exists); the
PostgreSQL composition uses the durable ownership repository. Reconnects honor the
durable ledger's strictly increasing (generation, sequence) contract.

## Grants-backed authoring authority

`GrantsBackedContextAuthoringAuthority` derives every authorizing decision from a
current, unexpired, active grant reachable through an active registration plus an
explicitly validated composition policy. Construction parses the policy; there are no
permissive defaults. Provider requests are clamped by the grant and cross-checked
against the registration's advertised capabilities and execution locations; any
ineligibility degrades authoring to the documented no-provider path by omitting the
provider request. Artifact authorization heads the composition's object store and maps
lifecycle metadata markers to the port's state enum fail-closed; health and state are
never synthesized. Local and hosted compositions construct this authority by default
over their own stores with explicit bounded policies whose provider mode is `disabled`
(provider content composes at the runtime gateway); injected authoring options keep
precedence. The managed-cloud composition still accepts injection only. Validation:
15 authority unit tests plus one composition test provisioning strictly through
ContextProviderAdministration, authoring a real package through the default authority,
denying other principals and denying after operator revocation.

## Consistency observability and reconciliation scheduling

A bounded consistency-metric emitter (allowlisted label sets with a fixed fallback,
per-emission exporter isolation, redaction) is emitted from command-inbox acceptance,
reconciliation checkpoints, provider resolution, memory-write decisions and event
quarantine; labels cannot carry objective text, digests or identifiers. Local and
hosted compositions gain explicit completion-scheduled, rate-limited reconciliation
sweeps with validated bounds and clean drain; absent configuration runs nothing. The
sweeps require an injected reconciliation source/effects; no production observation
projection exists yet, so scheduling is reachable only where a host supplies one —
recorded as an open composition obligation, not silently defaulted. Loopback endpoints
and filesystem paths are now redacted; the secret-canary matrix (7 sinks) still passes.
Provider-resolution, memory-write and event-quarantine hooks exist but their producing
gateway/workflow compositions are not yet wired to production sinks.

## Integrated candidate validation

Candidate 46c146d (composition 7f25cff, authority f3bd7fd, ledger 6a9c829,
observability 950093b, foundation 46c146d). One integrated full suite passed:
1,404 tests (1,187 unit / 137 E2E / 80 smoke), coverage 86.61% lines / 84.38%
functions against the unchanged 80% thresholds, with build (41 packages), lint,
format and architecture checks green. The first integrated run caught one real
regression: the foundation smoke test still encoded the gateway's removed empty-shell
startup; it now boots through the injected channel server per the fail-closed contract.

## Live PostgreSQL CLI validation

The operator administration CLI was executed against a disposable Neon PostgreSQL 18
branch (child of staging, --no-secrets, expiry set, deleted and verified absent after
the run). Migrations 0042 through 0044 were applied to the live branch; operator
privilege configuration granted the application role access to exactly the grant and
registration tables; role membership replicated the preview workflow's ownership
preparation with the documented deviation that migrations ran through the owner
connection holding migrator membership rather than the CI migrator-role password. The
CLI then provisioned a scoped grant (and accepted its exact idempotent replay), failed
closed on a wrong expected host, registered a matching snapshot through expected-version
CAS, revoked the grant, and the revoked status was read back durably through the
application-role connection. No connection strings, passwords or branch names beyond
the disposable branch were recorded; staging and production branches were untouched.
Live PostgreSQL CLI evidence now exists; the separate external gates — deployed-profile
acceptance and independent review — remain open.
