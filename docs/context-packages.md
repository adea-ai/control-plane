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

## Child derivation

A child package references its parent package ID and digest. Its state items and Artifacts must be
subsets of what the parent actually contains, and its byte/token ceilings cannot exceed the parent.
An item cannot retain provenance for an Artifact removed from child authority. Objective, success
criteria, and return contract may be specialized without widening the pinned ProjectState baseline or
permissions.

The exported future Pi, ACP, and LangGraph serialization fixtures all use this same normalized schema.
They contain no adapter SDK types, credentials, local paths, or native-session configuration.
