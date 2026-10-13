# Runtime operations measurement lifecycle (#1030)

This slice adds the bounded lifecycle and SQLite producer adapter. Composition
integration is a dependency, not evidence that live Local or Hosted processes
already emit measurements. The offline report and existing emitter are unchanged.

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

The SQLite adapter opens a separate read-only handle for each pass and measures
inside one read transaction. It retains only the last complete storage baseline.
The first pass has no growth point; later complete snapshots may emit signed
growth through the existing gauge path. The report still suppresses points from
partial or unsafe sources. Neither correlations nor errors become metric labels.

## Remaining dependencies and limitations

Local composition startup/cleanup wiring is coordinated with #1047; Hosted
composition wiring is coordinated with #1048. Those integrations need composed
startup, rollback and shutdown tests against their exact final heads.

Hosted/cloud PostgreSQL needs a bounded workspace-scoped measurement producer
over its actual persisted schemas; the SQLite record reader cannot be reused as
if PostgreSQL carried the same record layout. An injected producer must retain
source-quality suppression and secret-free bounded labels. No PostgreSQL metrics
are claimed by this slice. Conversation and artifact correlations remain
reference-only as in the offline report.

The lifecycle neither installs an exporter nor configures credentials, network
access, storage prices or deployment. A supplied adapter and its already-approved
exporter are prerequisites for external export. Storage cost remains explicitly
unpriced unless an operator supplies the existing report price option.

## Validation

Focused suites: `bun test packages/telemetry/src/operations-lifecycle.test.mjs`
and `bun test apps/local-control-plane/src/runtime-measurements.test.mjs`.
Run the existing operations emitter and offline report suites as regressions,
then repository format, lint, build and type checks before readiness. This slice
does not satisfy all #1030 acceptance clauses or authorize closing the issue.
