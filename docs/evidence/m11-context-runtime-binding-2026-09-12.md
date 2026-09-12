# RuntimeNode context binding boundary

The Cortana-compatible adapter previously fabricated a node ID, trace ID, command
ID, channel generation, sequence, and authorization reference. Its idempotency key
was fixed per provider. A regression reproduced sending a context command with no
configured authorization binding (10 pass, 1 fail).

## Implemented boundary

RuntimeNode transport now requires a composition-owned `bindRuntimeNodeRead` port.
The port supplies the authorized node/channel/sequence, trace, command identity,
idempotency key, authorization reference, provider/workspace/principal/scope, and
grant expiry. The adapter validates these fields and matches the grant scope to
the requested read. Missing, invalid, mismatched, or expired grants fail before
client access. Binding inputs and client requests are cloned across trust boundaries.

The binding port owns durable identity allocation and must honor its abort signal,
including cleanup of any late allocation. The adapter allocates one binding per
retrieval, reusing it for retries rather than allocating another command. Distinct
logical reads require distinct identities from that port; replay semantics belong
to its durable implementation, not an adapter-local counter.

The gateway payload includes project mapping, objective, principal, scope,
capability, token/age bounds, and evidence/memory flags. Its digest also binds the
node, workspace, provider, authorization reference, operation, driver, and required
capabilities. The command deadline cannot exceed the grant or request deadline.
Binding and read waits are bounded, including ports that ignore cancellation;
elapsed time uses a monotonic clock and retries share the remaining read budget.
Timeout signals do not prove that an uncooperative external service has stopped.

RuntimeNode contribution-cache reuse is disabled at this adapter boundary so it
cannot bypass a fresh authorization binding. Pinned HTTP/MCP reuse remains supported
with the existing explicit revision/configuration identity contract.

## Verification and limits

The focused initial green suite passed 17 tests with 79 assertions, including
malformed/cross-scope/expired grants, retry identity stability, distinct reads,
payload-hash changes, bounded authority/client waits, deadline narrowing, error
sanitization, and cache authorization bypass prevention. Fixtures explicitly supply
their own bindings; there are no fixture command defaults in production code.

This is **not** a complete remote deployment path. The existing
`RuntimeCommandDeliveryService.enqueue` and `RuntimeCommandRecord` accept runtime
execution commands requiring execution/attempt/RuntimeConnection identities, not
context-provider commands. Production completion requires dedicated or properly
generalized durable context-command delivery, an authorized binding implementation,
composition wiring, and live profile acceptance. Do not invent execution IDs or a
RuntimeConnection to force context reads through the runtime-only persistence model.
Milestone 11 remains open.
