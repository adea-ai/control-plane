# Execution-control wiring status

This is a partial M11.3 audit and implementation record, not feature acceptance.

## Existing and added persistence

PostgreSQL already implements `PostgresInteractionRepository` in
`packages/database/src/interaction-repository.ts`; Cloud and Hosted workers use it.
The earlier issue comment claiming no durable interaction repository existed was
incorrect and has a correction posted on #188.

SQLite now implements the same `InteractionRepository` contract, exposed through
Local composition's `interactions` repository. It uses the existing transactional
record store under `interaction-requests`, with hashed logical IDs and validated
domain records. Updates preserve immutable request identity, principal allowlist,
prompt, kind, and expiry, matching PostgreSQL's update projection.

Focused tests exercise pending state across reopen, unauthorized/stale response
rejection through `InteractionService`, eight concurrent duplicate responses,
answered-state replay after reopen, stale CAS rejection, and immutable scope.
No schema migration or new database dependency is required for SQLite's generic
record store.

SQLite also has an attempt-scoped lookup index. The first insert or lookup backfills
pre-index rows and writes a completion marker in the same transaction; subsequent
inserts atomically write both the request and its pointer. Normal lookups read only
the exact execution/attempt namespace and then reread primary records. The one-time
backfill still reads all retained interaction rows; large-history migration latency
and index retention/export policy have not been certified.

## Remaining production path

The public `interaction.respond` command/result schemas now define complete command
and attempt scope, strict authority fields, the domain-equivalent 8 KiB UTF-8 JSON
input limit, and a signal-acceptance acknowledgement that cannot claim execution
completion or include private response content. The authenticated API route is now
`POST /v1/interactions/respond`, requiring `interaction:respond`; the SDK operation
is still outstanding. A caller/workspace/project/operation/idempotency-key-scoped SQLite
receipt repository retains the first command identity under concurrent reservation
and restart, and separately records confirmed signal acceptance. The command service
now authorizes before reservation or receipt replay, compares actual payloads rather
than trusting the caller-supplied hash, and rejects conflicting key reuse. Confirmed
receipts replay after completion without another signal; unconfirmed active attempts
retry with the original response ID. SQLite tests cover lost ACK, reopen, receipt-write
failure and concurrent different command IDs. Automatic reconciliation, PostgreSQL
receipts and receipt retention/export are not implemented yet.

`DurableInteractionDeliveryService` supplies the shared response
boundary. It checks accepted-command and execution workspace/project scope, exact
interaction execution/attempt ownership, allowed principal, and active/latest attempt
before recording the response. Caller-supplied principal/timestamp fields are rejected;
the authenticated principal and service clock supply them. It signals only the stored
response, leaving that record available for explicit retry after ambiguous delivery.
This is not an automatic recovery worker or an atomic execution/response transaction.

The Restate dispatcher supports the shared interaction handler with an interaction/response-ID
idempotency key. It requires HTTP 202 plus a validated invocation ID and `Accepted`
or `PreviouslyAccepted`, matching [Restate 1.7.8 ingress source](https://github.com/restatedev/restate/blob/v1.7.8/crates/ingress-http/src/handler/service_handler.rs#L370).
HTTP 409 remains a supported workflow-start replay only, not an accepted interaction
signal. Tests cover exact-body retry, preserved response identity after a lost ACK,
cross-scope answered replay rejection, spoofed principal, inactive/replaced execution,
and invalid dispatch status. Local composition now wires the command service into
the API; profiles without a configured service return 503. Authenticated route tests
cover missing credentials, missing scope, wrong workspace/project and safe error
normalization. A full native-interaction run through this HTTP route, SDK/relay
wiring, and the remaining profile compositions are still outstanding.

- Local direct runtime dispatch now persists pending input/approval/permission requests
  before returning `awaiting_input`. Execution and attempt scope come from the accepted
  command/execution records, the allowed principal is the accepting service principal,
  and expiry is bounded by the execution deadline (or 15-minute fallback) and command
  retention. Runtime-supplied principals and prompt text are not trusted or stored.
- Local response dispatch now requires the exact durably recorded response ID, action,
  attempt/execution, and value. A permission `grant` maps to native approval. A focused
  direct-activity test uses SQLite and proves an unconfirmed response has zero runtime
  submissions before the domain service records an authorized response.
- Request creation and response validation also reread current execution state and
  require the same latest attempt in `running` or `awaiting_input`. Regression tests
  reject completed, failed, cancelled, timed-out, cancelling, reconciliation-required,
  and replaced-attempt cases. This rejects already-observed terminal state; it is not
  a claim of atomic ordering against a concurrently arriving terminal update.
- Direct runtime cleanup now resolves pending records for its exact attempt before
  runtime release. It preserves answered/expired/cancelled history and uses the
  existing version-conditional domain transition. Regression tests cover backfill,
  reopen, attempt isolation, answered-history preservation, and cleanup replay.
  A concurrent response CAS may cause cleanup to retry; this does not establish
  atomic ordering against late request creation.
- Verify this request/response bridge through real native pending interactions and
  restart, including terminal cleanup of pending records and user-visible prompt details.
- Compose the existing domain interaction service with authenticated, workspace-safe
  command handling and durable signal delivery/reconciliation.
- Implement the production relay control port and public API/SDK operations.
- Verify terminal-result precedence, stale/answered responses, wrong workspace and
  principal rejection, lost acknowledgement, restart, and cross-profile behavior.
- Include live interaction state in any declared cross-profile migration contract;
  the new repository does not itself extend portable export categories.

Internal Restate cancellation probes are not evidence for a public cancellation API.
