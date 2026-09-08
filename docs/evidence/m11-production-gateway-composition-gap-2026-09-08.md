# M11 production Runtime Gateway composition gap

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
