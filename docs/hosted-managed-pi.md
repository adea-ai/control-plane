# Hosted managed Pi

`apps/runtime-worker` is a separated Hosted/server composition for `ManagedPiAdapter`; it is not an
active Railway Cloud service. The adapter uses the same normalized and pinned configuration for
local and hosted Pi; only the client boundary changes. A `RuntimeHostProvider` owns sandbox
allocation, process lifecycle, and provider-specific implementation details.

## Authority and isolation

The worker sends the host a bounded launch request containing the normalized execution configuration, opaque model/tool authorization references, the exact sandbox CPU/memory/storage limits, and a deadline derived from the plan. It does not send provider credentials, arbitrary host paths, environment variables, executables, or ambient filesystem authority. The host rejects a plan before allocation when its duration or sandbox limits exceed provider capacity.

Untrusted code and tool operations remain inside the approved host and tool-provider boundaries. Model and tool grant references authorize provider-side resolution without persisting reusable provider secrets in the execution plan, prompt, adapter state, or worker state.

## Lifecycle and recovery

Launch is idempotent by the adapter command key and normalized request fingerprint. Cancellation moves the retained hosted attempt to a terminal cancelled state, cleanup releases its sandbox once, and reconciliation queries the provider-owned retained attempt after a worker restart. A worker crash is normalized as retryable infrastructure failure; ambiguous or conflicting idempotency is never retried implicitly within the same attempt.

Progress, usage, interactions, errors, and results flow through the ordinary `ManagedPiAdapter` normalization path. Persistent outputs are written through `HostedArtifactStore` and returned as Control Plane Artifact references rather than depending on worker-local disk.

`ObjectStoreHostedArtifactStore` verifies the attempt-bound key and metadata,
media type, size and SHA-256, then reads and hashes the actual bytes before
returning an Artifact reference. This applies to initial writes and warm/cold
replays; an acknowledged PUT or cached promise is not durability evidence.
Identical concurrent writes are coalesced only while in flight. A lost PUT
acknowledgement is recovered by verifying existing bytes, without another PUT.
Results default to a 256 KiB bound; an operator may explicitly configure
`maxResultBytes` between 1 byte and 64 MiB, also subject to the ObjectStore's
own limit. Conflicting retained content fails closed.

Concurrent-write coalescing is instance-local, but first publication now
requires `ObjectStore.putIfAbsent`. Unsupported adapters fail at construction
with `HOSTED_ARTIFACT_CONDITIONAL_CREATE_REQUIRED`; there is no unconditional
fallback. Independent writers of the same result return the verified winning
reference. A conflicting result is rejected without replacing the winning
bytes. An `exists` response still requires HEAD/GET binding and byte checks.
R2/S3 uses a provider precondition; filesystem storage atomically publishes a
complete private envelope. This fences cooperative first writers, not execution
admission, deletion, legacy/unconditional writers, or upload authorization.
Quiesce old writers before activating this implementation. The host still needs
durable admitted-attempt ownership to prevent duplicate execution effects.

The current ObjectStore path is attempt-bound, not a production RuntimeNode
upload authority. Workspace/node/command-scoped upload credentials, gateway-side
Artifact authorization and the real Hosted provider/channel startup remain
separate requirements; this integrity check does not establish those controls.

## Registration, readiness, and scaling

Host inspection produces a normal `managed_cloud` RuntimeConnection at `agent_hq_cloud`, including verified capabilities, versions, health, freshness, and compatibility. Eligibility and routing therefore use the same Runtime SDK evaluation as every other runtime.

`HostedManagedPiWorker` exposes provider-neutral readiness and capacity demand. The bootstrap composition refuses readiness when the host is unavailable or has no capacity and closes the host provider during graceful shutdown. Scaling output contains only current slots, active work, queued work, and desired capacity; a deployment adapter may translate that signal for any approved container or sandbox provider.
