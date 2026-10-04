# Execution consistency source extraction

Current source: [Execution Consistency & Event Delivery Specification](https://docs.google.com/document/d/1hba0jHco891TK4BHXZUZo07L3LZN8yDJ9Qw9UtzsIf4/edit), revision 27, reviewed from the 2026-09-30 Drive capture. Revision modified `2026-09-29T02:02:18.414Z`; file modified `2026-09-29T02:02:18.460Z`. Its exact fetched-text SHA-256 is in the [current-source inventory](control-plane-source-inventory.md). The source is an accepted cross-system technical specification.

Comparing revision 27 with revision 26 found one change in section 20: Local uses the embedded SQLite durable queue by default without a Restate process; Local Restate is an explicit compatibility option. The source also distinguishes Hosted/cloud and Self-hosted Restate profiles from the Local default. This refresh records the source change, not new implementation evidence.

The initial extraction covers Control Plane obligations from sections 1, 4–6, 8–9, 14–16 and 20. Implementation classifications are maintained per requirement in the ledger; they are not uniformly `tbd`. This report and the generated ledger are source evidence, not executable acceptance evidence. Existing broad TDD requirements remain; the source-specific entries preserve exact retention, cache-identity and concurrency constraints that broad lifecycle statements do not establish.

## Ownership and remaining scope

Agent HQ owns the product CommandOutbox, EventInbox application, WorkspaceEvents, durable Message/ContentReplica synchronization and authenticated SSE gateway described in sections 3, 7 and 10–13. Do not implement a second product authority inside Control Plane or treat Control Plane runtime events as the client-facing WorkspaceEvent stream. M11 needs standalone consumer/transport conformance fixtures; M12 owns live cross-product integration.

The original 17 entries were not exhaustive extraction of the document. A read-only Google Drive revalidation on 2026-09-08 confirmed the then-current modified time. A later bounded extraction adds 15 separate obligations for provider failure defaults, discovery authority, deterministic selection, read envelopes, revocation, substitution contracts, terminal disagreement precedence, reconciliation job safety, proposal/contribution recovery, provider error classifications, rejection/omission policy, trace continuity, diagnostics and content-safe telemetry from sections 8, 15.1, 16 and 17 (with substitution acceptance in section 18).

These 15 additions are accepted source obligations; current implementation classifications are recorded per row and source refresh does not promote them. The revision 27 change is reflected in CP-CONS-017's profile distinction, while detailed section 20 extraction remains incomplete. Cross-system interface obligations, detailed event field mappings, remaining lifecycle details and a complete section 18 scenario-to-evidence mapping still require extraction/reconciliation. External Agent HQ observability and product events remain consumer-boundary obligations rather than authority to implement Agent HQ inside Control Plane. The existing retrieval/reconciliation umbrella and reopened #186 stay open. Historical candidate and reviewer metadata have not been relabelled as current-candidate evidence.

## Required verification

[The section 18 acceptance map](./execution-consistency-acceptance-map.md) now records all 15 baseline scenarios, ledger references where extracted, ownership boundaries, inspected test starting points and missing proof. All scenarios remain unverified at their full scope; mapping a scenario is not acceptance evidence.

For each new entry, identify the authoritative implementation and test its exact invariant against a frozen candidate in Managed Cloud, Local, Hosted Simple and Hosted Server. Include crash-after-commit, reply loss, duplicate/conflicting delivery, concurrent writes, cancellation races, stale/revoked context and ambiguous external effects where relevant. Retention requires persisted policy and boundary evidence, not a passing immediate replay. Cache identity requires mutations of every named identity dimension. Historical issue closure and passing source-ledger validation do not prove these behaviors.

No deployment, permission, production identity or external product changes are authorized by source recovery.

## Ledger traceability

The machine ledger links this document through source ID `execution-consistency-spec`. Its currently extracted rows are `CP-CONS-001` through `CP-CONS-017` and `CP-CONS-018` through `CP-CONS-032` (32 rows). Coverage remains partial; this list is not a declaration that the external specification was exhaustively extracted. The ledger validator checks that these documented ranges and source rows stay aligned. This refresh records revision 27 and the profile distinction; it does not establish implementation acceptance.

## Memory proposal evidence scope

The 2026-10-03 memory-writeback correction adds library regressions for immutable proposal identity, terminal approval replay and persisted `committing` reconciliation. Authoritative provider status can settle an interrupted write after expiry; unknown or unavailable status remains parked and never triggers another write. Concurrent recovery retains the repository compare-and-set boundary.

CP-CONS-026 is partially verified. PostgreSQL and SQLite now create an approval-required proposal and its Interaction in a single database transaction. Concurrent dedupe creates one linked pair; interaction conflict or injected failure before commit rolls back the proposal and approval. The new SQLite adapter preserves the pair and versioned status reconciliation across database reopen, with no provider write replay in the fixture. The [memory application composition follow-up](../evidence/m11-memory-composition-2026-10-04.md) adds disabled-by-default programmatic consumers in all four roots with server policy and a separate current effect-authority port. PR #891 passed all five required gates and actual PostgreSQL integration at `a903256111d5bec56d9a7a06587ee5b6fc5d8971`. Its Cloud and Hosted Server root-reconstruction cases passed in [run 37172437678](https://github.com/adea-ai/control-plane/actions/runs/37172437678); this is synthetic-provider root evidence, not live-profile acceptance. No memory HTTP/local IPC surface or real provider transport is supplied. Actual provider transport, process-loss crash/restart acceptance through provider authority across all required profiles, and complete proposal/interaction retention remain tracked in #194. The bounded transactional evidence does not certify whole-profile or whole-milestone acceptance. The follow-up [memory provenance retention evidence](../evidence/m11-memory-provenance-retention-2026-10-04.md) records source-reference retention in SQLite, transactional source-scope validation and immutable source/dedupe identity, plus the PostgreSQL race suite that passed on `48f6980a` in [CI run 37168042195](https://github.com/adea-ai/control-plane/actions/runs/37168042195). The later integration-inventory repair still requires final-head full CI.

The 2026-10-04 [approved-intent follow-up](../evidence/m11-memory-approved-intent-2026-10-04.md)
pins every effect input and the approval link during all three repository CAS transitions.
Focused in-memory/SQLite tests include rejected input changes and reopen/commit of the
original approved payload. PostgreSQL and full CI proof are pending. Existing stored data,
real provider authority/transport and application composition remain outside this source
proof; no historical ledger classification is promoted.

## Memory process-loss follow-up

The [hard-stop fixture evidence](../evidence/m11-memory-process-loss-2026-10-04.md) adds actual
child-process `SIGKILL` after a durable synthetic provider effect, before the root stores its
outcome. Local and Hosted Simple reopen actual SQLite with fresh writes disabled and only
current status authority, preserve the entire approved intent, and recover exactly one effect.
Cloud and Hosted Server cases are wired into their existing isolated PostgreSQL integration
files; candidate PostgreSQL results remain pending. All new process cases belong to integration,
with explicit shard ownership and fixture cleanup even when storage close fails.

The 2026-10-04 native Docs read also observes source metadata modified on 2026-10-01. It supports
the existing interrupted-proposal status and durable-identity obligations; accepted invariants
are unchanged. Some implementation-gap annotations in that newer capture lag the merged
memory repairs. Complete source reconciliation and remaining scenario mapping still belong
to #186/#195. This records scoped current evidence without relabelling the historical frozen
candidate, claiming live-provider authority, or promoting CP-CONS-026 beyond partially verified.
