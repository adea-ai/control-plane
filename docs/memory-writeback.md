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

When policy requires approval, the service creates the existing durable `InteractionRequest` and
accepts only an unexpired response from an allowlisted principal. Approval, denial, expiry,
revocation, failure, commit, and reconciliation are persisted as versioned proposal outcomes.
ProjectState promotion is an independent effect.

An approved commit crosses the provider adapter exactly once with a stable idempotency key. Duplicate
delivery returns the recorded result. Timeout-before-effect, timeout-after-effect, rejection, and
ambiguous status are normalized; a provider with idempotent status can reconcile an observed commit,
while unresolved or non-idempotent ambiguity remains `reconciliation_required` for operator review.
The package supplies absent, read-only, idempotent, and ambiguous fake profiles and requires no
Cortana or Adea service.
