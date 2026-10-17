# BYO lead model authority (issue 931)

Contract for how a Pi Durable lead run may use a Control Plane held bring-your-own (BYO)
model connection. It states what is enforced and where, so a consumer (for example the
Adea app) can rely on the refusal shape. It adds no new operation, credential path or
spending authority. It is proven with a scripted account reader, vault secret and
transport; it is **not** live-provider qualification, and the account reader that tells
Control Plane the real quota, entitlement and residency is still host supplied.

## Eligibility

A connection can serve a lead only when all of these hold at the moment of use:

- provider `openai`, auth `api_key`, funding source `byo_api`;
- harness `pi_durable` 1.1.0, binding `pi_durable_models`, location `remote_host`
  (other harnesses fail `INCOMPATIBLE_HARNESS`, other locations `INCOMPATIBLE_LOCATION`);
- the pinned model is still on the account, and the workspace grant, credential revision,
  quota, entitlement and residency are all current;
- the recorded payer is explicit and is not an Adea account. A `byo_api` key is paid for by
  the key owner, so a funding record that names `adea_account` is refused with
  `PROVIDER_POLICY_DENIED` (`provider_account` and `workspace_account` are allowed).

Lead, child and direct roles select independently. Nothing is inherited and nothing falls
back to another account, deployment, model or role. Control Plane does not gate direct
sessions; a consumer decides direct eligibility from the table above.

## Where it is rechecked

Every boundary re-reads the host account authority, never a cached answer:
selection resolve, prepare, dispatch, provider resolve and credential lease, and each
physical provider send (`assertActive`). A fault at any read stops all later sends.

## Refusal contract (v1)

Prepare and dispatch refuse with code `PI_LEAD_MODEL_NOT_READY`.

- HTTP 409 (`error.class` `conflict`, not retryable) for a definite not-ready reason.
- HTTP 503 (`runtime_unavailable`, retryable) when the reason is `READINESS_UNAVAILABLE`
  (account reader or quota unreadable).
- `error.details.reasonCode` is one of the model readiness reasons except `READY`:
  `CONNECTION_MISSING`, `CONNECTION_REVOKED`, `CREDENTIAL_MISSING`, `CREDENTIAL_EXPIRED`,
  `CREDENTIAL_REVOKED`, `CREDENTIAL_REVISION_CHANGED`, `WORKSPACE_GRANT_EXPIRED`,
  `WORKSPACE_GRANT_REVOKED`, `SELECTION_CHANGED`, `MODEL_UNAVAILABLE`, `QUOTA_EXHAUSTED`,
  `INCOMPATIBLE_HARNESS`, `INCOMPATIBLE_LOCATION`, `AUTH_MODE_UNSUPPORTED`,
  `PROVIDER_POLICY_DENIED`, `READINESS_UNAVAILABLE`.
- A blocked funding view carries the same `reasonCode`; a ready view is unchanged.
- No secret, provider message or account detail is included.
- `@adea-ai/sdk` `ControlPlaneClientError` exposes the closed reason as an optional
  `reasonCode` (also in `toJSON()`); other `details` stay server-side. `READY`, free text and
  unknown values are dropped. It ships with the next release after this merges.

Status, progress, lookup and cancel of an already admitted lead never require model
readiness, so an operator can always see and stop a run after quota, grant or credential
loss. Cancel keeps current actor, scope and lineage checks.

Cancellation of an already admitted child uses the same distinction. Its current
product reads use `observe`, and the child model host re-derives the accepted actor,
principal, scope, revision, expiry, objective and plan from canonical records without
resolving a model or reading funding records. The raw product revision must equal the
retained intent revision, and the existing immutable product/profile digest fence remains
required without creating a missing pin. Full host identity validation is the final
awaited authority check, so later canonical reads cannot discard principal/scope/objective
changes. New admission, continuation and inference
still require model and funding readiness. An uncertain physical send retains the
existing cancellation/reconciliation fence across reopen; stopping does not release
its accounting holds or assert that the send was undone.

## Proof

- `tests/pi-byo-model-authority.test.mjs` runs the production composition against nine
  account faults: prepare and dispatch refuse with the exact reason and zero sends, leases
  or allocations; a running lead stays observable and cancellable; a payer kind case; and
  a sweep that injects quota loss at the first and last account read of every named boundary
  (lead stage, credential lease and secret steps, send start) and asserts no send starts after it.
- `apps/control-api/src/pi-durable/node-admission.test.mjs` pins the read purpose per
  operation: prepare and dispatch read inference authority; status, progress, children and
  cancel read observe authority. The production composition does not wire the children read yet
  (`PI_LEAD_NOT_CONFIGURED`), so children under faults is proved at the purpose boundary, not
  end to end.
- `apps/control-api/src/pi-durable/pi-lead-model-not-ready.http.test.mjs` pins the HTTP
  envelope for every reason.
- `packages/model-gateway/src/funding-view.test.mjs` pins the payer kind rule.
- Child authority/current-reader tests pin cancellation purpose, model/funding independence
  and refusals for changed actor, audience, scope, revision, expiry and lineage.
- The child cancellation case in `tests/pi-durable-compaction-governed-dispatch.test.mjs`
  uses the production factory, canonical SQLite stores and native Pi with a scripted held
  send. It checks scope refusal, stop delivery after model and payer readiness loss, and
  retained uncertain-send fencing across reopen, with no new sends, leases or reservations.

## Not covered

- Live OpenAI qualification and a real account reader.
- The reason for a denial that happens after a send has started is not carried back to the
  run result; the run fails closed without a bounded reason code.
