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
now uses the concrete gateway read client described below; redelivery orchestration
is still explicit. Production authoring composition, sequence allocation, policy authority, automatic reconnect and
multi-profile deployment acceptance remain unproven.

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
