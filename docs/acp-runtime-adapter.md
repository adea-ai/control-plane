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
