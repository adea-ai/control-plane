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
re-evaluated after every await — immediately before send at the controller and immediately before the
executor at the device — so revocation, cancellation, or a broken clock landing while work is parked
can never reach an effect. A non-finite clock or malformed window fails closed. Unauthenticated
input receives no signed reply, so an intermediary cannot harvest a device signature over copyable
header fields. Every denial carries an explicit `fallback: 'none'`.

Device fence state is durable through `AcpRemoteDeviceStateStore`:
`PersistenceProviderAcpRemoteDeviceStateStore` persists the highest accepted channel generation, the
first applied revocation, and the replay ledger (create-if-absent claim, then recorded outcome) over
the Local/Hosted `PersistenceProvider`, while the in-memory store is a test/default seam that is not
durable across restart. After a restart a recorded command replays its recorded outcome without
re-executing, an older channel generation stays denied, a revocation stays terminal, and a claim
whose effect never completed denies as `outcome_uncertain` instead of being blindly retried. A stale
generation or an expired delivery window is denied even when a recorded outcome exists; only a
current window under current authority may recover it.

Neither layer can produce an implicit cloud reroute: an offline or revoked route denies with
`fallback: 'none'` and the transport has no alternate route, and at attempt selection
`RuntimeDiscoveryAttemptRouter` refuses to replace an offline or revoked local runtime that the plan
could have used with a remote one (`WORKFLOW_RUNTIME_LOCAL_UNAVAILABLE_NO_FALLBACK`).

Evidence: `packages/acp-adapter/src/acp-remote-fence.test.mjs` (route schema, fence decisions,
finite-clock guards, HPKE/signature binding), `packages/acp-adapter/src/acp-remote-transport.test.mjs`
(parked-async revocation/abort regressions, authenticated and encrypted runs, replay/conflict/
generation proofs, edge fences), and
`apps/local-control-plane/src/acp-remote-device-restart.test.mjs` (restart proofs through the real
SQLite persistence composition using disposable per-test databases).

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
