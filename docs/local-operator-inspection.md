# Local and Hosted Simple operator inspection

The packaged stuck-job inspection command is a strictly read-only telemetry view over a stopped
Local or Hosted Simple data directory. It correlates the already-persisted execution, runtime
command (job), attempt, external-session, interaction (approval/input) and execution-event (effect)
records into one bounded report of stuck-state candidates and their reconciliation age, for the
explicit workspace (and optional project or profile) the operator selects.

This command inspects; it never operates. It opens the SQLite database with SQLite `readOnly`, runs
only parameterized `SELECT` statements, performs no migration, and never retries, cancels,
fences, reconciles or redeploys anything. It grants no service credential, catalog approval or
context access, and it infers no provider cost from usage data. Privileged controls (reconciliation
triggers, admission stops, revocation and fencing) remain separate operator procedures.

```sh
bun apps/local-control-plane/dist/operator-inspection-cli.js \
  --data-dir /absolute/private/control-plane-data \
  --workspace wsp_01JABCDEF0123456789ABCDEFG \
  [--project prj_01JABCDEF0123456789ABCDEFG] \
  [--profile prf_01JABCDEF0123456789ABCDEFG] \
  [--limit 20] [--stale-after-seconds 900]
```

Use the same protections as the [operator setup command](local-operator-bootstrap.md): stop the
Local process or Hosted Simple container first, run as the OS/container user that owns the data
directory, and keep the directory private (0700) with a private (0600) `control-plane.sqlite`. The
command refuses symlinked or unprotected targets. The same compiled command ships in the Hosted
Simple image.

## Selection and authorization

- `--workspace` is required. Inspection is always scoped to one workspace; records from other
  workspaces are counted (`summary.outOfScopeExecutionRecords`) but their identifiers are never
  emitted.
- `--project` narrows to a legacy project scope. `--profile` filters by the pinned execution-plan
  profile; executions whose plan cannot be resolved are reported in
  `profileResolution.unattributedExecutionIds` instead of being silently dropped.
- A workspace with no records yields an explicit empty report (`executionsInScope: 0`), never a
  blank.

## Output

The command prints one JSON object to stdout. Every field is allow-listed metadata: identifiers,
states, timestamps, counts, ages in milliseconds and booleans. Record payloads, interaction prompts
and responses, plan and skill content, connection native references, and credential material are
never included, and a canary test in the package suite enforces this against seeded secret-bearing
records.

Each execution view carries:

- `stuckReasons` — stable codes: `execution_stale`, `reconciliation_required`, `cancelling_stalled`,
  `deadline_exceeded`, `attempt_interrupted`, `command_expired`, `dispatch_stalled`,
  `delivery_stalled`, `stale_generation`, `awaiting_human`, `effects_pending`.
- `attempt`, `jobs`, `session`, `connection`, `approvals`, `effects`, `profile` — correlated views,
  each with an explicit `availability` state (`resolved`, `missing`, `unparseable`,
  `not_established`, `reference_only`, `unreferenced`). A missing runtime-connection projection, a
  revoked connection or session, and a referenced-but-absent attempt are surfaced as first-class
  states rather than empty fields.
- `reconciliationAgeMs` — the age of the last observed change while the execution is not terminal.

Results are bounded: at most `--limit` executions (default 20, maximum 100), ordered
oldest-evidence first with `summary.remainingStuckCandidates` reporting the rest; job and pending
interaction lists are capped per execution; each namespace scan is capped at
`thresholds.maxScanRecords` records with `summary.scanTruncatedNamespaces` reporting any bound that
was reached; malformed records are counted in `summary.malformedRecords` and never emitted.

Failures exit 1 with `LOCAL_OPERATOR_INSPECTION_FAILED` on stderr and never echo paths or record
content.

## Staleness and generations

`--stale-after-seconds` (default 900, range 60–86400) sets the unchanged-age threshold behind the
`*_stale`, `interrupted`, `awaiting_human`, `dispatch_stalled`, `delivery_stalled` and
`effects_pending` reasons; the chosen threshold is echoed in `thresholds`. The `stale_generation`
flag compares a non-terminal job's `lastChannelGeneration` against the highest generation reserved
for the same channel in `runtime-channel-sequences`; when no reservation is known the flag is
`null` (unknown), not `false`.
