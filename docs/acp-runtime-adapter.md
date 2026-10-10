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
record is a public-key-only strict schema, so credential or private-key fields cannot enter it, and
inventory replies are bound to a per-request nonce with a freshness bound.

Authority checks are current-authority: the route fence (revocation, trust-record staleness, finite
clock) and the command's window/channel-generation gates are evaluated before decryption and
re-evaluated after **every** await on the effect and publication paths — after send and after reply
opening at the controller, and after each storage read, the ledger claim, execution, and reply
sealing at the device — with every reply publication (fresh, sealed, or cached) fenced against the
persisted fence, and the persisted fence enforced atomically inside the durable claim transaction.
A revocation or superseded generation durable before a claim refuses that command atomically, and any
revocation, superseded generation, expired window, or broken clock in force at the final read refuses
the reply (see the response authorization boundary below). After a successful claim, a fresh durable
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
called decides whether the effect runs. A denial it observes (revocation, supersession, expiry, or a
broken clock) is recorded as the command's outcome, and nothing is dispatched. A store failure at that
read also dispatches nothing, but it is not an authority decision: the claim stays unrecorded, so a later
delivery of the same identity that reaches the ledger reads `outcome_uncertain` and nothing re-runs. A
retry on the same return key receives the byte-identical reply it already got. The read is point-in-time.
No await separates its completion from the dispatch call, but a commit landing after its snapshot is not
observed by it. This does not make the executor's side effects or any network delivery atomic with the
read, and a revocation committed after the read cannot stop a dispatch already in progress.

**Production construction is wired (no documented-gap substitute):**
`createPersistentSecureAcpDeviceEndpoint` always builds the scoped
`PersistenceProviderAcpRemoteDeviceStateStore(provider, acpRemoteDeviceStateScope(route))`, and the
Local composition's `secureAcpRemoteRoute` option constructs the endpoint over the composition's
own `SqlitePersistenceProvider` (`LocalControlPlaneComposition.secureAcpDevice`), with passthrough
from `start()` via `compositionOptions`. The route record (public keys, ids, validity) stays an
explicit host-supplied composition input — no ambient credential or key material — and the
in-memory default remains test-only.

**Fenced-settlement scope (evidence closing the credential-authority gap):** the only production
callers that pass a credential fence into a runtime-command settlement are the gateway deliveries
(`apps/runtime-gateway/src/runtime-command-delivery.ts:356` and
`context-command-delivery.ts:412`), and the gateway profile is wired for the authority
(`runtimeNodeCredentialAuthority`, fail-closed when absent). The Local all-in-one has ZERO fenced
settlement callers (verified by repository search), so its fail-closed default is unreachable in
production Local today: no Local path ever settles a fenced ACK/result. The
`runtimeCommandCredentialAuthority` seam on the Local composition is forward-compatible only; a
credential source is required solely when a fenced settlement caller is added to the Local profile.

**Hosted PostgreSQL durable state:** the Hosted `hosted-server` profile qualifies the same
`PersistenceProvider` contract through `PostgresPersistenceProvider`
(`packages/profile-portability/src/postgres-persistence-provider.ts`) over the new
`persistence_records` table (drizzle migration `0071_persistence_records`; the canonical migration
chain, applied by the migration role, owns DDL — the provider verifies presence and never creates
tables). The device fence/ledger store is proven on real PostgreSQL — atomic claims, revoked and
superseded rejection without writes, restart persistence, concurrent same-key races, and per-route
namespacing — in `tests/acp-remote-device-postgres.integration.test.mjs` against a disposable
isolated database.

Neither layer can produce an implicit cloud reroute: an offline or revoked route denies with
`fallback: 'none'` and the transport has no alternate route, and at attempt selection
`RuntimeDiscoveryAttemptRouter` refuses to replace an offline or revoked local runtime that the plan
could have used with a remote one (`WORKFLOW_RUNTIME_LOCAL_UNAVAILABLE_NO_FALLBACK`).

Evidence: `packages/acp-adapter/src/acp-remote-fence.test.mjs` (route schema, fence decisions,
finite-clock guards, HPKE/signature binding), `packages/acp-adapter/src/acp-remote-transport.test.mjs`
(parked-async revocation/abort regressions, parked storage window/generation regressions,
revocation at execution/sealing/response-opening boundaries, authenticated and encrypted runs,
replay/conflict/generation proofs, edge fences), `packages/acp-adapter/src/acp-remote-response-boundary.test.mjs`
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
