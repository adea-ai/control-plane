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

## Stale interaction state during remote control

Focused waiter regressions reproduced two incorrect outcomes: input/approval
waits returned the same already-answered interaction while its execution-state
event lagged; a succeeded cancellation returned an old interaction instead of
cancellation confirmation. The waiter now extracts the answered interaction ID
from the validated control command and waits past that specific interaction.
Cancellation ignores nonterminal interaction state while still honoring terminal
execution state, command failure/confirmation, and durable expiry. A distinct
subsequent interaction remains observable. All six focused waiter tests pass.
These are controlled repository observations, not additional live-runtime proof.

## Interaction lookup beyond the replay page

The remote waiter now queries the latest unarchived interaction for the exact
execution and attempt instead of scanning only the first 1,000 events. The
PostgreSQL regression inserts a history with an interaction at sequence 1,004:
the former first-page query misses it, while the scoped lookup finds it and
excludes another attempt and an archived interaction. All 25 database integration
tests and the complete integration command passed, including the remote drill
and database outage, restart, and restore checks. All six focused waiter tests
also passed. This is correctness evidence, not a measured performance claim or
full native-runtime acceptance.

## Cancellation interaction after the attempt deadline

A regression reproduced `REMOTE_RUNTIME_COMMAND_EXPIRED` when constructing a
durable cancellation interaction after the attempt deadline. Unlike explicit
cancellation, this path inherited the execution lease. It now uses the same
five-minute cancellation delivery window, retaining the durable response's
original `requestedAt`. Input, grant, and deny still reject an expired attempt.
All 12 command-factory tests passed after the fix (one failed before it).
This proves construction only; remote cancellation delivery and native stop
confirmation remain separate acceptance gates.

## Cancellation delivery and acknowledgement

The PostgreSQL remote drill now explicitly advertises `execution.cancel`, sends
the queued cancellation over the authenticated WebSocket, checks its handle and
original request timestamp, and waits for the persisted acknowledgement. Eight
retries after advancing the factory clock beyond the original five-minute lease
retain the acknowledged record without another socket command. The node and
cancellation waiter remain scripted, and this scenario deliberately follows
execution completion. It proves transport and immutable replay, not cancellation
of active native work or a public cancellation API.

## Cancellation confirmation is required

The remote runtime previously discarded the outcome returned by its cancellation
waiter. Since a normal return authorizes the workflow to persist cancellation,
expired or failed delivery could incorrectly appear successful. Four regressions
failed before the fix: expired command, failed command, pending input, and
competing completion. The runtime now rejects each with
`REMOTE_RUNTIME_CANCELLATION_UNCONFIRMED`; only a cancelled outcome permits a
normal return. All 10 focused remote-runtime tests pass. This fail-closed boundary
does not implement reconciliation for competing terminal state or expired delivery;
those remain required before full cancellation convergence can be certified.

## Late cancellation confirmation recovery

A combined regression uses the production lifecycle function, durable remote
runtime, and polling waiter with an in-memory command repository. An expired
command while execution remains running rejects cancellation without terminal
status or cleanup. After a controlled repository observation changes to cancelled,
a reconstructed runtime completes the workflow retry, records cancellation once,
and runs cleanup once without replacing or renewing the original command. The
dispatch result and execution observations are controlled; this is not a Restate
restart, database integration, or native-runtime cancellation certification.

## Execution-level cancellation contract groundwork

`ExecutionCancellationCommandSchema` defines `execution.cancel` independently of
a pending interaction. It requires command identity, caller, workspace/project,
issuance timestamp, and execution ID; its strict payload rejects caller-selected
attempts, native handles, routing, leases, and privileged reasons. The result
schema permits only accepted/replayed acknowledgement, not a claim that native
work stopped. Three focused tests (28 assertions) pass. These exported schemas
are groundwork only: no public route, SDK method, durable cancellation receipt,
authorization implementation, or composition wiring is claimed by this change.

## Execution cancellation authorization and replay service

`DurableExecutionCancellationService` now checks the authenticated caller against
the accepting principal and both accepted-command and execution workspace/project
scope before receipt access or dispatch. It reserves an immutable first request,
compares actual target payload rather than trusting a supplied hash, and sends
that stored identity on retries. A confirmed receipt replays without another
signal; an unconfirmed receipt can reconcile a lost ACK after terminal state.
New cancellation of already-terminal work is rejected. Tests cover lost ACK with
service reconstruction, ownership rejection without reservation, concurrent
first-writer identity, terminal admission, and conflicting stored targets.

These tests use an in-memory receipt fixture and recording dispatcher. Production
SQLite/PostgreSQL receipt implementations, Restate cancellation dispatch, HTTP/SDK
entrypoints, and composition wiring remain unfinished. The service does not claim
atomic ordering between execution termination and cancellation admission.
