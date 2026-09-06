# Runtime capabilities and compatibility

`@control-plane/runtime-sdk` defines the Control Plane-owned vocabulary for runtime discovery,
eligibility, routing, and adapter operations. The vocabulary is provider and harness neutral; Pi, ACP,
and mock fixtures use the same schemas and no concrete runtime SDK is a dependency.

## Runtime records and ownership

A `RuntimeDefinition` identifies a normalized runtime family and records adapter, driver, and harness
versions, location, health, lifecycle, capabilities, tested-version metadata, and limitations.
`RuntimeNodeRef` is an opaque reference to Adea-owned device identity. It always declares
`authority: agent_hq`; the Control Plane neither recreates nor owns that identity.

A Control Plane-owned `RuntimeConnection` links its opaque connection ID to one RuntimeDefinition and,
for local runtimes, one RuntimeNode reference. Managed-cloud connections deliberately have no node
reference. A node can expose multiple independent runtime connections without coupling node health to
runtime health.

## Runtime connection inventory

The registry supports managed-cloud, managed-local, and external-local connections. Stable identity is
represented by a unique SHA-256 digest; any native reference must be a canonical opaque `nref_` ID.
Raw paths, credentials, process handles, and unrestricted native configuration are rejected at the
public registration boundary and are not persisted.

Registration is idempotent for one stable identity. Updates use optimistic versions and monotonic
observation timestamps. Discovery, heartbeat, health-check, and expiry timestamps remain distinct, as
do normalized status, health, compatibility, capabilities, and adapter, driver, and harness versions.
Disconnect, expiry, and revocation are state transitions rather than deletes, so historical execution
attempts keep valid connection references after a runtime disappears. Revocation is terminal.

## Health and freshness ingestion

Normalized health reports keep Adea-owned node status separate from runtime availability. This
allows node-online/runtime-degraded and node-offline/runtime-stale conditions to remain distinct.
Reports carry monotonic sequences, adapter, driver, harness, and protocol versions, and a versioned
capability snapshot with bounded TTL and verification provenance.

Availability is explicitly classified as healthy, degraded, reconnecting, offline, incompatible,
revoked, stale, or unknown. Only healthy and degraded states are executable. Supported capability
claims are retained only when verified through adapter/driver negotiation; unverified claims are stored
as unsupported. Major-version mismatches are incompatible, and expired health or capability TTLs are
stale regardless of the last successful state.

Ingestion is idempotent, rejects conflicting report identities, and ignores out-of-order reports.
Eligibility-affecting changes publish a normalized internal availability-change event. Limitations are
bounded display text and diagnostics are normalized uppercase codes, preventing raw native details from
entering Adea-facing state.

## Capability requirements

Capabilities are individually named and report supported, degraded, or unsupported state plus bounded
limitations. Session create, list, resume, close, history, and load are six independent capabilities;
none implies another. Other normalized capabilities cover streaming, tools, structured output,
filesystem/project access, cancellation, user input, approvals, model selection, and child execution.

Requirement expressions mark every capability required or optional and declare whether degraded
support is sufficient. Duplicate or contradictory requirements are invalid. Evaluation is
deterministic and sorted:

- missing, unsupported, or insufficient required capabilities make the runtime ineligible;
- missing or degraded optional capabilities produce degraded eligibility with explicit reasons;
- all satisfied requirements produce full eligibility.

## Runtime eligibility

The versioned eligibility evaluator applies an immutable ExecutionPlan's runtime requirements to one
normalized candidate before routing. It fails closed on node and connection availability, capability
freshness and verification, runtime compatibility, workspace family/location/connection policy,
security authorization, LocalProjectGrant state, and entitlement. A runtime preference is accepted as
context only; it cannot remove an ineligibility reason or bypass policy.

Every decision is full, degraded, or ineligible and contains sorted machine-readable reasons. Missing
or insufficient required capabilities are ineligible, while missing or degraded optional capabilities
remain explicit degradations. The audit envelope records the evaluator version, plan, runtime
connection, policy snapshot, evaluation time, and a canonical input digest. Managed-cloud candidates
use `not_applicable` node status so cloud eligibility does not invent Adea device health.

## Runtime routing

The versioned runtime router receives only eligibility decisions and never re-authorizes an
ineligible runtime. Its policy assigns explicit integer weights to connection/family/deployment
preference, locality, health, load, queue depth, entitlement priority, and cost class. Equal scores
use the canonical RuntimeConnection ID as the final tie-breaker, so candidate input order cannot
change the result.

Selected decisions include the chosen connection, ranked alternatives, contribution-level reason
metadata, excluded candidates and their eligibility reasons, and canonical input/decision digests.
Empty results distinguish no candidate, transient unavailability, and unavailable preferences. User
preference influences ranking only among eligible candidates. The selected policy version, decision
digests, rank, candidate count, and reason codes are pinned immutably on the execution attempt and
persisted independently of later runtime inventory changes.

## External sessions

An `ExternalSession` is a workspace-scoped reference to a session still owned by its native runtime.
It records a Control Plane ID, RuntimeConnection, canonical opaque native-session ID, bounded freshness,
independent session-operation capabilities, and safe display metadata. Ownership is always
`external_runtime`, imported ownership is false, and concurrent native use remains allowed. Public
registration rejects extra native configuration, credentials, paths, URLs, and unsafe display text.

Resume, load, close, and history controls are evaluated independently against both the session's
freshness-bound snapshot and the runtime's current advertised capabilities. Resume therefore never
implies history. Assessments explicitly classify active, closed, stale, offline, runtime-missing,
capability-changed, removed, and revoked references; historical references remain visible even when
operations are unavailable. Registration is stable-identity idempotent, observation updates are
optimistically versioned, capability snapshots cannot regress or conflict at one version, and
revocation is terminal. The PostgreSQL record preserves only the scoped opaque reference and normalized
metadata, not native ownership or unrestricted session state.

ACP session discovery publishes each normalized create, observation update, and removal through an
optional projection port. Supported compositions bind that port to their scoped SQLite or PostgreSQL
discovery repository; projection failure fails the adapter operation so retry can repair the public
read model without exposing native session identifiers.

## Adea discovery read models

The Control API exposes authenticated v1 list/get operations for runtime connections and external
sessions. Adea calls only these Control Plane operations; it does not call Runtime Gateway,
drivers, harnesses, or native runtimes directly. Every request carries the normal service envelope and
is authorized against its workspace, optional project, and optional RuntimeNode scope.

Runtime connection summaries keep RuntimeNode status and health separate from connection status,
health, and availability. They include location, adapter/driver/harness/protocol versions, capability
support, compatibility, freshness, LocalProjectGrant and entitlement hints, limitations, eligibility
reasons, degradations, and bounded remediation actions. External-session summaries expose only safe
display metadata, snapshot freshness, independent operation controls, and recoverability. Projection
schemas strip opaque native references, raw paths, process handles, credentials, native configuration,
and unrestricted native session state.

List operations sort by canonical public ID and use bounded opaque-cursor pagination. Filters cover
RuntimeNode, normalized state, runtime connection, required capabilities, and external-session state.
Fresh, stale, expired, and unknown data are explicit; offline, incompatible, capability-mismatch,
removed, and revoked conditions remain machine-readable rather than being collapsed into absence.

## Runtime adapter contract

`RuntimeAdapter` is the stable port used by execution code for inspection, capability evaluation,
start, ordered progress, input and approval responses, cancellation, status and reconciliation,
session operations, and cleanup. Requests carry a readonly ExecutionPlan snapshot with its identity,
digest, schema version, and normalized runtime requirements. Concrete adapters translate that snapshot
inside their own package and must not mutate it or expose native SDK types through the contract.

Handles, progress, terminal results, usage, Artifact references, and classified errors are normalized.
Start, interactions, cancellation, session creation and closure, and cleanup have explicit idempotency
expectations. The reusable conformance runner verifies inspection, eligibility, idempotent start,
normalized conflicts, plan immutability, ordered progress, reconciliation, terminal results, and cleanup.
`MockRuntimeAdapter` supplies a deterministic implementation for execution and adapter tests.

## Compatibility states

Compatibility assessment checks lifecycle and health first, then declared compatibility, contract,
adapter and driver major versions, and finally capability requirements. Results are explicit:
compatible, degraded, untested, incompatible, deprecated, revoked, unavailable, or
capability-missing. No version or capability is inferred from a related operation.

Tested-version metadata records the exact public contract, adapter, driver, and harness versions used
to establish compatibility. Equality helpers compare parsed normalized definitions and capability sets
independent of capability ordering. The neutral adapter contract and mock do not implement discovery,
installation, native authentication, or concrete Pi/ACP execution.

The Local managed Pi process client is a concrete direct execution path, but its claims remain
bounded. It inspects the configured Pi executable, supports the explicit `0.84.x` launcher range,
streams text and usage through strict RPC framing, accepts cancellation, and exposes steering input
as degraded. It disables Pi-native tools and ambient configuration and therefore does not advertise
filesystem, tool, approval, Artifact, or restart-reconciliation capabilities. Exact immutable
Profile/Skill/ContextPackage inputs are resolved and checked before process start. A plan requiring
an omitted capability is rejected by normal RuntimeAdapter eligibility rather than executed with a
weaker policy.
