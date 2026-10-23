# ACP runtime adapter

`@control-plane/acp-adapter` is the external-harness boundary for Agent Client Protocol (ACP)
version 2. It translates the stable `RuntimeAdapter` contract into ACP requests and normalizes ACP
updates and retained state back into Control Plane models. The domain, contracts, execution, and
Runtime SDK packages do not import ACP types or depend on an ACP implementation.

## Negotiation and eligibility

The adapter initializes with ACP protocol version 2 and records the exact version and agent metadata
returned by the peer. An unsupported protocol major, missing session surface, or disconnected
transport is reported as unavailable. Required Runtime capabilities must be present at their minimum
support level before execution starts; missing optional capabilities remain explicit in the capability
evaluation and never become inferred behavior.

ACP v2's baseline session surface maps to normalized create, list, resume, close, prompt, progress,
approval, cancellation, and tool-call capabilities. Resume omits `replayFrom` and therefore does not
imply history replay or loading. Normalized history and load become available only when the transport
driver can explicitly capture ACP replay updates; partial and unavailable replay remain classified in
the result. Unknown additive ACP capability fields are ignored so compatible peers can extend the
protocol without changing the normalized contract.

## Translation and ownership

Start creates an ACP-native session and sends a bounded textual reference to the immutable execution
plan, attempt, digest, and authorized context package. The native session ID remains private to the
adapter; callers receive the supplied opaque external-session mapping. ACP updates become ordered
status, output, interaction, usage, and Artifact progress. Permission and elicitation responses,
cancellation, retained status, and cleanup are routed back through their native ACP identifiers.

The adapter does not authenticate the native harness, install or configure it, alter its MCP servers,
select its working directory, inject credentials, or assume ownership of its sessions. Native auth
methods returned during initialization are intentionally retained at the protocol edge and are not
exposed through `RuntimeAdapter`.

## Local Runtime Gateway driver

Local ACP requests use Runtime Gateway protocol 1.5 and its `runtime.session` operation. The
gateway client translates discovery, initialization, execution, interaction responses,
cancellation, status, and retained-session operations into versioned commands for a node-side ACP
driver. Driver inventory supplies the negotiated driver and harness versions plus the exact
normalized capabilities used for eligibility; a missing required capability therefore blocks start
before the ACP harness receives an execution request.

The node-side driver resolves opaque `nses_` references to native session IDs and requires a
synthetic `grant:` reference for execution. Neither native IDs nor absolute project paths cross the
gateway boundary. Command identity, payload hashes, attempt IDs, and the M5 reference node's replay
ledger provide correlation and duplicate-effect protection across disconnect and reconnect. A
missing, incompatible, or disappeared driver fails closed, while a disconnected retained attempt
reconciles as unknown until connectivity returns.

The in-repository reference driver runs only a disposable ACP transport fixture. It does not launch
Adea or take ownership of native authentication, configuration, MCP setup, or session files.

## Secure remote device route

`SecureAcpRemoteTransport` (controller) and `SecureAcpDeviceEndpoint` (device) implement the
authenticated, encrypted ACP route between the Control Plane and a device-side executor. Commands
are HPKE-sealed (X25519/HKDF-SHA256/AES-128-GCM) to the registered device recipient key with the
cleartext header bound as associated data and signed by the controller's Ed25519 key; replies are
sealed to a per-command ephemeral return key and signed by the device identity key. The shared route
record is a public-key-only strict schema, so credential or private-key fields cannot enter it.
Inventory has two wire modes. In the default mode the device signs each inventory reply over a
per-request nonce, and the controller verifies the signature, route and nonce within a 60-second
freshness bound. In `channel-authenticated` mode the wire supplies an already-pushed inventory that the
authenticated gateway channel vouches for: it is not device-signed and no request nonce is checked, the
controller checks only node/workspace identity, a 60-second freshness bound, and that the reply's channel
generation equals the generation the same wire reports. That mode therefore trusts the channel and the
wire object that selects it, and is not a replay defence on its own (see incomplete milestones).

Authority checks are current-authority: the route fence (revocation, trust-record staleness, finite
clock) and the command's window/channel-generation gates are evaluated before decryption and
re-evaluated after **every** await on the effect and publication paths — after send and after reply
opening at the controller, and after each storage read, the ledger claim, execution, and reply
sealing at the device — with every reply publication (fresh, sealed, or cached) fenced against the
persisted fence, and the persisted fence enforced atomically inside the durable claim transaction.
A revocation or superseded generation durable before a claim refuses that command atomically, and any
revocation, superseded generation, expired window, or broken clock in force at the final read refuses
the reply (see the response authorization boundary below). A command whose effect may have run is never
reported as undelivered: once a reply is in hand the controller ignores a wire that has since gone
offline and maps a window that closed afterwards to `response_unknown`, and the device reports a
transient publication refusal (expired window, superseded generation) after an exchange was recorded
as `response_unknown` rather than as the pre-effect denial. Only revocation is reported as itself.
The same holds for a delivery whose window is not open or whose generation is superseded: before
replying `command_expired`, `command_not_yet_valid` or `stale_channel_generation` the device looks
the command id up in the ledger, because an earlier window or generation may have run it. A recorded exchange is reported as `response_unknown`, a claim without an outcome
or a compacted record as `outcome_uncertain`, and only an id with no record gets `command_expired`;
no sealed output is released for the closed window. Every accepted delivery also moves the persisted
generation fence, including one answered from the ledger or coalesced onto an in-flight command
(`advanceGeneration`), so a distinct command on an older generation is refused afterwards. Only a
delivery of the same semantic identity advances it: a different command reusing a recorded id is a
`command_conflict` and mutates no fence. An uncertain outcome (`outcome_uncertain`, `response_unknown`)
is never overwritten by a window or generation fence that trips afterwards, including after an
executor throw: only revocation is reported as itself.
`response_unknown` is retryable on the same command identity, whose recorded outcome the device
replays. Another endpoint over the shared store may record the same command between this delivery's
ledger read and its fence or claim (a pending winner can also abandon and be replaced while the
lost-claim path waits), so every refusal that follows a ledger read or a claim (`stale_channel_generation`,
`command_expired`, `command_not_yet_valid`, and also `clock_invalid`, `device_stale`,
`state_unavailable`) reads the ledger again before it is signed, and a record already read survives a failed
re-read. A revocation is still reported as itself. The same lookup covers `clock_invalid` and `device_stale`
refused before the plaintext is opened. Unavailable evidence is its own outcome: when the ledger read or
the claim fails (and no record was read), the answer is `state_unavailable` (retryable), and a window or
generation fence that trips before the reply is published never turns it into `command_expired` or
`stale_channel_generation`. The outcome/fence matrix is therefore: recorded effect `response_unknown`,
pending effect `outcome_uncertain`, unavailable evidence `state_unavailable` (each kept against any later
fence, never re-running an effect), and only a proven no-effect denial yields to the fence reason;
revocation is reported as itself over all of them. The result:
a recorded exchange is `response_unknown`, a claim without an outcome `outcome_uncertain`, and only
a command with no record gets the plain refusal (a conflicting identity and a revocation are
unchanged). A duplicate of the same command at a newer generation that coalesced onto a pipeline
which was superseded before it dispatched anything (claim abandoned or never made) is admitted
again on its own pipeline, at most twice: it claims afresh and runs the effect once, or replays the
record another delivery left; an uncertain or recorded outcome is never re-run. After a successful claim, a fresh durable
fence read immediately before dispatch refuses the command before the executor is called (see the
pre-dispatch boundary below). A non-finite clock or malformed window fails
closed. Unauthenticated input receives no signed reply, so an intermediary cannot harvest a device
signature over copyable header fields. Every denial carries an explicit `fallback: 'none'`.

Device fence state is durable through `AcpRemoteDeviceStateStore`:
`PersistenceProviderAcpRemoteDeviceStateStore` persists the highest accepted channel generation, the
first applied revocation, and the replay ledger (create-if-absent claim, then recorded outcome) over
the Local/Hosted `PersistenceProvider`, while the in-memory store is a test/default seam that is not
durable across restart. After a restart a recorded command replays its recorded outcome without
re-executing, an older channel generation stays denied, a revocation stays terminal, and a claim
whose effect never completed denies as `outcome_uncertain` instead of being blindly retried. A stale
generation or an expired delivery window is denied even when a recorded outcome exists; only a
current window under current authority may recover it. Fence and ledger keys derive from the
authenticated route identity through `acpRemoteDeviceStateScope`, so two routes sharing one store
never observe each other's revocation, generation, or recorded effects, and `claim` re-evaluates the
persisted fence inside the same transaction that would create the ledger entry — an endpoint that
loaded its mirror once still fails closed on a revocation or supersession applied elsewhere: claims
are decided inside the durable transaction, and replay, dispatch, publication, and inventory re-read
the persisted fence before deciding.

**Response authorization boundary:** a device reply (exchange, cached replay, or signed denial) is
authorized by the last durable fence read that completes before the endpoint returns its bytes to the
caller. For a fresh outcome that read follows sealing; for a cached replay it precedes returning the
cached bytes; inventory replies follow the same rule. A revocation, higher channel generation, or
expired window that is durable before that read refuses the reply, and the refusal is sealed in place
of the bytes. The boundary is a point-in-time read, not a lock: no durable transaction or lock is held
across sealing or transmission, and the endpoint makes no claim about delivery once bytes leave it, so
a revocation committed afterwards is not reflected in bytes already returned. A refused publication
never repeats the effect; the outcome recorded at execution stays durable.

**Pre-dispatch boundary:** after a successful claim, the last durable fence read before the executor is
called decides whether the effect runs. A denial it observes is not dispatched. Revocation is terminal and is recorded as the
command's outcome. Every other pre-dispatch refusal (expiry, supersession, stale trust record, broken clock) is
specific to that delivery, so the claim is released (`abandonClaim`) instead of being stored: a later
delivery of the same command id with a fresh window and current generation runs once. A store failure at that
read also dispatches nothing and releases the claim when the store can; if the release itself fails the
claim stays unrecorded, so a later delivery of the same identity reads `outcome_uncertain` and nothing
re-runs. A
retry on the same return key receives the byte-identical reply it already got. The read is point-in-time.
No await separates its completion from the dispatch call, but a commit landing after its snapshot is not
observed by it. This does not make the executor's side effects or any network delivery atomic with the
read, and a revocation committed after the read cannot stop a dispatch already in progress.

**Ledger retention:** duplicate protection outlives the delivery window. A controller may retry the
same command id with a fresh window at any time, and that retry passes the window fence, so a claim is
never deleted. `capacity` (default 1,024 per route) bounds only the live entries. When a route is at
capacity, the claim transaction first compacts entries whose window ended more than the clock-skew
bound ago, moving them to a compact record in a separate namespace
(`acp-remote-device-ledger-compacted`), then re-checks the bound. A compacted record keeps the
command's identity and its pending or recorded state: a pending claim stays pending and replays as
`outcome_uncertain`, a recorded denial is kept, and a recorded exchange, whose sealed output is no
longer retained, becomes `outcome_uncertain`. A same-command retry therefore never executes again, and
a different payload under a compacted id is `command_conflict`. Entries written before retention
existed carry no window and are never compacted. While every entry is still inside its window a new
command is refused `replay_ledger_full`. Compact records are kept for the life of the route (one small
record per command); a retention horizon for them needs a controller-side command-id epoch and is an
open design decision (see incomplete milestones).

**Device key rotation:** device state is scoped by the device key id. Re-enrolling the device with a new
signing key id starts a fresh fence and ledger; a still-valid captured command is only safe because the
route's encryption key, controller key and short command window bound it. Rotation procedure and any
carry-over of the old fence are not defined yet (see incomplete milestones).

**Production construction is wired (no documented-gap substitute):**
`createPersistentSecureAcpDeviceEndpoint` always builds the scoped
`PersistenceProviderAcpRemoteDeviceStateStore(provider, acpRemoteDeviceStateScope(route))`, and the
Local composition's `secureAcpRemoteRoute` option constructs the endpoint over the composition's
own `SqlitePersistenceProvider` (`LocalControlPlaneComposition.secureAcpDevice`), with passthrough
from `start()` via `compositionOptions`. The route record (public keys, ids, validity) stays an
explicit host-supplied composition input — no ambient credential or key material — and the
in-memory default remains test-only.

**Controller enrollment authority:** controller construction has a separate
`createEnrolledSecureAcpRemoteTransport` factory. It requires the current controller enrollment
authority (`AcpRemoteControllerAuthorityPort`) and binds each durable check to the route scope,
controller key id, and public key before inventory requests, after key generation and sealing,
before commands leave, after wire replies, and before publishing decrypted replies. Connection-state
reporting uses the synchronous cache only after a durable check passes; it stays offline before that
check and after a rejected check or observed wire disconnect. Enrolled transports use
`revokeCurrent()` to recheck authority before signing; the synchronous `revoke()` helper is only for
isolated transport tests. The raw constructor remains available for isolated transport tests. No
concrete enrolled-controller signer source implements the authority port in this repository yet, so
this adds the boundary and does not close #1023.

**Production wire boundary (the wire and the device agent now exist; the live exchange stays open
for #1023):** `createGatewayOwnedAcpRemoteWire` (`packages/acp-adapter/src/acp-remote-wire.ts`) is
the first production `AcpRemoteWire`. It carries ONE opaque sealed command through the runtime
gateway as a `runtime.acp-remote-sealed` carrier command whose payload holds the sealed blob under
one opaque key, so the gateway relays ciphertext it cannot read, and it brings the device's opaque
sealed reply back. The device side is `handleAcpRemoteCarrierCommand`
(`packages/acp-adapter/src/acp-remote-device-agent.ts`): it checks that the carrier did not redirect
the sealed command to another route, runs it, and persists the sealed reply as the carrier command's
single per-command result artifact (`runtime-results/<attemptId>/result.json`), so the gateway's
existing `RuntimeCommandArtifactVerifier` verifies it with no protocol change. The gateway side is
`createAcpRemoteGatewayChannel` (`apps/runtime-gateway/src/acp-remote-gateway-channel.ts`), which
rides the gateway's ordinary durable command path and reads that reply artifact back. The contract
between the two sides is declared once, in `@control-plane/runtime-gateway-protocol`, so the compiler
checks both ends.

What remains OPEN: no product composition binds the gateway channel to the wire, because the
repository still holds no production runtime-node WebSocket client for a device to answer over; the
live acceptance of an authenticated controller-to-device exchange is not proven (the executable
evidence is offline and synthetic); and no hosted composition constructs a device endpoint. The
offline evidence is `packages/acp-adapter/src/acp-remote-wire.test.mjs` and
`apps/runtime-gateway/src/acp-remote-gateway-channel.test.mjs`. The reroute fence itself is
unchanged: an offline or revoked device is a typed local denial with `fallback: 'none'`, never a
substitute location.

**SQLite credential-fence contract:** SQLite runtime-command settlement now requires an authority
that validates credential id and version, the command's node and workspace, and current revocation
state through the same `PersistenceTransaction` as the ACK/result write. A plain `isRevoked` call
cannot authorize a SQLite settlement; if the transaction-bound authority is missing, validation
fails closed. SQLite serializes writes through that provider, so an invalidation using the same
provider orders before the check or after the fenced update. The same transaction-bound authority now fences
`SqliteRuntimeEventEffectSink` progress and terminal effects: every effect, replays included, validates
the delivering channel's credential fence against the stored command's node and workspace before any
execution, attempt or receipt write, and a missing command, malformed fence or absent authority fails
closed (parity with `PostgresRuntimeEventEffectSink`). The Local all-in-one currently has no production
fenced settlement caller; its authority seam is for future callers. Context-command ACK, result and error
settlement on SQLite (`SqliteContextCommandRepository`) and the reconnect `hello` retained-outcome
applier are not credential-fenced yet (see incomplete milestones). Hosted PostgreSQL
settlements continue to use the PostgreSQL identity authority and fence path, not the SQLite
transaction hook.

**Hosted PostgreSQL durable state:** the same `PersistenceProvider` contract is qualified, in tests
only, through `PostgresPersistenceProvider`; no Hosted composition constructs it or a device endpoint
over it yet, and the only production device endpoint is the Local/SQLite one
(`packages/profile-portability/src/postgres-persistence-provider.ts`) over the new
`persistence_records` table (drizzle migration `0072_persistence_records`; the canonical migration
chain, applied by the migration role, owns DDL — the provider verifies presence and never creates
tables). The device fence/ledger store is proven on real PostgreSQL — atomic claims, revoked and
superseded rejection without writes, restart persistence, concurrent same-key races, and per-route
namespacing — in `tests/acp-remote-device-postgres.integration.test.mjs` against a disposable
isolated database.

Neither layer can produce an implicit cloud reroute: an offline or revoked route denies with
`fallback: 'none'` and the transport has no alternate route, and at attempt selection
`RuntimeDiscoveryAttemptRouter` never replaces a local runtime that the plan could have used but that
is not live-eligible (offline, stale, reconnecting, unknown health, revoked or missing grant, revoked
compatibility, no node) with a remote one (`WORKFLOW_RUNTIME_LOCAL_UNAVAILABLE_NO_FALLBACK`). While such
a local runtime exists the choice is restricted to local candidates, so a healthy local runtime still
wins and no local candidate is a typed denial. A local runtime that could never have served the attempt
(disallowed family or location, missing capability, unpinned harness, denied entitlement, `incompatible`
or `capability_missing` compatibility) does not block a remote one.

Evidence: `packages/acp-adapter/src/acp-remote-fence.test.mjs` (route schema, fence decisions,
finite-clock guards, HPKE/signature binding), `packages/acp-adapter/src/acp-remote-transport.test.mjs`
(parked-async revocation/abort regressions, parked storage window/generation regressions,
revocation at execution/sealing/response-opening boundaries, authenticated and encrypted runs,
replay/conflict/generation proofs, edge fences), `packages/acp-adapter/src/acp-remote-delivery-fences.test.mjs` (delivered-not-undelivered, withheld
exchange as `response_unknown`, claim release and retry, ledger capacity recovery),
`tests/acp-remote-device-retention.test.mjs` (retention and `abandonClaim` on the in-memory and SQLite
stores, including same-command retries after compaction), `packages/acp-adapter/src/acp-remote-response-boundary.test.mjs`
(the response authorization boundary: peer revocation before the final read and while sealing, cached
replay after revocation, identity conflict; the pre-dispatch boundary: peer revocation after the claim,
a positive control, and a store failure at the read),
`apps/local-control-plane/src/acp-remote-device-restart.test.mjs` (restart proofs through the real
SQLite persistence composition using disposable per-test databases), and
`apps/local-control-plane/src/acp-remote-device-fence.test.mjs` (two endpoints over one shared
store, atomic claim rejection without writes, and per-route fence/ledger namespacing),
`packages/acp-adapter/src/acp-remote-composition.test.mjs` and
`apps/local-control-plane/src/acp-remote-secure-route.test.mjs` (persistent factory and production
Local composition construction, including a revocation that survives composition restart), and
`tests/acp-remote-device-postgres.integration.test.mjs` (Hosted PostgreSQL durable-state
qualification over an isolated disposable database).

## External session references

When configured with an `ExternalSessionRegistry`, native list/create/resume/close observations create
or update workspace-scoped references. The registry stores a supplied opaque native-session token,
not the ACP session ID, along with runtime-connection provenance, a bounded capability snapshot,
freshness, and safe display metadata. A separate resolver at the driver boundary converts that token
back to a native identifier only for an authorized operation.

Every resume, load, close, and history request is checked against the current RuntimeConnection and
node state before native dispatch. Offline, stale, missing-runtime, removed, revoked, capability-change,
authorization, and unresolvable-reference outcomes fail explicitly. Listing reconciles sessions that
the native harness removed while preserving their Control Plane references. Native renames are observed
without taking ownership; concurrent native use always remains allowed. Existing public SDK list/get
operations consume the projected normalized read model and never expose either native identifier.

## Native route qualification and pre-effect controls

A native executor route (Codex, OpenCode or Claude) may claim capabilities only when trusted
deployment evidence and a live observation agree on the exact route identity. The adapter's
`NativeRouteGate` turns that agreement into the three decisions a runtime must make, and it is
fail-closed: an unqualified, expired, revoked, drifted, conflicting, offline, unauthorized or
wrongly-authenticated route yields no capability, no usage claim and no governed native path.

The evidence that decides a route is preserved exactly and is never widened at runtime:

- **Harness and version** — the harness (`codex`, `opencode`, `claude`) and its exact semantic
  version must match the observation; a version change denies as `evidence_mismatch`
  (`HARNESS_VERSION_CHANGED`). Pi is not a qualifiable harness: Pi dispatch is not native
  checkpointing or subscription entitlement.
- **Authentication** — only `native_owned` qualifies, so credentials stay with the executor. A
  `cloud_vault` or `delegated_session` route denies as `auth_unsupported`.
- **Location and authorization** — `agent_hq_cloud` never qualifies a native executor route, and a
  route without deployment authorization denies as `location_unauthorized`.
- **Native installation** — repository, tag, commit and bundle digest must match the pinned build
  identity; the codex route additionally pins the ACP build and its Codex version, and drift denies
  as `deploymentPin` / `DEPLOYMENT_PIN_CHANGED`.
- **Configuration digest** — a digest of the current native configuration (settings, hooks, MCP
  registrations) detects changed native configuration and denies as `configurationDigest` /
  `CONFIGURATION_DIGEST_CHANGED`.

From that evidence the gate advertises **exactly** the allow-listed capabilities, so `session.resume`
and `execution.cancel` stay disabled unless the evidence lists them. Usage is an opt-in claim:
the `usage_update` progress and the observed terminal usage are only passed through when
`usageReporting` is true. (A completed result's `usage` is a mandatory part of the execution result
contract rather than a route claim; an unauthorized route cannot reach a completed result at all
because the capability gate leaves it with no executable capabilities.)

Native shell, network, hooks, MCP and extension effects are authorized per effect. A channel must
be evidenced _and_ proven policy-enforced in the evidence, and the runtime's own pre-effect policy
decision for that effect must have allowed it; otherwise the effect is refused with
`route_unqualified`, `not_evidenced`, `controls_missing` or `effect_policy_denied`. An offline or
revoked device is a local denial that never offers a cloud reroute.

The gate performs no I/O, spawns no harness, contacts no provider, and never accepts, stores or
returns credentials: the evidence schema has no credential fields and rejects unknown keys.
See `packages/acp-adapter/docs/qualification-integration.md` for the evidence, detection and
transport-mapping call-sites.

## Failure behavior and evidence

Protocol mismatch fails closed before creating a session. Disconnects are retryable availability
failures for new requests and reconcile retained attempts as `unknown`; prompt timeouts preserve their
timeout classification without an implicit retry. Idempotency conflicts are rejected rather than
executing a second native side effect.

The package includes a deterministic ACP transport covering negotiation, execution, permission,
cancellation, disconnect, timeout, native-session opacity, and the shared RuntimeAdapter conformance
suite. The transport is test evidence and a driver fixture, not a production process launcher.

## Explicit Local process composition

The Local package exports `createLocalAcpRuntime(options)` for programmatic
`runtimeFactory` configuration. It uses the native v1 process transport and requires
an absolute executable path, explicit working directory and child environment,
and caller-owned opaque session/interaction ID mappings. It does not install,
authenticate, or configure the native harness. The CLI runtime default is unchanged.

Local composition opens lifecycle-aware runtime adapters before its workflow
endpoint and closes them after the endpoint stops, including startup rollback.
Adapters without lifecycle hooks retain their existing behavior. This wiring does
not establish process-restart recovery or complete Milestone 11 acceptance.

The Local lifecycle regression also runs a disposable native-wire subprocess
through the published-plan lookup, attempt lifecycle, SQLite outcome persistence,
and duplicate dispatch replay. Its no-filesystem capability profile is explicit:
the default fixture's `filesystem.read` requirement is separately asserted
ineligible. Native ACP tool support must not be treated as evidence of a specific
filesystem capability. This regression uses a wire fixture, not a real model or
filesystem-tool certification.

When Local is explicitly configured for the Restate durable-execution mode, its direct loopback
Restate endpoint uses bidirectional streaming so terminal control signals can arrive while a native
dispatch activity is pending. Shared
endpoint callers retain request/response mode unless they explicitly opt in;
streaming support through external proxies is not inferred from the Local probe.
