# ContextPackage compilation

A `ContextPackage` is an immutable, content-addressed execution input owned by the Control Plane. It
is not mutable memory, an Adea product-state copy, a workflow checkpoint, model conversation
history, or a runtime-native session. Runtime adapters receive this normalized package and translate
it at their boundary.

## Reproducible inputs

Compilation records the compiler semantic version, compile time, objective, exact workspace/project
and ProjectState revision, exact item IDs and item revisions, Artifact IDs and digests, sensitivity,
freshness, provenance, permissions, success criteria, return contract, and byte/token budgets. The
normalized payload is hashed with SHA-256; its opaque `ctx_` identifier is deterministically derived
from that digest. Recompiling unchanged inputs with the same compiler version returns the same bytes,
digest, and ID.

`ContextPackageRepository` persists immutable packages by `{ contextPackageId, contentDigest }` and
verifies the content hash before accepting a write. The in-memory implementation is a test adapter;
durable implementations must enforce the same content-addressed uniqueness.

## Selection and budgets

Candidates are ordered by required before optional, descending priority, then opaque item ID. The
compiler validates each candidate against the supplied ProjectState snapshot and authorization result.
It counts selected JSON value/key bytes with a fixed envelope allowance, counts referenced Artifact
bytes once, and estimates tokens deterministically at one token per four bytes rounded up.

Required context that is stale or cannot fit fails compilation. Optional stale inputs are excluded as
`STALE_OPTIONAL`; optional inputs beyond either budget are excluded as `BUDGET_LIMIT`. The package
records usage and every exclusion. Selection never depends on repository order.

## Fail-closed classifications

Compilation returns stable codes for stale ProjectState revisions, missing items, item-version drift,
unauthorized sensitivity or references, stale required inputs, missing/revoked Artifacts,
contradictory duplicate references, and required-context budget overflow. Authorization booleans are
trusted policy-decision inputs; the compiler never invents authority or resolves provider credentials.

## Pre-validation authoring service

`ContextAuthoringInputsSchema` in `@control-plane/contracts` defines the shared caller-selection
shape. `ContextPackageAuthoringService` extends it with host-bound scope and revision, separating
caller selection from trusted inputs. Its strict request
schema accepts scope, the pinned state revision, candidate IDs/revisions, objective, result contract,
success criteria and requested budgets. It does not accept authorization flags, Artifact metadata,
permissions, ProjectState content or a caller-controlled compilation clock. The host supplies the
authenticated principal separately and injects a `ContextAuthoringAuthority`, scoped state repository,
package repository and trusted clock.

The authority adapter must obtain policy decisions and Artifact lifecycle evidence from their
respective owners. The service checks decision scope/principal/expiry, repository scope, Artifact
identity/scope/authorization and availability, intersects requested budgets with policy ceilings,
compiles and persists an immutable reference for the existing execution-validation operation.
`unverified` and `quarantined` inputs are unavailable; the service is not a scanner or a replacement
for product authorization. A resolver must map all non-admissible product states to unavailable
states, never translate an arbitrary caller flag into `available`.

Optional-item freshness selection and compilation use one trusted timestamp, so expired optional
items are excluded before their Artifact references are resolved. Policy expiry is checked again
after asynchronous resolution. Artifact decisions are observations during authoring, not leases:
revocation after authoring still requires an execution-time check or an authoritative revision/lease
contract. Persisted package integrity alone does not prove continuing Artifact authorization.

This service has focused no-provider contract tests and a file-backed SQLite test that creates from
persisted ProjectState and resolves the same package by digest and ID after close/reopen. These are
not production composition evidence.
Deployment wiring, authoritative adapters, pinned optional-provider enrichment, durable all-profile
acceptance and the entrypoint's authentication/idempotency contract remain required before the
context-authoring reachability gap can close. Calling the service with a fixture is not proof that a
shipped application exposes a supported authoring path.

The canonical API specification permits context inputs as an alternative to a package reference,
but the current execution-validation operation still accepts references only. Enabling the input
form must also provide durable command replay: the authoring clock and permission observations
must not create a different package on each identical retry. The shared input schema is preparation
for that integration, not a claim that inline execution authoring is enabled.

## Child derivation

A child package references its parent package ID and digest. Its state items and Artifacts must be
subsets of what the parent actually contains, and its byte/token ceilings cannot exceed the parent.
An item cannot retain provenance for an Artifact removed from child authority. Objective, success
criteria, and return contract may be specialized without widening the pinned ProjectState baseline or
permissions.

The exported future Pi, ACP, and LangGraph serialization fixtures all use this same normalized schema.
They contain no adapter SDK types, credentials, local paths, or native-session configuration.
