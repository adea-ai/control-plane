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

CP-CONS-026 is partially verified. PostgreSQL and SQLite now create an approval-required proposal and its Interaction in a single database transaction. Concurrent dedupe creates one linked pair; interaction conflict or injected failure before commit rolls back the proposal and approval. The new SQLite adapter preserves the pair and versioned status reconciliation across database reopen, with no provider write replay in the fixture. MemoryWriteService still has no non-test application-composition consumer. Actual provider transport, process-loss crash/restart acceptance through provider authority across all required profiles, and complete proposal/interaction retention remain tracked in #194. The bounded transactional evidence does not certify whole-profile or whole-milestone acceptance. The follow-up [memory provenance retention evidence](../evidence/m11-memory-provenance-retention-2026-10-04.md) records source-reference retention in SQLite, transactional source-scope validation and immutable source/dedupe identity, plus the authored PostgreSQL race suite whose runtime proof remains pending.
