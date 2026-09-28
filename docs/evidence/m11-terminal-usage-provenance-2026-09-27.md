# M11 terminal-usage provenance checkpoint — 2026-09-27

Partial M11.3 accounting-path implementation, not milestone acceptance,
source authorization, settlement, or deployment proof. Original issues #188,
#190, #191, #194, #195, #196 and #197 remain open.

## Contract and data path

Runtime usage optionally reports strict, versioned accounting provenance:
`sourceId`, explicit funding source, USD charged microunits and `costExact: true`.
Consumers must independently verify the source authority before charging; a
schema-valid assertion is not authorization. An allowance remains an execution
ceiling, not prepaid funds or actual spend.

Externally funded execution reports zero Control Plane charge, but retains its
optional provider-cost report. Zero HQ charge does not establish a free provider.
For HQ reports containing both cost forms, decimal USD cost must exactly equal
charged microunits; no floating-point rounding, nonzero sub-microunit precision,
unsafe integer or oversized exact-reconciliation input is accepted. Legacy
usage without accounting remains supported; missing provenance stays unknown.
Individual usage counters and their combined token total must be safe integers.

Local completed, failed, timed-out and cancelled outcomes now carry observed
terminal usage. Existing native usage receipts still precede artifact publication
and cleanup. The shared lifecycle retains the validated usage in its terminal
result, and the embedded queue outcome schema persists it across SQLite close
and reopen. A terminal control decision after a measured result does not erase
the measurement. These records are reported evidence, not charged ledger rows.

Malformed accounting cannot prevent active cancellation: cancellation precedes
validation in that terminal-control branch, while invalid evidence still blocks
terminal status/result commit. Normal terminal validation likewise precedes its
terminal status commit. Local effect writes explicitly serialize their validated
outcomes through the existing JSON boundary instead of assuming nested optional
TypeScript fields are already `JsonValue`.

## Verification and failures

- Integrated terminal evidence tests: 14 passed, 0 failed, 72 assertions.
  Includes cold queue outcomes for completed/failed/cancelled, Local failed,
  timed-out and cancelled replay, external provider-cost preservation, completed
  lost-artifact recovery, cancellation lost-effect recovery, malformed evidence,
  missing usage and cancellation ordering.
- Full final SDK: 69 passed, 0 failed, 279 assertions across 12 files.
- Full workflow runtime: 50 passed, 0 failed, 164 assertions across five files.
- Full final Local: 80 passed, 0 failed, 457 assertions across 16 files.
- SDK, workflow-runtime, Local, worker and Hosted TypeScript builds pass.
  Runtime compatibility, strict changed-source lint and frozen-lock installation
  pass. Reviewed architecture metadata adds one internal workflow-runtime SDK
  dependency; classifications remain unchanged.

Pre-integration tests produced 4 passes and 6 failures because the old SDK
correctly rejected the new accounting field. The new cancellation-ordering test
first failed with zero active cancellation calls, then passed after moving
validation after cancellation. Integration found a Local effect-cache TypeScript
serialization mismatch and two authored unsuccessful-status fixtures missing
their required error object; both were corrected without weakening schemas.
An initial full Local run was 78 passes and 2 fixture failures; final results above
supersede it. Luna's full SDK suite predated its last parser bound/type alias;
root reran the complete final SDK after integration.

## Rollout and remaining gates

No database schema migration or automatic historical backfill is introduced.
Upgrade producers and consumers together before emitting the optional accounting
field. Older strict SDK/queue parsers do not support the new fields; checkpoint
Local state before activation, and do not assume binary-only rollback after new
queue outcomes are written. Old outcomes without usage remain unknown.

Per-attempt reservation before external execution, graph/node/child allocation,
source-authorized monetary charging, all-outcome settlement, remote terminal
usage transport and replay, runtime enforcement of per-attempt bounds,
extensions, usage retention/aggregate fences/restore/capacity and supported live
profile certification remain required. Do not finalize unknown charges at zero.
No staging/production deployment, issue closure, merge or full-goal completion.
The bounded Luna worker and root runners are settled; unfinished checkouts and
the stopped existing local PostgreSQL volume remain owned by the ongoing goal.
