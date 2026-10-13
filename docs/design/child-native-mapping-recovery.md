# Child native-start-to-mapping recovery seam

Unpublished implementation against frozen integration tree
`4232f00c68a649a574fed82038429ec7dc04c6e2`. Recovery is disabled unless the host
supplies qualified read ports. Production composition is unchanged.

## Scope

Repair missing CP job/attempt/native-session metadata after the native adapter
has retained a start but the CP mapping write or its acknowledgement is lost.
Reuse the existing SQLite delegation repository and native journal. No new
runtime, registry, scheduler, session, credentials, model selection or funding.

CP935 continues to own uncertain-effect reconciliation, retries, cancellation,
approval-before-effect and direct control. This seam must not clear a tool's
`executing`/`reconciliation_required` state, manufacture a success result,
resume an inference, settle usage or publish terminal outcomes. CP1048 owns
Hosted/Local wiring and scheduling. Existing terminal publication recovery is
unchanged and excluded from the regression.

## Implemented contracts

1. Before invoking native `start`, retain a child-runtime lookup receipt in the
   same CP store as the admitted child. Pin workspace, original actor, parent
   execution/attempt, admitted tool call and compiler receipt digest, delegation,
   child execution/attempt, runtime connection, immutable child plan reference,
   exact start idempotency key and original attempt-budget snapshot. Retain the
   complete validated start request (or an exactly reconstructable pinned plan
   plus request fields) and its canonical digest. This is historical evidence,
   not authorization to spend or dispatch. No caller can supply replacement
   request fields, ceilings, handle, native session or actor.
2. Add explicit host-only `nativeReceiptReader.findExistingHandle` and
   `receiptReadAuthority` ports. Its `assertQualified` callback must independently
   qualify the actual native reader object, workspace and runtime connection;
   accepting matching strings or a schema-valid response is not authentication.
   Bind the reader to the retained runtime connection;
   re-prove the original actor/audience and current read scope using existing
   canonical authorities. Do not reuse spending readiness or an old admission
   receipt as current read permission. Missing/unqualified read authority denies.
3. Add `bridge.recoverChildSession(identity) -> { mapping, handle }`. Load the
   retained lookup receipt and canonical plan; match every identity and digest.
   Require delegation child attempt, child latest attempt, parent latest attempt,
   plan pins, workspace and runtime connection to match the retained tuple.
   Terminal parent state alone must not authorize a new effect or require one.
4. Check current read scope, call only `findExistingHandle` with the exact
   retained request, then recheck read scope after the await. Missing or
   conflicting native receipt remains blocked. Never fall back to `start`,
   `resolveStart`, new budget reservation, provider readiness or inference
   reconciliation. A record with an admitted-but-not-run native start is still
   metadata only; this operation does not schedule or resume it.
5. In a CP transaction, re-read/fence the canonical tuple and its revision,
   then use existing `bindChildSession` uniqueness rules. Recheck local read
   authority through a transaction-bound reader where available; preserve
   external authority revision pins and deny on changed/unavailable evidence.
   A changed attempt or plan denies; same-tuple CAS contention returns conflict
   for a fresh metadata-only retry. Already-identical mapping converges. A native
   session owned by another attempt, or a different session on this attempt,
   conflicts without overwriting either mapping.
6. Return retained metadata proof only. Leave tool status/history, approvals,
   inference generation, budgets, usage and terminal publications untouched.
   CP935 may consume that proof through its own separately reviewed contract.

The two stores remain separate. The pre-start CP lookup receipt plus the native
journal makes the gap repairable; it does not claim cross-store atomicity.
Receipt retention and read-scope qualification must be reviewed with the owning
lifecycle/retention teams before production wiring.

Qualification is checked before and after every current-authority await. The
authority response pins the original actor, reader principal, audience, revision
and expiry; the final recheck runs through a reader limited to the open CP
transaction and that reader is closed afterward. These callbacks are trusted
server ports, never request data. Their authentication and substrate qualification
remain the host owner's responsibility. External authority can still change
after the final check; separate stores do not provide an atomic authority lease.

## Regression and acceptance matrix

The supplied regression uses the existing actual native governed-child fixture,
transactional admission, approvals, loopback provider responses and production
usage ledger. It faults only the CP mapping writer after native start, verifies
one physical child request and actual usage, observes unchanged tool replay,
reopens native storage and a fresh canonical SQLite connection, and asks the new
metadata-only seam to restore the original session twice. Effect/spend callbacks
are forbidden during repair. The tool receipt must remain unchanged.

Additional implementation gates: crash before native admission returns missing
without starting; changed actor/read grant during lookup denies without writes;
changed parent/child attempt, plan, workspace or runtime denies; same-attempt
concurrent repair converges; native session collision denies; lost CP mapping
acknowledgement replays identically. None of these tests should duplicate
terminal-publication or CP935 retry/control qualification.

The first fault probe exposed a source/package `ToolGatewayError` identity split
that incorrectly retained an unknown native effect as `failed`. The separately
reviewed classification correction now aligns the fixture imports and keeps
unrecognized post-invocation errors conservative. The composed regression expects
typed `unknown` and `reconciliation_required`, and metadata recovery preserves
that exact evidence and replay. Production qualification and CP935 tool-outcome
reconciliation still require separate owner review.
