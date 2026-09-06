# Runtime Gateway protocol

`@control-plane/runtime-gateway-protocol` is the provider-neutral, versioned wire contract between the cloud Runtime Gateway and outbound RuntimeNode connections. It is distinct from the product HTTP/SSE API and never carries user-session or reusable device/provider credentials.

## Envelope and delivery rules

Every envelope identifies its schema and negotiated protocol version, node, workspace, channel generation, sequence, trace, and send time. Commands additionally require a stable command ID, idempotency key, content digest, issue/expiry timestamps, driver family/version, capability requirements, and semantic command family. Transport is at least once: redelivery reuses the same command ID and payload hash, while a hash mismatch fails closed.

Payloads are either bounded adapter-owned JSON or a content-addressed Artifact reference. Core validation rejects native provider command types and selectors for arbitrary endpoints, local paths, executables, databases, projects, source scopes, or reusable credentials. Context-provider status/read operations are optional; writes require a separate authorization reference. Inventory may advertise zero providers without affecting runtime negotiation.

The checked-in JSON Schema and golden/malformed JSON fixtures under `packages/runtime-gateway-protocol` are language-neutral. The TypeScript package depends only on Zod and includes a deterministic reference RuntimeNode plus a reusable conformance runner; consumers do not need Control Plane server, domain, or database packages.

## Channel authentication

The WebSocket upgrade uses a separate short-lived `runtime_node` credential and a proof signed by the registered device key. The public package owns only normalized credential claims, the bounded authentication-attempt schema, and the replaceable `RuntimeNodeIdentityValidationPort`; a consuming application remains responsible for node registration, pairing, key custody, and credential issuance. User-session, provider, and reusable device credentials are not command envelopes.

The gateway checks the exact issuer, gateway audience, node, workspace, revocation version, expiry, proof challenge, and monotonically increasing channel generation. A credential ID may establish only one channel. Re-authentication requires a newly issued credential and a higher channel generation; it replaces the prior logical channel. Revocation notifications invalidate the active channel immediately, and command authorization rechecks the revocation port before allowing another command. Audit events contain normalized codes and scope IDs, never compact credentials, signatures, or private key material.

The synthetic authority in the private Runtime Gateway app exists only for standalone conformance tests. Its generated Ed25519 private keys model RuntimeNode-owned test material and are never passed to `RuntimeNodeChannelAuthenticator`; production deployments replace its validation port with the consuming application's registry and verifier.

## WebSocket lifecycle and horizontal scale

The dedicated Runtime Gateway upgrade endpoint is `/runtime-gateway/v1/connect`. Its upgrade authenticator must return an already verified `RuntimeNodeChannel`; ordinary Control API handlers and user sessions are not involved. The Bun server adapter configures native maximum payload, backpressure, and idle limits, while the lifecycle applies the same bounds before JSON parsing. Invalid hello, scope, version, frame, or ownership state closes with a bounded normalized reason.

An authenticated socket becomes active only after its hello negotiates a supported protocol version and claims a monotonically increasing channel generation through `RuntimeNodeCoordinationPort`. The port is replaceable by shared coordination such as a compare-and-set Redis implementation. A higher generation atomically claims the node and notifies the old gateway instance to close its stale socket; an equal or lower generation fails closed. Correctness therefore does not require load-balancer stickiness, and reconnecting to another instance does not move or delete command/result state. Durable delivery remains outside gateway process memory and is connected to this lifecycle through the M5 command ledger.

Heartbeats refresh shared ownership and publish normalized online/degraded/offline changes through `RuntimeNodeReachabilityPublisher`. A stale heartbeat degrades the node; the idle deadline releases ownership and marks it offline. Graceful shutdown stops admission, closes and releases each active channel, and then stops the native server. Metrics record per-instance active nodes, reconnects, heartbeat lag, negotiated protocol versions, and normalized disconnect reasons.

## Durable command delivery

The gateway writes every runtime command to the PostgreSQL `runtime_commands` ledger before sending it. The record retains the semantic command, execution, attempt, node, connection, scope, payload hash, expiry, delivery generations and sequences, ACK, result reference, and compare-and-set version. Reconnect and gateway restart query this ledger and redeliver the same command ID; a new ID denotes a new semantic attempt. Queue age, ACK latency, redelivery, and expiry are recorded as gateway metrics.

ACKs must match the latest dispatched channel generation and sequence. Previously recorded RuntimeNode results may come from an earlier generation after a lost connection, but they must match the command node, workspace, and payload hash. Duplicate ACKs or results return the persisted outcome only when their references and dispositions match; ambiguity and command-ID hash reuse fail closed. Commands are marked expired before send and are never revived on reconnect.

The RuntimeNode owns a separate bounded local result ledger for duplicate-effect protection. The reference implementation returns its recorded result on redelivery and fails closed at capacity rather than evicting an entry that could allow an old command to execute twice. Production nodes must persist this bounded ledger across their own restart according to their retention policy.

## Normalized event ingestion

Authenticated progress, result, and command-bound error frames are correlated through the durable command to the exact execution, attempt, node, workspace, and RuntimeConnection. The gateway separately verifies the active source channel, frame generation and sequence, payload hash, inline payload bound, and Artifact reference. Rejected frames are quarantined by normalized reason and digest without retaining their raw payload.

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

Queued commands and commands whose prior sequence is provably beyond the node's acknowledged watermark may be redelivered with the same semantic command ID. An acknowledged command missing from the retained ledger, an explicit unknown outcome, an unknown command, or a state conflict is never guessed: M3 reconciliation is invoked and manual-intervention telemetry is emitted. Expired commands are expired without send, while revoked nodes or grants and changed/incompatible runtime capabilities prevent resume. Recovery duration, redelivery, unknown outcome, and manual-intervention metrics describe the reconnect path.

Concrete runtime adapters implement `RuntimeAdapterEventNormalizer`; provider or harness event types never enter execution state or the `ExecutionEvent` log. Normalized progress becomes bounded attempt, interaction, usage, or Artifact events. A stable event ID and the PostgreSQL `runtime_event_receipts` inbox make duplicate delivery identifiable across gateway restarts, reject conflicting reuse, and safely classify out-of-order progress.

Terminal state, result reference or normalized failure, the required execution event, and its ingestion receipt commit through one effect sink. The first committed terminal outcome wins, so completion before cancellation remains complete and cancellation before a late result remains cancelled. Runtime cancellation, input, and approval use ordinary durable runtime commands; the gateway does not dispatch a new control command after the execution or attempt is already terminal.

## Compatibility and deprecation

Peers negotiate the highest common major version and the lower supported minor within that major. No common major fails negotiation. Additive fields and envelope variants require a minor version; changed meanings, required-field removal, or incompatible validation require a new major. Deprecation must name the affected version and timestamp; an optional sunset must be later than deprecation and should name a supported replacement. A command already past expiry is never made valid by protocol negotiation or reconnect.

Protocol v1.1 adds runtime cancellation commands and optional command payload hashes on error envelopes. A v1.0 peer remains schema-compatible, but the gateway requires v1.1 plus a matching payload hash before ingesting a command-bound error or dispatching cancellation, input, or approval control commands.
