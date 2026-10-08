# Retained child report-back increment

This additive increment addresses the terminal-outcome/publication crash window in
`DelegationService`. It is preparation for the approved Pi Durable first slice;
it does not qualify a Pi runtime or enable new admissions.

A completed, failed or cancelled child persists a pending terminal-publication
receipt in the same delegation compare-and-set as its terminal state. The receipt
contains only a stable publication key, status and bounded failure/cancellation
metadata. The original outcome references and observation time remain authoritative.
The sender acknowledges publication only after the parent inbox accepts it.

`DelegationEventPublisher.publish(event, idempotencyKey)` must atomically retain and
deduplicate delivery. A publisher that ignores the key does not meet the recovery
contract. `SqliteDelegationEventPublisher` supplies a persistent parent-scoped inbox
with duplicate suppression and payload-conflict rejection. Its strict event schema
rejects prompt and credential payload fields. It does not invoke a model, send tools
or write the user-visible Adea timeline.

Recovery calls `reconcileChildPublications(parentExecutionId)` through the existing
authorized parent scope, without requiring a lead model turn. Product timeline
delivery still needs its own current audience check and publication receipt. The
SQLite inbox is not a substitute for that authorization boundary. Composition must
provide the correct parent scope and arrange recovery wake-ups.

The tested persistence profile for this increment is the existing SQLite provider
on a local filesystem. Reopen and concurrent redelivery tests cover inbox persistence;
service fault injection covers publication failure and a crash after inbox commit
before sender acknowledgement. This is not Cloud PiHarness deployment qualification,
PostgreSQL integration evidence, or a live-provider test. The first-slice Cloud
adapter, model eligibility/funding, durable human-message dispatch and Adea UI remain
separate implementation work. Restate, LangGraph and managed Pi stay available.

Legacy terminal delegations have no trustworthy publication receipt and are not
automatically republished. They require an explicit evidence-based reconciliation.
Nonterminal dispatch/progress events and manual-intervention outcomes retain their
existing behavior; this change does not claim they all have an atomic outbox.

Rollback retains the additive receipt fields and inbox records. Older strict-schema
readers must not receive records carrying the new field until they are upgraded.
Do not delete inbox records while timeline delivery or effect reconciliation remains
unsettled. Inbox retention/export integration and production composition are required
before enabling this path for a launch cohort.
