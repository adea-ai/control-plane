# Execution consistency source extraction

Source: [Execution Consistency & Event Delivery Specification](https://docs.google.com/document/d/1hba0jHco891TK4BHXZUZo07L3LZN8yDJ9Qw9UtzsIf4/edit), retrieved and revalidated through Google Drive on 2026-09-07; modified 2026-08-28T07:21:17.702Z. The source is an accepted cross-system technical specification.

CP-CONS-001 through CP-CONS-017 extract Control Plane obligations from sections 1, 4–6, 8–9, 14–16 and 20. All remain `tbd` for implementation verification. This report and the generated ledger are source evidence, not executable acceptance evidence. Existing broad TDD requirements remain; the new source-specific entries preserve exact retention, cache-identity and concurrency constraints that broad lifecycle statements do not establish.

## Ownership and remaining scope

Agent HQ owns the product CommandOutbox, EventInbox application, WorkspaceEvents, durable Message/ContentReplica synchronization and authenticated SSE gateway described in sections 3, 7 and 10–13. Do not implement a second product authority inside Control Plane or treat Control Plane runtime events as the client-facing WorkspaceEvent stream. M11 needs standalone consumer/transport conformance fixtures; M12 owns live cross-product integration.

The original 17 entries were not exhaustive extraction of the document. A read-only Google Drive revalidation on 2026-09-08 confirmed the same modified time, 2026-08-28T07:21:17.702Z. CP-CONS-018 through CP-CONS-032 now separately extract provider failure defaults, discovery authority, deterministic selection, read envelopes, revocation, substitution contracts, terminal disagreement precedence, reconciliation job safety, proposal/contribution recovery, provider error classifications, rejection/omission policy, trace continuity, diagnostics and content-safe telemetry from sections 8, 15.1, 16 and 17 (with substitution acceptance in section 18).

These 15 additions are accepted source obligations with implementation classification `tbd`, not newly verified runtime behavior. The source remains unchanged. Cross-system interface obligations, detailed event field mappings, remaining lifecycle details and a complete section 18 scenario-to-evidence mapping still require extraction/reconciliation. External Agent HQ observability and product events remain consumer-boundary obligations rather than authority to implement Agent HQ inside Control Plane. The existing retrieval/reconciliation umbrella and reopened #186 stay open. Historical candidate and reviewer metadata have not been relabelled as current-candidate evidence.

## Required verification

For each new entry, identify the authoritative implementation and test its exact invariant against a frozen candidate in Managed Cloud, Local, Hosted Simple and Hosted Server. Include crash-after-commit, reply loss, duplicate/conflicting delivery, concurrent writes, cancellation races, stale/revoked context and ambiguous external effects where relevant. Retention requires persisted policy and boundary evidence, not a passing immediate replay. Cache identity requires mutations of every named identity dimension. Historical issue closure and passing source-ledger validation do not prove these behaviors.

No deployment, permission, production identity or external product changes are authorized by source recovery.
