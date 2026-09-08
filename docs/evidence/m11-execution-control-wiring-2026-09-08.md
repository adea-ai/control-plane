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

## Remaining production path

- Local direct runtime dispatch now persists pending input/approval/permission requests
  before returning `awaiting_input`. Execution and attempt scope come from the accepted
  command/execution records, the allowed principal is the accepting service principal,
  and expiry is bounded by the execution deadline (or 15-minute fallback) and command
  retention. Runtime-supplied principals and prompt text are not trusted or stored.
- Local response dispatch now requires the exact durably recorded response ID, action,
  attempt/execution, and value. A permission `grant` maps to native approval. A focused
  direct-activity test uses SQLite and proves an unconfirmed response has zero runtime
  submissions before the domain service records an authorized response.
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
