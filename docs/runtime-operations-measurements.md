# Runtime operations measurement lifecycle (#1030)

This document covers the bounded lifecycle, the SQLite producer adapter and the
Hosted PostgreSQL producer. Composition integration is a dependency, not
evidence that live Local or Hosted processes already emit measurements. The
offline report and existing emitter are unchanged.

## Composition contract

- Configure an explicit workspace and `MetricAdapter`; absence enables nothing.
- Construct `createLocalRuntimeMeasurements` with the composition's SQLite path,
  adapter, cadence and the existing operations-report bounds. It supports Local
  and Hosted Simple SQLite, not Hosted PostgreSQL.
- Start after migrations and successful runtime startup. Close on startup failure
  and before persistence shutdown; close drains an active scan.
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
  the database pool: close drains an active pass, after which `sample()` is a
  no-op and no query is issued. A pass against an ended pool resolves with no
  points and no error.
- One pass is one `READ ONLY`, `REPEATABLE READ` transaction, so every source
  describes one snapshot and a write is rejected by PostgreSQL (`25006`). Each
  transaction sets `statement_timeout` (default 5 s), `lock_timeout` (default
  1 s) and `idle_in_transaction_session_timeout` (15 s) with `SET LOCAL`
  semantics. It needs only `SELECT` on the measured tables and works through a
  transaction-mode pooler because the whole pass stays on one connection.
- Each source runs under its own savepoint, so one unreadable table degrades
  that source only. A worst-case pass is bounded by the number of sources (11)
  times the statement timeout.

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
- `maxScanRows` (default 10,000, up to 1,000,000) bounds the rows each source
  examines. A source that reaches it, or whose executions bound was reached, is
  `incomplete` (`row_budget_reached`) and every point derived from it is
  suppressed; nothing is reported as a lower bound.
- The bounds hold when the planner uses the existing workspace-leading and
  `execution_id` indexes. `statement_timeout` is the backstop if statistics
  push a plan elsewhere; the source then reports `timeout`.

Honest results:

- Source statuses are `complete`, `incomplete` or `unavailable`, with fixed
  reason codes only: `row_budget_reached`, `malformed_records`, `unsafe_total`,
  `timeout`, `lock_timeout`, `permission_denied`, `query_failed`. Driver
  messages, SQL, table names and connection details never reach a result,
  metric or thrown error. Damaged budget JSON, any reservation whose charged
  amount is not a nonnegative whole number, and sums beyond the safe-integer
  range are `incomplete`, never summed.
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
  previous baseline intact, and the first pass has no growth point. Growth is a
  signed delta (shrinkage is negative) per complete namespace, and the total
  delta is emitted only when the whole snapshot is complete.
- Storage cost is priced only with an explicit `storageUsdPerGiBMonth` over a
  complete snapshot. The total operating cost additionally needs budgets that
  parse cleanly in a single USD currency. No provider pricing is inferred.

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

This slice qualifies completed-pass draining and SQLite checkpoint cleanup;
it adds no producer abort, worker deadline, exporter flush or general shutdown
deadline. Hosted PostgreSQL acquisition/commit behavior remains outside its scope.
