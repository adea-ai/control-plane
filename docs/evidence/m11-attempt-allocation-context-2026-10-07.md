# M11 attempt allocation context

This increment connects the accepted attempt reservation to Local direct runtime
start and managed Pi's trusted input resolver. It does not implement native
per-request spending enforcement or establish purchased funding.

## Implemented path

`DurableRuntimeBudgetAdmission.reserve` returns a frozen snapshot only after the
usage-store transaction commits. It binds workspace, execution, attempt,
immutable plan ID/digest and reservation key to the actual allocation. A child or
remaining allowance can be smaller than the immutable plan ceiling. Replay
returns that original allocation without adding another reservation.

Lifecycle activities retain only admission-produced metadata and reject foreign
scope or ceilings before delegating runtime work. They copy and freeze the
snapshot before the subsequent asynchronous identity check. Direct Local runtime
start validates the binding before recording a dispatch intent. The plan and its
digest are unchanged.

The runtime SDK, managed Pi driver and process client preserve the allocation as
separate context. The process client validates attempt/execution/plan/ceiling
binding before input resolution or admission persistence. It also requires the
trusted resolver to read workspace identity from repository scope; Local resolves
this from the intact immutable ContextPackage pin. A foreign workspace or missing
scope resolver fails before durable admission or native input resolution. The
process client includes this context in its replay identity and gives the
resolver an immutable snapshot. Native
start snapshots its idempotency key and allocation before the asynchronous scope
lookup, so caller mutation cannot change the accepted replay identity. Native
commands, prompts and provider credentials are not augmented with this metadata.
Legacy starts that omit it retain their original admission fingerprint.

## Verification scope

Regression tests first reproduced missing SDK fields, absent admission return
values, dropped driver/resolver metadata, caller-supplied lifecycle authority and
direct-runtime effects occurring before validation. Focused tests then cover
clamped allocation, failed commit, replay, mutable-result isolation and invalid
identity/ceiling denial, including a direct-client foreign-workspace regression
found by both independent review lanes. Repository scope resolution checks exact
ContextPackage identity/digest and rejects corrupt content. The direct-runtime
cases use actual temporary SQLite persistence with a recording runtime;
resolver cases stop before launching a
native process. These are component and boundary tests, not deployed acceptance.

Current source builds use existing dependencies through read-only links, with
workspace references pointing to the current candidate rather than the primary
checkout's older builds. No dependency install or local Docker is required.

## Required follow-up

- This is an allocation ceiling, not a live remaining balance or permission to
  send a provider request. Accepted credits do not prove purchased funding.
- Enforce current reservation ownership, remaining money/tokens and trusted
  operator pricing before every actual provider send. Unknown authority or price
  must fail closed. Concurrent and ambiguous requests need durable holds.
- Native retry, compaction, branch-summary and idle cache-refresh paths need a
  common enforcement boundary. Existing installed-native HTTP evidence shows
  that a normal request extension hook alone cannot cover these paths.
- Complete canonical usage provenance, reconciliation and settlement without
  charging twice after terminal replay or recovery.
- Wire and prove remote Runtime Gateway and ACP consumers separately; this
  increment does not claim those adapters consume the optional allocation.
- Reproduce all original profile/provider/recovery requirements and obtain the
  independent frozen-candidate acceptance required by #188, #190 and #197.

The owner-selected Docker replacement for a VPS remains in force. This increment
does not close an M11 issue or approve the milestone.
