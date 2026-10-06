# ProjectState and promotion proposals

The Control Plane owns durable canonical `ProjectState` for a workspace/project scope. It is separate
from Adea product state, workflow checkpoints, runtime-native sessions, and model conversation
history. Adea consumes it only through versioned Control Plane contracts and SDKs.

## Revisions and conflict handling

Every aggregate begins at revision zero. A mutation supplies an expected aggregate revision, a
canonical mutation ID, the acting principal, timestamp, and one or more append/update operations.
Repository adapters implement compare-and-set atomically.

- Only one conflicting writer can commit against the same item revision.
- A stale write that overlaps an intervening item ID or logical key returns `STALE_REVISION` with the
  expected revision, current revision, and sorted conflicting item IDs.
- Disjoint stale appends or updates are applied to the current aggregate in deterministic key order.
- Retrying the same mutation ID and canonical payload returns the original result without a new
  revision or event. Reusing the ID with another payload fails.

The repository retains immutable snapshots for every revision, so callers can reconstruct state at an
exact revision or list the complete history. Durable adapters must preserve the same CAS, mutation-ID,
and snapshot semantics transactionally.

## Initialization over the Control API

`POST /v1/project-states/initialize` (`project-state.initialize`, an additive contract 3.0 operation, SDK
`initializeProjectState`) creates the empty revision-zero aggregate for the envelope's
`(workspaceId, projectId)` so a caller such as Adea can initialize state when it creates a project.
The route requires the `project-state:initialize` scope, a required envelope `projectId` that is in
the credential's `projectIds`, a workspace in its `workspaceIds`, and a caller assertion that matches
the verified principal. The payload is the empty object; its envelope `payloadHash` must be the
SHA-256 of its canonical JSON. The Control Plane owns the content (`schemaVersion: 1`, no items)
and the creation time.

Initialization happens once per scope. The adapter commits revision zero, its history snapshot, an
initialization receipt (caller, command ID, idempotency key, server-computed payload hash and time)
and a `project_state.initialized` record in one transaction:

- an exact retry (same caller, idempotency key and payload) returns the original command ID and
  initialization time without a new revision or event;
- the same caller and idempotency key with another payload is `409 PROJECT_STATE_IDEMPOTENCY_CONFLICT`;
- any other command for an already-initialized scope, including one created by operator bootstrap or
  a portability import (which carry no receipt), is `409 PROJECT_STATE_ALREADY_INITIALIZED`. Callers
  can then read it through `project-state.resolve`.

Callers should derive a stable idempotency key from the project (for example
`project-state-init:<projectId>`) so retries after a lost response replay rather than conflict.
Initialization is not a mutation: it records no mutation ID and does not publish
`project_state.changed`. PostgreSQL stores receipts in `project_state_initializations` (migration
`0062`) and the event in the outbox; SQLite stores them in the `project-state-initializations` and
`project-state-initialized-events` record namespaces, which need no schema step. Receipts are
command-replay metadata and are not exported by profile portability; the state itself is.

## Items and provenance

Each item has an opaque ID, logical key, item revision, value, sensitivity, freshness/expiry, created
and updated timestamps, optional superseded-item reference, and provenance. Provenance identifies its
source kind, source principal or execution where applicable, captured time, and canonical Artifact
references. Raw provider, runtime-session, checkpoint, database, and local-path identifiers are not
ProjectState provenance.

## Promotion lifecycle

Direct canonical mutations reject execution-derived provenance with `PROMOTION_REQUIRED`. Execution
output instead creates a `StatePromotionProposal` pinned to its source execution and base ProjectState
revision. Its lifecycle is explicit:

- `candidate` can be approved or rejected by a reviewing principal;
- `approved` can be merged before expiry;
- `merged` records the reviewer and resulting ProjectState revision;
- `superseded` names a candidate replacement;
- `expired` records when the review window elapsed;
- `rejected` retains the reviewer and reason.

Merging applies the proposal through the same CAS and non-conflicting merge rules as a principal
mutation. Proposal creation never changes canonical state.

## Events and persistence ports

`ProjectStateRepository`, `StatePromotionProposalRepository`, and `ProjectStateEventPublisher` are
inward-facing ports. `project_state.changed` is published only after a successful canonical CAS; stale,
rejected, duplicate, and proposal-only operations do not emit it. Initialization records the
separate `project_state.initialized` event exactly when revision zero commits. Durable implementations should bind
the state revision, mutation record, history snapshot, and an outbox event in one transaction, then
deliver that event through the publisher. The in-memory adapters are deterministic test fixtures, not
durable storage.
