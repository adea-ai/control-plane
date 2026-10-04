# Memory write proposals

Memory retrieval never implies a provider write. `@control-plane/memory-writeback` exposes a separate
effect boundary whose default modes are `disabled`, `proposal_only`, and `approval_required`.
`proposal_only` records a bounded candidate but cannot commit it; automatic durable writes are not a
supported mode.

Each proposal pins the provider and connection, workspace and exact scope digest, content type and
digest, retention, source execution/attempt, confidence, importance, sensitivity, expiry,
evidence/Artifact references, and a workspace-scoped dedupe hint. Full transcripts, unrestricted
logs, source documents, unsupported sensitivity, over-limit content, and cross-scope material are
rejected before persistence. Proposals contain no reusable provider credentials.

When policy requires approval, the service creates the proposal and its durable `InteractionRequest`
in one repository operation. PostgreSQL and SQLite adapters commit both records in the same database
transaction; a conflicting proposal creates no interaction, and an interaction conflict or transaction
failure rolls back the proposal. The in-memory test adapter publishes the pair without yielding.
An adapter without `insertWithApproval` fails with `MEMORY_APPROVAL_ATOMICITY_UNAVAILABLE` before
creating either record. Supply an interaction repository backed by the same database when constructing
the service. Approval accepts only an unexpired response from an allowlisted principal. Approval, denial, expiry,
revocation, failure, commit, and reconciliation are persisted as versioned proposal outcomes.
ProjectState promotion is an independent effect.

An approved commit crosses the provider adapter exactly once with a stable idempotency key. Duplicate
delivery returns the recorded result. Timeout-before-effect, timeout-after-effect, rejection, and
ambiguous status are normalized; a provider with idempotent status can reconcile an observed commit,
while unresolved or non-idempotent ambiguity remains `reconciliation_required` for operator review.
The package supplies absent, read-only, idempotent, and ambiguous fake profiles and requires no
Cortana or Adea service.

`SqliteMemoryWriteProposalRepository` persists workspace dedupe, proposal versions and approval links
across database reopen for Local and Hosted Simple persistence. Durable source-execution ownership is
checked during atomic approval creation. Local, Hosted Simple, Managed Cloud and Hosted Server roots
expose a `memoryWrites` application capability using their existing proposal and interaction stores.
All roots default to disabled. Operators can inject `memoryWriteback` configuration with a parsed,
fixed server policy, matching provider adapter and separate `MemoryWriteAuthority`. Managed Cloud
`start` accepts that option directly; Local and Hosted Server accept it through `compositionOptions`.
A configured provider without explicit authority fails before the root allocates storage or processes.
The programmatic capability accepts proposal/approval inputs and proposal IDs; policy and lifecycle
clock values come from the server. There is no automatic write mode or memory HTTP/IPC route.

The authority port checks the exact provider, connection, workspace and scope for proposal creation,
fresh writes and status recovery. Read grants do not implement this effect authority. Fresh writes
recheck current content bounds, the current approver allowlist, the linked approval response and its
expiry before persisting commit intent. Disabled or read-only writes can still recover an uncertain
prior effect through separately authorized status lookup; they cannot retry the write. A pre-dispatch
authority check is not an atomic transport revocation fence: the provider adapter must enforce current
credentials and authorization at delivery.

Profile crash/restart acceptance, real provider transport and complete proposal/interaction retention
remain tracked in M11. The composition capability does not authorize deletion. See the
[composition evidence](./evidence/m11-memory-composition-2026-10-04.md).

Proposal transitions preserve the full proposed effect: provider/connection/workspace/scope,
content and digest, type, retention, every provenance field, dedupe identity, creation time,
and approval interaction link. All three repository adapters reject any mutation of those
fields before writing. Only lifecycle state, version, update time, and recorded outcome may
change. Reopening a SQLite database therefore preserves the exact intent the principal
approved. This guard does not audit or repair previously modified records, supply provider
authority, or certify a deployed profile. See the [intent evidence](./evidence/m11-memory-approved-intent-2026-10-04.md).
