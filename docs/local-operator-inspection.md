# Local and Hosted Simple operator inspection

The packaged stuck-job inspection command is a strictly read-only telemetry view over a stopped
Local or Hosted Simple data directory. It correlates the already-persisted execution, runtime
command (job), attempt, external-session, interaction (approval/input) and execution-event (effect)
records into one bounded report of stuck-state candidates and their reconciliation age, for the
explicit workspace (and optional project or profile) the operator selects.

This command inspects; it never operates. The operator database is never opened writable by SQLite:
the command opens it with SQLite `readOnly`, or — when the store is a checkpointed WAL database
whose sidecars are already gone, the exact state after a graceful launcher stop — inspects a
verified byte-copy in a private 0700 temporary directory that carries SQLite `query_only`. Only
parameterized `SELECT` statements run; nothing is migrated. The command never retries, cancels,
fences, reconciles or redeploys anything, grants no service credential, catalog approval or context
access, and infers no provider cost from usage data. Privileged controls (reconciliation triggers,
admission stops, revocation and fencing) remain separate operator procedures.

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
  workspaces are counted (`summary.inScope.outOfScopeExecutions`) but their identifiers are never
  emitted.
- `--project` narrows to a legacy project scope. `--profile` filters by the pinned execution-plan
  profile; executions whose plan cannot be resolved are reported in
  `profileResolution.unattributedExecutionIds` instead of being silently dropped.
- A workspace with no records yields an explicit empty report (`summary.inScope.executions` is 0),
  never a blank.

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
  revoked connection or session, a referenced-but-absent attempt, and a plan that cannot be
  resolved are surfaced as first-class states rather than empty fields.
- `reconciliationAgeMs` — the age of the last observed change while the execution is not terminal.

The `summary` block separates two scopes so totals are never misread across a profile filter:

- `summary.inScope` — totals for the selected workspace (and project) regardless of profile
  filtering: execution and out-of-scope record counts, stuck candidates, the oldest stuck age, and
  workspace-wide human-wait counters. A profile selection that matches nothing still reports these
  workspace-wide totals instead of presenting an empty report as an empty workspace.
- `summary.selected` — totals after profile filtering; only these describe the listed
  `executions` (stuck candidates, remaining candidates past the result limit, listed count, oldest
  selected age). Without a profile filter the two scopes agree.

Effect views (`effects`) are a publication-backlog signal over persisted, unarchived execution
events in this store only. They are **not** complete protected-effect settlement evidence: archived
events leave the window, delivery to subscribers and downstream settlement receipts live outside
this store, and a zero backlog therefore proves nothing about whether every protected effect
actually settled.

## Bounded retrieval, continuation and incompleteness

Namespaces are walked with continuation: pages are fetched by record-id order until the namespace
is exhausted or a budget stops the walk. Budgets count in-scope (workspace-matching) records and
raw rows — never unrelated records alone — so a selected workspace behind any number of unrelated
rows is still found in full. A walk that stops early is reported in `summary.incompleteScans` with
the namespace, the budget that stopped it (`match_budget_reached` or `row_budget_reached`) and the
last examined record id, and `summary.complete` becomes `false`. An incomplete scan means every
count and candidate list in the report is a lower bound; the report never presents a truncated
correlation as confident, and an empty result is never produced by truncation silently.

Results are additionally bounded: at most `--limit` executions (default 20, maximum 100), ordered
oldest-evidence first with `summary.selected.remainingStuckCandidates` reporting the rest; job and
pending interaction lists are capped per execution; malformed records are counted in
`summary.malformedRecords` and never emitted. The effective budgets are echoed in `thresholds`
(`maxScanMatches`, `maxScanRows`, `scanPageSize`).

Failures exit 1 with `LOCAL_OPERATOR_INSPECTION_FAILED` on stderr and never echo paths or record
content.

## Staleness and generations

`--stale-after-seconds` (default 900, range 60–86400) sets the unchanged-age threshold behind the
`*_stale`, `interrupted`, `awaiting_human`, `dispatch_stalled`, `delivery_stalled` and
`effects_pending` reasons; the chosen threshold is echoed in `thresholds`. The `stale_generation`
flag compares a non-terminal job's `lastChannelGeneration` against the highest generation reserved
for the same workspace and runtime node in `runtime-channel-sequences`: channel ownership is
claimed per node, so the node's highest reserved generation is the authoritative current one. The
gateway channel connection id (`gwc_…`) is transport-local and is never joined to a job's
`runtimeConnectionId` (`rtc_…`). When no reservation is known for the node the flag is `null`
(unknown), not `false`.
