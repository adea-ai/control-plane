# M11 remote terminal usage checkpoint

Scope: M11.3 (#188), continuing the reported-usage contract at `5151123c`.
This is implementation evidence, not full profile acceptance or authorization
to settle financial charges. Seven original M11 issues remain open.

## Data path and trust boundary

Gateway result frames carry optional validated `terminalUsage`. The gateway
validates the active channel, persisted command, execution, attempt, node,
runtime connection, payload hash and replay generation before writing a terminal
event. Reserved `terminalUsage` and `runtimeUsageSource` payload keys cannot be
supplied by an adapter normalizer: they are reconstructed from the wire frame
and the persisted command binding. Existing event sanitization remains enabled.

PostgreSQL stores the terminal transition and event in its existing transaction.
Its terminal reader selects only unarchived terminal events for the requested
execution and attempt. The shared Cloud/Hosted remote waiter validates the event
schema, stored payload hash, terminal state, four-part scope, originating command,
node, runtime connection and channel generation before returning reported usage.
Interaction-control commands may differ from the originating result command;
the waiter checks the latter against its durable command record.

Missing legacy usage, command acknowledgements, expiry and progress usage are
not converted into terminal measurements. Missing measurements remain unknown.
No monetary ledger write, reservation, historical backfill or funding-source
authorization is introduced. A reported `accounting.sourceId` remains a claim;
authenticated runtime-channel attribution does not prove financial authority.
Telemetry redaction can alter sensitive reported strings, another reason not
to use these event payloads as an authoritative billing record.

## Verified checks

- Focused remote waiter: 18 passed, 0 failed, 24 assertions. The first run was
  17 passed/1 failed because the workspace-corruption fixture shared its
  correlation object with the execution; isolating the objects restored the
  intended rejection check without weakening the assertion.
- Full workflow worker suite: 78 passed, 0 failed, 261 assertions, 11 files.
- Real migrated PostgreSQL terminal sink/reader regression: 1 passed, 0 failed,
  21 assertions; 62 unrelated tests filtered out. Recreated reader retained the
  winning completion/cancellation race measurement, duplicate delivery remained
  idempotent, and another attempt returned no event. This is repository
  recreation, not a deployed process-restart drill.
- Database non-integration run: 33 passed, 131 skipped, 0 failed, 123 assertions.
  Those skips are not claimed as PostgreSQL coverage.
- Gateway, workflow worker, database and Hosted TypeScript builds passed.
  Gateway intermediate builds caught optional-JSON typing and an undeclared
  Zod import; final code uses the existing event payload schema without adding
  a gateway dependency.

## Remaining acceptance work

The terminal bridge is currently exported and fixture-tested, not invoked by
the production runtime-worker startup. A real remote producer/channel must be
wired and advertise/negotiated at the new wire version before live activation.
Do not mistake fixture bridge results or the repository-level regression for
complete Cloud/Hosted end-to-end behavior. Test the final integrated wire schema,
producer, gateway and consumers, then exercise actual cold process recovery.

Financial settlement still requires independently authorized funding/cost
provenance and bounded per-attempt reservations before both direct runtime
dispatch and graph entry. Never reserve the entire parent allowance in a way
that starves graph children; preserve unresolved reservations during ambiguous
launch/reconnect. Unknown cost must remain unknown, not zero or a plan-derived
price. All original M11 security, adversarial, reliability, documentation,
Skills and independent/manual acceptance gates remain in scope.

No production deployment or staging activation was performed. The task-owned
local PostgreSQL fixture was stopped after isolated database disposal (zero
test databases remained); its volume is retained for unfinished milestone work.
