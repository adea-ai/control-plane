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

## Authenticated HTTP restart and lost-ACK regression

The Cloud integration suite now exercises the actual TCP response endpoint with
an Ed25519 service credential and the real Cloud composition backed by isolated
PostgreSQL. A seeded accepted execution and pending permission establish the
test preconditions; plan validation and native execution are not covered here.
A loopback HTTP fixture records the Restate signal and closes its first response
without acknowledging it. The API returns 503 but retains both the interaction
response and unconfirmed command receipt.

After closing the API application and its PostgreSQL connection, a new
composition receives a retry with a different command ID. It sends the original
response ID and identical signal idempotency key, accepts the fixture's
`PreviouslyAccepted` response, and persists acknowledgement. A further replay
sends no signal. Altered payloads return 409; invalid authentication returns 401
and a project outside the credential's scope returns 403. The regression uses
real HTTP and storage, but its Restate responder is simulated. It does not prove
remote RuntimeNode approval execution or live deployment parity.

## Remote command construction replay

The real `ManagedPiRemoteCommandFactory` and `DurableRemoteWorkflowRuntime` now
have a combined regression for grant, deny, and input. Eight concurrent retries
after advancing the factory clock retain the first queued command and issuance
time, without renewing its lease. Grant/deny map to the expected approval
decision, input retains the stored text, and a different response ID is rejected
before the outcome waiter is invoked again. This uses an in-memory command
repository and a scripted outcome waiter; it proves command construction/replay,
not WebSocket delivery or runtime completion. The retries are before the attempt
deadline. Post-deadline reconciliation remains a separate acceptance case.

## PostgreSQL and authenticated WebSocket approval drill

`bun run test:integration` passed with this extension on 2026-09-08, including
the PostgreSQL connection-loss, restart, and backup/restore drills.

`scripts/run-cloud-remote-drill.mjs` now seeds an authorized permission response,
uses the production remote command factory and PostgreSQL command repository to
queue `runtime.approval`, and delivers it through the authenticated gateway
WebSocket. The scripted node checks the command's handle, interaction ID, and
`approve` decision, then sends an acknowledgement. The drill waits for the
durable acknowledged state before submitting its scripted execution result.
Approval replay must retain the same command record and not add another received
socket command. The fixture explicitly advertises `interaction.approval`.

This extends transport evidence, not native-provider certification: the
permission response is seeded instead of originating from a native runtime,
the node and terminal result are scripted, and Restate is not exercised by this
drill. The authenticated public API, Restate workflow, gateway, and a real
runtime still need to be proven together for full managed-cloud acceptance.
