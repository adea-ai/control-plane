# M11 PostgreSQL interaction command wiring

The managed-cloud and hosted-server API compositions now supply
`DurableInteractionCommandService` with PostgreSQL interaction records,
PostgreSQL command receipts, accepted-execution ownership lookup, and the shared
Restate signal dispatcher. Explicit API service overrides retain precedence.
Previously, these profiles defaulted to the unavailable response service even
though their workers persisted interaction requests.

Migration `0034_interaction_commands.sql` adds a receipt table with a hashed,
principal/workspace/project/operation/idempotency scope key. Transaction-scoped
advisory locks serialize reservation and acknowledgement for the same key.
The first immutable request wins, and subsequent acknowledgements preserve its
first accepted timestamp. Reads validate the stored request scope and indexed
workspace/project fields. Reservation rejects preconfirmed receipts.

`bun run test:integration` passed against a task-owned PostgreSQL 18.3 container,
not production or Neon. The new repository integration test verifies concurrent
reservation, repository reconstruction, duplicate reservation after acceptance,
first-ACK preservation, missing receipt rejection, preconfirmation rejection,
and caller/project scope separation. Existing PostgreSQL service-restart and
backup/restore drills also passed; those drills do not specifically restore the
new interaction receipt table's contents.

Composition tests verify both profiles construct the durable service. These are
not a substitute for a full authenticated HTTP + remote RuntimeNode approval
execution. That scenario, live deployed-profile verification, command retention
and reconciliation, and all broader M11 acceptance gates remain open. Architecture
profile dispositions remain partial; only changed composition digests were
refreshed.
