# M11 production Runtime Gateway composition gap

## Bounded SQLite storage scan prerequisite

PersistenceTransaction now exposes an exclusive storage-ID scan with a validated
page limit of 1 through 128. SQLite applies namespace equality, optional ID lower
bound, ID ordering and LIMIT in SQL against the existing namespace/ID primary
key. It does not load a namespace and slice the result in application memory.
Existing list ordering and behavior are unchanged. The file-backed test covers
out-of-order insertion, namespace isolation, page continuation after reopen,
empty pages and invalid limits/cursors.

This is a storage primitive, not RuntimeInventoryCheckpointScanner parity:
SQLite durability records currently hash domain identifiers into their storage
keys. A storage cursor cannot be substituted for the runtime scanner's node-ID
cursor. The compatible domain-index/migration design and SQLite runtime registry
remain outstanding, as does production composition. Pages are not a durable
snapshot across transactions; callers must account for concurrent changes.

## SQLite projection prerequisite parity

SqliteRuntimeDiscoveryRepository now exposes the same conditional runtime
projection update: expected-model comparison, scope check and revision-protected
write occur inside its persistence transaction. Runtime/definition/node identity
changes and backwards observation time reject. A single-runtime read now uses
the namespaced record key directly rather than listing the entire projection
collection, while retaining workspace/node filtering.

The file-backed SQLite test checks one winner among eight same-provider calls,
wrong workspace, stale expected state, backwards time, changed runtime identity
and persistence of the winner after closing/reopening the database. A point-read
fixture throws if collection listing is attempted. This does not prove
cross-process contention behavior, SQLite runtime-registry/scanner support or a
Local maintenance composition; those remain separate gates.

## Inventory maintenance implementation

RuntimeInventoryMaintenance now consumes the checkpoint and per-node connection
scanners, registry, health service, ownership lookup and conditional projection
writer. Each pass handles at most one node and one connection page (default 32,
maximum 128). Concurrent calls share the running pass. Cursors advance through
history and reset at cycle end; restart begins a fresh cycle. Invalid scan
ordering/scope rejects before writes. Per-record failures are reported and do
not prevent later records/cycles from being visited.

The pass refreshes stale/disconnected inventory, expires disappeared history at
its declared expiry and preserves revocation. Projection updates retain existing
access restrictions, eligibility reasons, capability metadata and remediation;
they only reduce eligibility. A scoped compare-and-set prevents replacement of
a changed projection, and later cycles can retry after registry state already
changed. Unchanged projections do not generate repeated writes. Registry and
projection writes remain separate transactions, not an atomic cross-repository
commit. Retried availability-event publication remains a separate durability
concern.

RuntimeGatewayWebSocketServer accepts an injected maintenance pass and runs it
after lifecycle sweeps, using the same non-overlap/shutdown behavior. Incomplete
pages produce the fixed sweep-failure diagnostic. Production startup still must
supply this composition; simply constructing a server without maintenance does
not enable inventory refresh. Dependency timeouts, fleet latency and SQLite
scanner support remain unverified/unimplemented respectively.

Focused tests cover pagination, disconnected state, restriction preservation,
idempotent convergence, disappeared expiry, revocation, projection conflicts,
missing projections and invalid scan scope. The cloud remote drill now routes a
real WebSocket inventory frame into PostgreSQL rather than rejecting inventory.
After channel drain, an explicit maintenance pass produces stale/ineligible
discovery with offline node health. That PostgreSQL-backed drill and existing
database restart/restore lanes pass. Identity and native responses are still
synthetic/scripted; the clock for post-disconnect expiry is advanced in the
fixture. This is not production deployment, multi-host load or native runtime
acceptance. Earlier inspection entries below retain historical provenance.

## Per-node connection scan prerequisite

RuntimeConnectionScanner adds a node-scoped, exclusive connection-ID cursor with
a validated 1–128 result limit. PostgreSQL applies the node predicate, cursor,
ordering and limit in SQL, instead of loading all historical rows into the
worker. The scan intentionally includes revoked/disappeared history; callers
must preserve those states rather than implicitly revive them. The original
unbounded list method remains available for existing consumers.

In-memory and PostgreSQL tests check out-of-order insertion, stable pages,
cross-node exclusion, invalid bounds/cursors and an empty final page. The
PostgreSQL test also includes a revoked record and continues a page through a
recreated repository. This bounds returned rows, not query execution time or
whole-fleet cycle latency. SQLite scan support, the actual refresh loop and
performance/deployed acceptance remain separate unfinished work.

## Discovery refresh concurrency prerequisite

PostgresRuntimeDiscoveryRepository now exposes a scoped compare-and-set for
runtime projections. It compares the complete expected JSON projection in the
same SQL update, preserves stored workspace/node ownership, rejects identity
changes or backwards observation time, and returns false if the row is missing,
outside scope or changed since the read. The existing ingestion upsert remains
unchanged; refresh callers must use the new conditional operation.

The PostgreSQL integration regression starts eight competing updates from the
same prior projection and observes one winner. It also checks wrong-workspace
rejection, stale expected-state rejection, retained winner state, backwards time
and changed runtime identity. This protects a future refresh writer from
overwriting a newer projection; it does not make the registry and projection
one atomic transaction or implement the refresh worker itself.

## Durable inventory scan prerequisite

RuntimeInventoryCheckpointScanner now provides an internal keyset scan by node
identity, with an exclusive cursor and a validated page limit of 1–128. The
PostgreSQL implementation bounds the SQL result itself and does not depend on
live channels or nonempty runtime references. A matching in-memory implementation
supports deterministic worker tests. SQLite does not yet implement this scan.

Tests cover stable ordering, page continuation after repository recreation,
empty final page, invalid bounds/cursors and mutation isolation for the fixture.
The PostgreSQL case uses actual stored checkpoints with empty runtime lists;
it is not a transport disconnect/restart certification. This enables subsequent
bounded refresh work but does not schedule it or update health/discovery yet.
A worker must finish and restart scan cycles so records inserted behind a cursor
are revisited, and preserve workspace ownership from each checkpoint. The scan
is deliberately not a public discovery operation or an authorization bypass for
end-user APIs.

## Server lifecycle scheduling follow-up

RuntimeGatewayWebSocketServer now schedules lifecycle sweeps after startup with
a default one-second interval (configurable positive integer up to sixty
seconds). Scheduling is completion-based: a slow sweep never overlaps the next
one. Failure reports a fixed diagnostic with no raw persistence error and allows
a later retry. This is not a hard real-time deadline or a timeout on repository
calls; production dependency timeouts remain necessary.

Shutdown cancels the timer, awaits the current sweep, prevents new upgrades
(including authentication finishing during drain), closes the lifecycle and
stops the native listener even when lifecycle cleanup fails. Repeated close
calls share the same completion. Restarting a closed instance is rejected.

Scheduler tests cover non-overlap, drain waiting, cancellation before the first
tick, isolated reporting failure, retry, cleanup failure and upgrade/drain race.
A real-WebSocket test with synthetic identity and an in-memory repository
changes ownership without push notification or a manual sweep and observes
automatic stale-socket closure. This closes the server's missing lifecycle
timer, not inventory health/disappearance scheduling or production composition.

## Gateway repository coordination follow-up

The cloud remote drill now composes this adapter with the PostgreSQL ownership
repository instead of its former in-memory coordinator. It requires the live
WebSocket owner to exist in PostgreSQL, drains the server, then checks through a
recreated repository that active ownership is gone but replay of that generation
is still rejected. The historical inventory below describes the earlier
inspected candidate; this follow-up changes its coordination entry only.
Identity and runtime responses remain synthetic/scripted, inventory frames
remain unsupported by the drill, and this is not a deployed multi-host test.

RepositoryRuntimeNodeCoordination now adapts the ownership repository to the
gateway's coordination port. It intentionally does not require push replacement
notifications: active inbound frames and lifecycle sweeps consult authoritative
ownership, as outbound sends already did. An old channel closes without
publishing an offline event for its replacement. This provides reconciliation
when notifications are absent; an actual bounded sweep schedule is still a
production composition requirement.

Two lifecycle regressions use separate coordinator instances sharing an
in-memory repository fixture. With no replacement callback, either a stale
inbound ACK or an explicit sweep closes the old socket, does not dispatch its
message, preserves the newer owner and avoids a false offline event. These
tests prove the lifecycle integration, not PostgreSQL-backed live sockets or
cross-host timing. Ownership changes during an already-running handler still
require operation-level fencing; a pre-dispatch lookup alone is not an atomic
transaction with downstream effects. Production identity/startup, scheduling
and deployed concurrent replacement/recovery acceptance remain open.

## Durable ownership prerequisite implementation

The follow-up adds RuntimeChannelOwnershipRepository in runtime-sdk and its
PostgreSQL implementation with migration `0037_runtime_channel_ownership`.
Per-node transaction locks serialize claims, heartbeats and releases. A release
marks the row inactive instead of deleting its generation fence. Claims from a
different workspace reject; stale generations cannot take ownership, heartbeat
or release a replacement. Heartbeat updates cannot move time backwards or
change the admitted channel identity/protocol.

The real PostgreSQL integration test exercises eight concurrent repository
claims (one winner), replacement, stale heartbeat/release, wrong-workspace
mutation, monotonic heartbeat, release, repository recreation and generation
replay. All 29 database tests and the configured integration/remote/drill lanes
pass. Repository recreation is not a native gateway restart certification;
the existing database restart/restore drills are not a dedicated channel
recovery test. Cross-instance replacement notification, gateway wiring and
production identity validation are still required. No production migration has
been applied. The inactive fence currently has no deletion policy and must not
be deleted without preserving replay protection.

Inspected candidate: `be6fc08f6be872fe346de00e0d822d1c439d30a6`.
Status: high-severity implementation and acceptance gap under #188/#194;
requirements/wiring reconciliation under #186/#187. Not a permissions failure
or a validated exploit finding.

## Dependency inventory

| Boundary                   | Current reachable evidence                                                                                                                                                                                                                        | Required production work                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Executable                 | `apps/runtime-gateway/package.json` starts `src/start.ts`; it calls `start()` with no server. `src/index.ts` rejects missing server outside local environments.                                                                                   | Build and wire the validated composition before readiness; preserve refusal on missing dependencies.                                                                                                                                     |
| Identity                   | `packages/runtime-gateway-protocol/src/authentication.ts` declares verification, revocation lookup and revocation subscription. The authenticator consumes this port; no concrete production validator was found in the TypeScript source search. | Resolve the accepted issuer/proof-validation and revocation boundary, configure its trust inputs explicitly, and test expiry, wrong scope, replay and revocation during a live channel. Do not promote synthetic identity to production. |
| Channel ownership          | `apps/runtime-gateway/src/websocket-coordination.ts` contains the coordination interface and an in-memory implementation.                                                                                                                         | Durable generation fencing and cross-instance replacement delivery, with restart, competing claims, stale heartbeat/release and workspace isolation tests.                                                                               |
| Persistence                | PostgreSQL runtime connection, inventory checkpoint, discovery projection, command and event-effect implementations exist under `packages/database/src`.                                                                                          | Compose these using the application database role; prove coherent updates/recovery instead of assuming separately durable writes are atomic.                                                                                             |
| Inventory and freshness    | RuntimeInventoryIngestionService is constructed by tests. No production caller of health refresh or disappearance expiry was found.                                                                                                               | Wire message routing plus bounded scheduling and discovery updates; verify shorter TTL, exact expiry, restart and reconnect against durable state.                                                                                       |
| Reachability and telemetry | The coordination module provides recording publishers/metrics used by fixtures.                                                                                                                                                                   | Connect bounded production telemetry and authoritative reachability publication with redaction, failure behavior and shutdown tests.                                                                                                     |

`scripts/run-cloud-remote-drill.mjs` constructs a real WebSocket server and
PostgreSQL command/event services, but uses synthetic identity, in-memory
coordination and recording telemetry. Its inventory handler explicitly throws
`UNEXPECTED_INVENTORY`. It cannot prove production startup, durable channel
ownership or inventory ingestion/freshness, regardless of a passing drill.

## Implementation order and release gate

1. Establish the identity-validation integration contract without changing the
   owning identity authority or reusing fixture keys/credentials.
2. Implement durable channel coordination and replacement notification with
   explicit concurrency and restart semantics.
3. Compose the existing durable repositories, real message handlers and
   operational sinks; add bounded health/disappearance refresh and cleanup.
4. Wire configuration through the executable, including dependency readiness
   and graceful drain. Test the actual executable, not only injected `start`.
5. Run the pinned Railway/Neon/Restate candidate with real authenticated native
   runtime traffic and the #188 fault matrix. Keep native execution-host work
   in `m11-native-remote-host-gap-2026-09-08.md` as a separate prerequisite.

These are prerequisites, not completed checklist items. The existing startup
tests establish fail-closed missing composition and injected lifecycle only.
No production configuration, identity authority or service was modified during
this inspection. No workers or servers were started.
