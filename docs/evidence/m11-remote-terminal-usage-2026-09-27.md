# M11 remote terminal usage checkpoint

Scope: M11.3 (#188), continuing the reported-usage contract at `5151123c`.
This is implementation evidence, not full profile acceptance or authorization
to settle financial charges. Seven original M11 issues remain open.

## Data path and trust boundary

Protocol v1.7 carries the field; the current supported protocol manifest now
includes 1.7. Known usage on an older peer is rejected by the Hosted bridge,
not silently omitted. Upgrade producers and consumers together before
activation. Older strict result/status parsers cannot read the new fields.
Drain or explicitly reconcile previously queued commands whose recorded
protocol is older than 1.7; upgrading binaries does not rewrite their durable
envelopes. Retain measured host results for reconciliation if an older command
cannot report them. Checkpoint state before activation; do not assume a
binary-only rollback after new strict status/event/outcome fields are persisted.
Previously persisted records and certified v1.6 candidates are not retroactively
certified at v1.7. Separate fresh reference-only Pi/ACP certification entries
are recorded for the current tested 1.7 fixture; historical entries are retained.
Managed Pi unsuccessful terminal statuses can now carry
`terminalUsage` without a completed result, preserving the existing result-only
success rule and rejecting terminal measurements on live states.

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

- Focused remote waiter: 19 passed, 0 failed, 25 assertions. The first run was
  17 passed/1 failed because the workspace-corruption fixture shared its
  correlation object with the execution; isolating the objects restored the
  intended rejection check without weakening the assertion.
- Full workflow worker suite: 79 passed, 0 failed, 262 assertions, 11 files.
- Gateway protocol suite: 14 passed, 0 failed, 91 assertions. Runtime-worker
  producer suite: 26 passed, 0 failed, 122 assertions. Managed Pi full suite:
  22 passed, 0 failed, 108 assertions; ACP: 107 passed, 0 failed, 493 assertions.
- M5 aggregate gateway target: 77 passed, 0 failed, 355 assertions.
- Final full gateway suite including byte-exact digest regressions: 125 passed,
  0 failed, 563 assertions, 13 files. Local regression suite: 80 passed,
  0 failed, 457 assertions, 16 files.
- Integrated gateway initially failed 9 context-result tests (114 passed,
  519 assertions) because Zod disallows `.pick()` on a refined result schema.
  The digest helper now individually validates its original semantic fields,
  including reconstructed Artifact frames without transport headers. This
  preserves the persisted hash format, proven by a byte-exact regression
  (2 passed, 5 assertions). The ensuing full gateway run passed 123 tests,
  558 assertions, before adding those two explicit digest regressions.
- Initial fresh-certification entries used a documentation source and suite
  name outside the registry vocabulary. Pi (21 passed/1 failed/106 assertions)
  and ACP (106 passed/1 failed/490 assertions) caught this. The entries now use
  existing executable evidence categories and paths; schema validation was not
  relaxed and historical 1.6 records were not rewritten.
- SDK matrix enumeration initially reported 68 passed/1 failed/259 assertions
  because it expected only the four historical entries. Its exact expectation
  now includes both new 1.7 reference entries and retains all historical
  entries and evidence assertions.
- Final full SDK suite: 69 passed, 0 failed, 289 assertions, 12 files.
  Protocol JSON schema generation/check, runtime compatibility, strict changed
  lint/format, frozen lock install, architecture (41 packages/16 operations/
  4 profiles) and live requirements (200 requirements/103 issue audits) pass.
  Reviewed architecture metadata adds only the protocol-to-SDK internal
  dependency; no acceptance classifications change.
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
