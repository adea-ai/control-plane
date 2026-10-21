# Runtime operations measurement lifecycle (#1030)

This document covers the bounded lifecycle, the SQLite producer adapter, the
Hosted PostgreSQL producer, and the Local composition wiring that starts the
measurement with the composition. Composition integration is a dependency, not
evidence that live Local or Hosted processes already emit measurements. The
offline report and existing emitter are unchanged.

## Composition integration (Local)

The Local composition starts the operations measurement itself, so the
measurement exists wherever the Local profile exists:

- `operationsMeasurements` on the composition options carries the workspace
  scope, the cadence and the bounded pass and close budgets. The measurement
  needs **both** a workspace scope and a metric adapter; without an adapter
  nothing is sampled, exactly like the consistency metrics, so starting the
  process is never a measurement side effect. `operationsMeasurementConfigured()`
  reports whether a measurement exists.
- The measurement starts with the composition, after migrations and a successful
  runtime startup. A failed startup closes it and leaves no measurement running.
- A start attempt after a failed startup builds a fresh lifecycle from the same
  inputs, instead of reporting a measurement that can never run.
- The measurement is closed before persistence is shut down, so an active pass is
  drained or aborted while the store it reads is still open.
- The reconciliation scheduler and the retention sweep are injectable as
  `LocalDrainableResource`, so the composition's close contract can be exercised
  directly without replacing the configured instances.

The measurement never writes, and it observes the store read-only. The
qualification of the redundant-layer retirement gate is a separate control and is
documented in
[`redundant-layer-retirement-qualification.md`](redundant-layer-retirement-qualification.md).

## Composition contract

- Configure an explicit workspace and `MetricAdapter`; absence enables nothing.
- Construct `createLocalRuntimeMeasurements` with the composition's SQLite path,
  adapter, cadence and the existing operations-report bounds. It supports Local
  and Hosted Simple SQLite, not Hosted PostgreSQL.
- Start after migrations and successful runtime startup. Close on startup failure
  and before persistence shutdown; close drains an active scan for at most
  `closeTimeoutMs`, then aborts it (see Cancellation and deadlines).
- The shared `OperationsMeasurementLifecycle` also accepts an asynchronous scoped
  producer. An unavailable producer returns `undefined`, never synthetic zeros.
- The cadence is an integer between 1 second and 24 hours. The lifecycle emits at
  most 512 points per pass by default (configurable from 1 to 1024). Concurrent
  passes coalesce instead of queueing unbounded scans.

The SQLite adapter opens a separate read-only handle in a worker for each pass
and measures inside one read transaction. The pass resolves only after the
worker exits, so Bun's retained native statements cannot keep a read snapshot
alive during checkpointed shutdown. Bun source runs select the source worker
even when a concurrent build has produced a compiled worker. Installed Node
execution uses the compiled worker. It retains only the last complete storage baseline.
The first pass has no growth point; later complete snapshots may emit signed
growth through the existing gauge path. The report still suppresses points from
partial or unsafe sources. Neither correlations nor errors become metric labels.

## Cancellation and deadlines

`OperationsMeasurementLifecycle` bounds both a pass and shutdown.

- `measure` receives `{ signal }`, an `AbortSignal`. Existing zero-argument
  producers keep working; a producer that ignores the signal is still bounded
  from the lifecycle's side.
- `passTimeoutMs` (default 60 s, 10 ms to 10 min) is the longest one pass may
  run. At the deadline the pass is aborted and abandoned: `sample()` resolves
  (it never rejects and never waits longer), and the pass's late result is
  discarded, never emitted, even if the producer settles afterwards. The
  deadline timer does not keep the process alive.
- An abandoned pass stays the in-flight pass until the producer really settles.
  No new pass starts on top of it, so a stalled producer pauses metrics instead
  of leaking concurrent scans, and sampling resumes once it settles. A producer
  that never settles therefore pauses emission for the life of the process; this
  is reported by silence, never by synthetic values.
- `closeTimeoutMs` (default 5 s, 10 ms to 60 s) is the longest `close()` drains
  an active pass. After it the pass is aborted and abandoned and `close()`
  resolves. `close()` is idempotent: concurrent and repeated calls share one
  completion, `sample()` and `start()` are no-ops afterwards, and nothing is
  emitted after `close()` resolves.
- Callers of `sample()` share one pass and one signal. A caller that uses a
  producer directly and coalesces onto an in-flight pass is governed by the
  signal of the caller that started it.

Producer behavior on abort:

- Hosted PostgreSQL: the signal is checked before requesting the transaction,
  after connection acquisition, after each savepoint is acquired before its
  source SELECT, and after the final source. An abort observed inside the transaction
  callback throws, so it rolls back and starts no further source query; the caller stops waiting on the
  transaction immediately. The baseline is promoted only after a last
  synchronous check that the signal is still live, so an aborted pass promotes
  no baseline even if its transaction committed. While an abandoned
  transaction has not finished, a new pass returns no points instead of
  opening a second transaction, so abandoned work cannot pile up connections.
  An abandoned statement is not cancelled server side (there is no
  `pg_cancel_backend` call and none is made on the caller's behalf); it
  remains bounded by `statementTimeoutMs`, `lockTimeoutMs` and the fixed
  15 s idle-in-transaction timeout, and it rolls back.
- Local/Hosted Simple SQLite: abort terminates the worker thread. Its producer
  settles only after the thread exits and releases its read snapshot; the
  lifecycle caller can return earlier at its deadline. An aborted pass does not
  update the retained baseline.
- Accordingly, `passTimeoutMs` bounds how long a pass can block the lifecycle,
  not the cost of database work already issued.

## Remaining dependencies and limitations

Local composition startup/cleanup wiring is coordinated with #1047; Hosted
composition wiring is coordinated with #1048. Those integrations need composed
startup, rollback and shutdown tests against their exact final heads.

Hosted PostgreSQL has its own producer (below); the SQLite record reader is
not reused because PostgreSQL does not carry the same record layout. Conversation
and artifact correlations remain reference-only as in the offline report, and
the PostgreSQL producer emits no correlations at all.

The lifecycle neither installs an exporter nor configures credentials, network
access, storage prices or deployment. A supplied adapter and its already-approved
exporter are prerequisites for external export. Storage cost remains explicitly
unpriced unless an operator supplies the existing report price option.

## Hosted PostgreSQL producer

`createPostgresRuntimeMeasurements` (`@control-plane/database`) is the Hosted
counterpart of `createLocalRuntimeMeasurements`: it builds the same
`OperationsMeasurementLifecycle` (service name `hosted-control-plane`) over
`createPostgresOperationsMeasurementProducer`, which is also exported for
composition roots that own their lifecycle. Neither is wired into a composition
root by this change; #1048 integrates it exactly as #1047 integrates the SQLite
adapter.

Composition contract:

- Pass the Hosted application `ControlPlaneDatabase` (or anything with the same
  `transaction` method), the single selected `workspaceId`, an explicit
  `MetricAdapter`, a cadence and optional bounds. Absence of any of them
  enables nothing; an invalid workspace, cadence or bound throws at
  construction before any query.
- Start after migrations and successful startup. Call `close()` before ending
  the database pool: close drains an active pass for at most `closeTimeoutMs`
  (default 5 s) and then aborts it, after which `sample()` is a no-op and no
  query is issued. `passTimeoutMs` (default 60 s) bounds one pass. A pass
  against an ended pool resolves with no points and no error. An abandoned
  transaction may still be finishing server side after `close()` returns, so
  end the pool with a bounded drain (for example `end({ timeout })`).
- One pass is one `READ ONLY`, `REPEATABLE READ` transaction, so every source
  describes one snapshot and a write is rejected by PostgreSQL (`25006`). Each
  transaction sets `statement_timeout` (default 5 s), `lock_timeout` (default
  1 s) and `idle_in_transaction_session_timeout` (15 s) with `SET LOCAL`
  semantics. It needs only `SELECT` on the measured tables and works through a
  transaction-mode pooler because the whole pass stays on one connection.
- Each source runs under its own savepoint, so one unreadable table degrades
  that source only. Each measurement statement is subject to the configured
  statement timeout; the full pass is bounded separately by the lifecycle's
  `passTimeoutMs` (see Cancellation and deadlines).

Integration shape for the Hosted composition (illustrative; not applied here):

```ts
const measurements = createPostgresRuntimeMeasurements({
  database: connection.database, // the application ControlPlaneDatabase
  workspaceId,
  adapter, // an already-approved MetricAdapter
  intervalMs: 60_000,
  storageUsdPerGiBMonth, // optional, operator-supplied
})
measurements.start() // after migrations and successful startup
// shutdown order: await measurements.close(), then await connection.close()
```

Scope and bounds:

- Every source is anchored on the selected workspace, either through its own
  indexed `workspace_id` column or through that workspace's executions, and
  never walks another tenant's rows to find its own. Attempts, interactions,
  commands and events start from at most `maxScanRows` of the workspace's
  executions and look children up by `execution_id` through a bounded `LATERAL`
  subquery, which cannot plan as a merge or hash join. Commands and events must
  also carry the selected `workspace_id`, so a record stamped with another
  workspace on an in-scope execution counts for neither tenant.
- `maxScanRows` (default 10,000, up to 1,000,000) bounds candidate rows returned
  from each source subquery to its aggregate, with one extra row as a truncation
  sentinel. A source that reaches it, or whose executions bound was reached, is
  `incomplete` (`row_budget_reached`) and every point derived from it is
  suppressed; nothing is reported as a lower bound.
- This returned-row bound is not a bound on physical planner reads. PostgreSQL
  may inspect more heap or index tuples and pages to find the bounded rows,
  depending on the selected plan and data distribution. `statement_timeout` is a
  per-statement backstop for elapsed database execution, not a deterministic
  I/O/CPU bound; the pass deadline stops the caller waiting, it does not cancel
  work the server already started.
- The `usage-budgets` source expands each selected row's `reservations` JSON
  array to validate and sum its entries. `maxScanRows` limits budget rows, not
  the number of reservation elements within one row; there is no separate
  per-array expansion cap, so a large reservation array can increase work.

Honest results:

- Source statuses are `complete`, `incomplete` or `unavailable`, with fixed
  reason codes only: `row_budget_reached`, `malformed_records`, `unsafe_total`,
  `timeout`, `lock_timeout`, `permission_denied`, `query_failed`. Driver
  messages, SQL, table names and connection details never reach a result,
  metric or thrown error. Damaged budget JSON, any reservation whose charged
  amount is not a nonnegative whole number, an external-session read model whose
  `state` is missing, null, not a string or outside the contract's states, and
  per-source sums beyond the safe-integer range are `incomplete`, never summed
  or counted as "not active". Aggregate retained/growth and priced storage
  points are suppressed if cross-namespace sums or computed microunits exceed
  the safe-integer range; safe per-namespace points remain available.
  Enumerated columns (execution, attempt, interaction, command and event states)
  are constrained by PostgreSQL itself, so only the JSON models need this
  validation.
- A pass in which nothing could be read, or no transaction could be opened,
  returns `undefined`, so the lifecycle emits nothing instead of zeros. A
  workspace with no rows is a complete pass with zero counts and no latency
  points: absence of samples is not a zero latency.
- Point families mirror the SQLite producer: queue, human, retry and
  reconciliation ages (min, lower median, max), windowed USD usage cost, storage
  retained and rewritten bytes, signed storage growth, active-object counts, and
  storage and total operating cost. Labels come from the existing bounded
  contract only; workspace and execution identifiers, payloads and secrets are
  never selected or labeled.

Storage and growth:

- Bytes are `pg_column_size` of each in-scope row, the logical stored row
  including TOASTed payload. They exclude indexes, page overhead and dead
  tuples, can differ by tuple alignment padding, and are not comparable to the
  SQLite producer's JSON byte counts across profiles. Payload columns are
  measured, never returned.
- Measured namespaces: `executions`, `execution-attempts`,
  `execution-events`, `execution-plans`, `interaction-requests`,
  `runtime-commands`, `runtime-discovery-connections`,
  `runtime-discovery-sessions`, `usage-budgets`, `usage-effects` and
  `usage-ledger-entries`. `total` is the total over exactly these.
  `runtime-channel-sequences` (the workspace exists only inside a text identity,
  so scoping would scan other tenants) and `usage-entry-sequences` (a column in
  PostgreSQL, not a store) are not measured.
- `storage.rewritten.bytes` is emitted only for namespaces with a last-write
  timestamp. `usage-budgets` and `usage-effects` have none, so no rewritten
  total is claimed.
- The growth baseline is the last complete storage snapshot, held in memory by
  the producer. It is replaced only when every measured namespace was complete
  in a pass whose transaction committed; a partial or failed pass leaves the
  previous baseline intact (as does an aborted or abandoned pass), and the first
  pass has no growth point. Growth is a
  signed delta (shrinkage is negative) per complete namespace. Aggregate
  retained bytes and total growth are emitted only when their safe-integer sums
  fit; unsafe aggregate totals do not suppress safe per-namespace points.
- Storage cost is priced only with an explicit `storageUsdPerGiBMonth` over a
  complete snapshot whose retained total and computed microunits fit the
  safe-integer range. The total operating cost additionally needs budgets that
  parse cleanly in a single USD currency and a safe-integer combined sum. No
  provider pricing is inferred.

Not claimed: this producer does not wire a composition root, install an
exporter, configure credentials, network access or prices, change roles or
grants, or deploy. It is qualified on disposable PostgreSQL only; the
Hosted/cloud qualification of emitted points through an approved exporter is a
separate step.

## Validation

Focused suites: `bun test ./packages/telemetry/src/operations-lifecycle.test.mjs`,
`bun test ./apps/local-control-plane/src/runtime-measurements.test.mjs` and
`bun test ./packages/database/src/operations-measurements.test.mjs`. The
PostgreSQL producer's disposable-database suite is
`cd packages/database && RUN_DATABASE_INTEGRATION=true bun test src/operations-measurements.integration.test.mjs`
(it creates, migrates and drops its own database).
Run the existing operations emitter and offline report suites as regressions,
then repository format, lint, build and type checks before readiness. This slice
does not satisfy all #1030 acceptance clauses or authorize closing the issue.

This slice adds bounded producer cancellation and shutdown deadlines to the
lifecycle, the Hosted PostgreSQL producer and the SQLite worker adapter. It does
not wire a composition root (still #1047 and #1048), flush or abort an exporter,
cancel an abandoned PostgreSQL statement server side, or recover a producer that
never settles. Hosted PostgreSQL acquisition/commit behavior remains outside its
scope, so a pool that cannot hand out a connection is bounded only by the pass
deadline and the driver's own connect timeout.

The compiled Node SQLite fixture holds a real worker's completed result before
exit, observes termination and thread exit after abort, and compares storage
growth across complete, aborted and complete passes. The aborted snapshot has
different storage bytes, so preserving the previous complete baseline is
observable. PostgreSQL tests distinguish commit from rollback, including real
transactions paused after connection acquisition, savepoint acquisition and
the final source query.
The Node fixture also holds a real SQLite read snapshot after its first SELECT:
a subsequent writer cannot truncate the WAL until cancellation terminates that
worker, after which checkpointing succeeds. This does not claim interruption
inside a synchronous SQLite C call; it verifies termination and release of an
active snapshot between reads.
