# Runtime Gateway protocol

`@control-plane/runtime-gateway-protocol` is the provider-neutral, versioned wire contract between the cloud Runtime Gateway and outbound RuntimeNode connections. It is distinct from the product HTTP/SSE API and never carries user-session or reusable device/provider credentials.

## Envelope and delivery rules

Every envelope identifies its schema and negotiated protocol version, node, workspace, channel generation, sequence, trace, and send time. Commands additionally require a stable command ID, idempotency key, content digest, issue/expiry timestamps, driver family/version, capability requirements, and semantic command family. Transport is at least once: redelivery reuses the same command ID and payload hash, while a hash mismatch fails closed.

Payloads are either bounded adapter-owned JSON or a content-addressed Artifact reference. Core validation rejects native provider command types and selectors for arbitrary endpoints, local paths, executables, databases, projects, source scopes, or reusable credentials. Context-provider status/read operations are optional; writes require a separate authorization reference. Inventory may advertise zero providers without affecting runtime negotiation.

The checked-in JSON Schema and golden/malformed JSON fixtures under `packages/runtime-gateway-protocol` are language-neutral. The TypeScript package depends on Zod and the provider-neutral Runtime SDK usage contract, and includes a deterministic reference RuntimeNode plus a reusable conformance runner; consumers do not need Control Plane server, domain, or database packages.

## Channel authentication

The WebSocket upgrade uses a short-lived `runtime_node` credential signed by an operator-controlled Ed25519 issuer and a proof signed by the registered device key. In this repository's Hosted/server PostgreSQL composition, the gateway receives only issuer public keys and reads registered device public keys plus issued-credential claims from PostgreSQL. The operator-only CLI holds issuer private-key authority outside the gateway process; the database never stores private keys, compact credentials, or proof signatures. Live Agent HQ/Cortana enrollment remains outside M11. User-session, provider, and reusable device credentials are not command envelopes.

The RuntimeNode sends `Authorization: RuntimeNode <credential>` and `X-Runtime-Node-Proof: <base64url-signature>` on the upgrade request. It signs the SHA-256 digest of the compact credential plus a challenge derived from that request's RFC 6455 `Sec-WebSocket-Key` (base64url alphabet, padding removed). This binds proof to one handshake without placing credentials in the URL. The gateway checks the operator signature/key ID, registered device proof key and thumbprint, exact issuer/audience/node/workspace/revocation version, expiry, and monotonically increasing channel generation. PostgreSQL atomically consumes each credential once across gateway instances; consumption is irreversible for the lifetime of the credential. Re-authentication requires a newly issued credential and a higher channel generation; it replaces the prior logical channel. Revocation and key-retirement notifications promptly invalidate active channels, but are only wake-up hints: every PostgreSQL-backed inbound write carries the authenticated credential ID/version into the same transaction as its state change. That transaction holds shared credential/key locks through commit, so revocation or key retirement either serializes after an already-authorized write or causes the write to fail closed. Audit events contain normalized codes and scope IDs, never compact credentials, signatures, or private key material.

For operator key registration and issuance commands, migration-role requirements,
key handling, and the one-use credential lifecycle, see
[`runtime-node-identity-operations.md`](runtime-node-identity-operations.md).

The PostgreSQL gateway keeps ordinary queries on `DATABASE_URL` and opens a
separate application-role connection for revocation `LISTEN`. Configure
`DATABASE_URL_UNPOOLED` with the direct endpoint, the same application principal,
and the same database. Neon transaction pooling does not support session
notifications ([Neon connection pooling](https://neon.com/docs/connect/connection-pooling));
a pooled Neon URL without the direct URL fails configuration before the gateway
opens its store. A direct `DATABASE_URL` remains sufficient without the extra
variable. Generic transaction poolers also require an explicitly configured
direct URL; the gateway cannot infer their connection mode from the hostname.
Migration and administration credentials must not be used for notifications.
Programmatic hosts provide `store.notificationUrl` with the same constraints.
Shutdown and failed startup close both owned connections.

`RUNTIME_NODE_IDENTITY_ISSUER_PUBLIC_KEYS_JSON` is a bounded JSON object mapping operator key IDs to Ed25519 public-key PEM. The gateway rejects private PEM, unknown keys, missing registry rows, mismatched stored claims, retired device keys, and any database/notification failure that would confer authority. The synthetic authority in the private Runtime Gateway app exists only for standalone conformance tests and is never a production fallback. Local execution continues to use direct runtime transport and does not start a Runtime Gateway.

## WebSocket lifecycle and horizontal scale

The dedicated Runtime Gateway upgrade endpoint is `/runtime-gateway/v1/connect`. Its upgrade authenticator must return an already verified `RuntimeNodeChannel`; ordinary Control API handlers and user sessions are not involved. The Bun server adapter configures native maximum payload, backpressure, and idle limits, while the lifecycle applies the same bounds before JSON parsing. Invalid hello, scope, version, frame, or ownership state closes with a bounded normalized reason.

An authenticated socket becomes active only after its hello negotiates a supported protocol version and claims a monotonically increasing channel generation through `RuntimeNodeCoordinationPort`. The port is replaceable by shared coordination such as a compare-and-set Redis implementation. A higher generation atomically claims the node and notifies the old gateway instance to close its stale socket; an equal or lower generation fails closed. Correctness therefore does not require load-balancer stickiness, and reconnecting to another instance does not move or delete command/result state. Durable delivery remains outside gateway process memory and is connected to this lifecycle through the M5 command ledger.

Heartbeats refresh shared ownership and publish normalized online/degraded/offline changes through `RuntimeNodeReachabilityPublisher`. A stale heartbeat degrades the node; the idle deadline releases ownership and marks it offline. Graceful shutdown stops admission, closes and releases each active channel, and then stops the native server. Metrics record per-instance active nodes, reconnects, heartbeat lag, negotiated protocol versions, and normalized disconnect reasons.

## Durable command delivery

`composeRuntimeGateway` constructs the runtime command stack only when its
explicit `runtime` options are supplied; `start` forwards those options. The
composition owns its command store but does not own the injected host ports.
Inventory remains a separate optional host handler and fails closed when absent.
SQLite coordination is single-instance; the PostgreSQL mode uses durable channel
ownership and the operator-issued RuntimeNode identity registry. Production
PostgreSQL composition rejects injected upgrade authenticators and requires
explicit public issuer trust. Neither mode provides a live product enrollment
API, outbound runtime-agent package, sandbox host, or scoped Artifact upload
credentials.

Runtime-command composition is opt-in. A host must explicitly provide execution/event effects, reconnect validation and retained-outcome application, execution reconciliation, quarantine, and a scoped Artifact verifier. The verifier must establish that the authenticated command is allowed to reference the supplied Artifact; schema validity alone is not artifact ownership. Missing or malformed host ports fail before the gateway opens its store. Context-only composition keeps runtime frames fail-closed. Production PostgreSQL identity validation authenticates the channel, but does not supply live product enrollment or a complete executable-host deployment.

For successful runtime-result Artifacts, composition also verifies the configured
ObjectStore independently of the host authorization hook. The trusted command's
attempt determines the stable Artifact ID and `runtime-results` key; peer-supplied
locators and arbitrary storage paths are not used. HEAD and GET metadata, bounded
size, media type, reference digest and actual body digest must agree. A permissive
host hook cannot bypass these storage checks. This is not upload credential
issuance or authorization for a node to write an arbitrary attempt's key.

When enabled, the gateway writes every runtime command to the configured SQLite or PostgreSQL `runtime_commands` ledger before sending it. The record retains the semantic command, execution, attempt, node, connection, scope, payload hash, expiry, delivery generations and sequences, ACK, result reference, and compare-and-set version. Reconnect and gateway restart query this ledger and redeliver the same command ID; a new ID denotes a new semantic attempt. Queue age, ACK latency, redelivery, and expiry are recorded as gateway metrics.

ACKs must match the latest dispatched channel generation and sequence. Previously recorded RuntimeNode results may come from an earlier generation after a lost connection, but they must match the command node, workspace, and payload hash. Duplicate ACKs or results return the persisted outcome only when their references and dispositions match; ambiguity and command-ID hash reuse fail closed. Commands are marked expired before send and are never revived on reconnect.

The RuntimeNode owns a separate bounded local result ledger for duplicate-effect protection. The reference implementation returns its recorded result on redelivery and fails closed at capacity rather than evicting an entry that could allow an old command to execute twice. Production nodes must persist this bounded ledger across their own restart according to their retention policy.

## Normalized event ingestion

Authenticated progress, result, and command-bound error frames are correlated through the durable command to the exact execution, attempt, node, workspace, and RuntimeConnection. The gateway separately verifies the active source channel, frame generation and sequence, payload hash, inline payload bound, and Artifact reference. Rejected frames are quarantined by normalized reason and digest without retaining their raw payload.

After asynchronous normalization or Artifact/policy verification, ingestion reads
the command/execution/attempt binding and channel authority again before applying
effects. Local channel authority checks the live authenticated connection,
credential expiry and durable revocation, then rechecks coordinated ownership;
it does not wait for the next sweep or treat ownership metadata as credential
authority. Registry or coordination outages fail closed. These checks do not
make independently administered credential revocation and effect persistence
one distributed transaction.

## Runtime inventory synchronization

Protocol v1.2 adds additive RuntimeNode inventory deltas and explicit adapter-version correlation. Older v1.0 and v1.1 inventory frames remain full snapshots. Every authenticated inventory report is bound again to its node, workspace, channel generation, and negotiated protocol before a runtime-specific normalizer may translate it into the M4 RuntimeConnection and health contracts.

The durable per-node checkpoint records only the accepted version, canonical digest, observation time, and stable opaque runtime references. Exact replays are idempotent, version reuse with different content fails closed, stale reports cannot revive disappeared runtimes, and deltas must name the exact preceding version. Full snapshots make omitted runtimes unavailable; deltas do so only for explicit removals. A bounded disappearance TTL then moves still-missing connections to expired, while RuntimeConnection rows and historical execution references are retained.

RuntimeNode reachability remains separate from individual runtime health. Inventory ingestion calls the ordinary M4 health and availability-change ports, so Adea read models observe Control Plane API/event changes rather than gateway-specific client pushes. Context-provider inventory remains a distinct protocol family and is not registered as an executable RuntimeConnection.

## Local managed Pi adapter

`@control-plane/managed-pi-adapter` includes a Runtime Gateway client and a Control Plane-owned reference `ManagedPiDriver`. The client sends the adapter's normalized, pinned execution configuration through `runtime.execute` and maps status, cancellation, input, and approval to their provider-neutral runtime operations. Inventory supplies the driver, harness, protocol, capability, and health provenance used by adapter eligibility checks.

The wire configuration contains a synthetic `LocalProjectGrant` reference, never an absolute path or reusable Pi credential. The node-side driver owns grant resolution, local installation, process, filesystem, and credential access. Offline or revoked nodes, missing or revoked grants, and incompatible Pi versions fail before execution delivery.

The reference transport uses the M5 RuntimeNode duplicate-effect ledger. Reconnect redelivers the same command ID and payload hash and replays the recorded exchange without re-executing Pi. Deterministic fixtures cover progress, output, tool interaction, usage, Artifact emission, completion, cancellation, crash, timeout, and ambiguous outcomes without Adea or production node dependencies.

## Reconnect reconciliation

Protocol v1.3 lets the RuntimeNode hello carry a bounded, unique set of retained command outcomes alongside its last acknowledged transport sequence. The gateway correlates every retained outcome to the durable command's node, workspace, command ID, and payload hash. Cloud-terminal results are reused; node-terminal results flow through the same normalized terminal ingestion path; active retained work is reconciled with M3 execution state.

Protocol v1.4 adds an explicit `runtime.status` command for adapter reconciliation. Status commands require the normalized `stream.events` capability and remain bound to the same node, workspace, runtime connection, execution, attempt, and payload identity as execution controls. Bounded token-limit fields are allowed as policy data, while credential-bearing token aliases remain prohibited at every payload depth.

Protocol v1.5 adds `runtime.session` for independently capability-gated external-session operations.
Each command must require at least one normalized `session.*` capability and remains scoped to the
same node, workspace, RuntimeConnection, execution, attempt, command, and payload identities. Native
session identifiers and local paths are resolved by the node-side driver and never cross the gateway.

Protocol v1.6 adds optional `capabilityTtlMs` to inventory driver descriptors.
The integer range is 1–60,000 milliseconds; omission preserves the 60-second
default. Senders may emit this field only after negotiating v1.6 or later and
must omit it for older peers. The default runtime inventory normalizer preserves
a shorter advertised TTL when creating the capability snapshot; the health
policy can further shorten but never extend that snapshot's expiry. This does
not change heartbeat timing or make provider inventory a RuntimeConnection.

Queued commands and commands whose prior sequence is provably beyond the node's acknowledged watermark may be redelivered with the same semantic command ID. An acknowledged command missing from the retained ledger, an explicit unknown outcome, an unknown command, or a state conflict is never guessed: M3 reconciliation is invoked and manual-intervention telemetry is emitted. Expired commands are expired without send, while revoked nodes or grants and changed/incompatible runtime capabilities prevent resume. Recovery duration, redelivery, unknown outcome, and manual-intervention metrics describe the reconnect path.

Concrete runtime adapters implement `RuntimeAdapterEventNormalizer`; provider or harness event types never enter execution state or the `ExecutionEvent` log. Normalized progress becomes bounded attempt, interaction, usage, or Artifact events. A stable event ID and the PostgreSQL `runtime_event_receipts` inbox make duplicate delivery identifiable across gateway restarts, reject conflicting reuse, and safely classify out-of-order progress.

Terminal state, result reference or normalized failure, the required execution event, and its ingestion receipt commit through one effect sink. The first committed terminal outcome wins, so completion before cancellation remains complete and cancellation before a late result remains cancelled. Runtime cancellation, input, and approval use ordinary durable runtime commands; the gateway does not dispatch a new control command after the execution or attempt is already terminal.

## Compatibility and deprecation

Protocol v1.7 adds optional `terminalUsage` to result envelopes for succeeded,
failed and cancelled executions. It uses the Runtime SDK's validated token,
duration and optional reported cost/accounting contract. Senders must negotiate
v1.7 before emitting the field; older strict parsers cannot read it. The Hosted
terminal bridge rejects known measured usage on an older protocol rather than
silently dropping it. Upgrade both sides before activating this path. Legacy
results without measurements remain valid and mean unknown usage, not zero.

The gateway writes reported usage with command/node/connection/channel
attribution into the winning terminal event; the Cloud/Hosted waiter verifies
that durable binding before returning it. Adapter-normalized payloads cannot
override those reserved fields. Neither an authenticated channel nor reported
`accounting.sourceId` authorizes a charge. Funding authority, per-attempt
reservations and financial settlement are separate requirements. The current
Hosted terminal bridge still requires production startup/channel wiring; a
fixture-tested bridge is not a live deployment certification.

Peers negotiate the highest common major version and the lower supported minor within that major. No common major fails negotiation. Additive fields and envelope variants require a minor version; changed meanings, required-field removal, or incompatible validation require a new major. Deprecation must name the affected version and timestamp; an optional sunset must be later than deprecation and should name a supported replacement. A command already past expiry is never made valid by protocol negotiation or reconnect.

Protocol v1.1 adds runtime cancellation commands and optional command payload hashes on error envelopes. A v1.0 peer remains schema-compatible, but the gateway requires v1.1 plus a matching payload hash before ingesting a command-bound error or dispatching cancellation, input, or approval control commands.
