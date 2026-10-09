# Local and Hosted Simple operator measurements

The packaged operations measurement command is a strictly read-only telemetry view over a stopped
Local or Hosted Simple data directory. It complements the
[stuck-job inspection command](local-operator-inspection.md): inspection answers "what is stuck",
measurement answers "how long things take, how much is retained, and what the recorded operating
cost is" for one explicitly selected workspace.

```sh
bun apps/local-control-plane/dist/operator-measurements-cli.js \
  --data-dir /absolute/private/control-plane-data \
  --workspace wsp_01JABCDEF0123456789ABCDEFG \
  [--window-seconds 86400] \
  [--limit 100] \
  [--storage-usd-per-gib-month 1.5]
```

Use the same protections as the [operator setup command](local-operator-bootstrap.md): stop the
Local process or Hosted Simple container first, run as the OS/container user that owns the data
directory, and keep the directory private (0700) with a private (0600) `control-plane.sqlite`. The
command refuses symlinked or unprotected targets, opens the database with SQLite `readOnly` (or a
verified byte-copy carrying `query_only`, exactly like the inspection command), issues only
parameterized `SELECT` statements, and never mutates, retries, cancels, reconciles or redeploys
anything. The same compiled command ships in the Hosted Simple image.

Failures exit 1 with `LOCAL_OPERATOR_MEASUREMENTS_FAILED` on stderr and never echo paths or record
content.

## Correlation

Every execution in the selected workspace gets one bounded correlation view that links seven
dimensions, each with an explicit availability state (`resolved`, `missing`, `unparseable`,
`not_established`, `reference_only`, `unreferenced`, `scan_incomplete`) — never a blank field:

- **conversation** — the Agent HQ conversation anchors recorded on the execution (`taskId`,
  `agentId`, `requestId`). Always `reference_only` with `authority: agent_hq_reference`: Agent HQ
  owns conversation bodies and state, and the Control Plane correlates references only.
- **job** — the execution's runtime commands: active/queued/settled counts, the oldest active age,
  and `staleGeneration`, which compares each active job's `lastChannelGeneration` against the
  highest generation reserved for the same workspace and runtime node in
  `runtime-channel-sequences` (the current authority for channel ownership). It is `true` when any
  active job lags, `false` when every active job reports the current generation, and `null` when
  any active job has no known generation to compare against.
- **attempt** — the execution's current attempt (`latestAttemptId`) with its state, age and retry
  count; a referenced-but-absent attempt is `missing`, an execution that never attempted is
  `not_established`.
- **session** — the external session projection behind the current attempt's
  `externalSessionId`, with its state, recoverability and observation time; a referenced session
  without a projection is `missing`.
- **approval** — pending/responded/expired/cancelled interaction counts and the oldest pending age.
- **effect** — pending/published/failed/quarantined publication counts and the oldest pending age
  over persisted, unarchived execution events. As in the inspection report, this is a
  publication-backlog signal for this store only, not complete protected-effect settlement
  evidence.
- **artifact** — the recorded result reference (`terminalResultRef` or a command result
  reference), always `reference_only` with `authority: product_artifact_reference`: the product
  artifact authority owns bytes, verification state and access, and no object is ever opened.

All output is allow-listed metadata: identifiers, states, timestamps, counts, ages, byte totals and
booleans. Prompts, responses, payloads, plan content, connection native references and credential
material are never read into the report, and a seeded-canary test in the package suite enforces
this.

## Measurements

The report carries `measurements` with these definitions:

- **queueLatency** — `dispatch`: first dispatch minus issue time per runtime command that has been
  dispatched (`firstDispatchedAt - issuedAt`); `waiting`: age of commands still `queued`
  (`now - issuedAt`), plus `waitingExpiredCount` for queued commands past their expiry. Samples
  report `min/median/max` (lower median) and `null` stats when there are no samples.
- **humanLatency** — `responded`: resolution minus request time per responded interaction;
  `waiting`: age of pending interactions; plus `expiredCount` and `cancelledCount`.
- **retryAge** — `gap`: the delay between one attempt's terminal timestamp and the next attempt's
  queue timestamp; `current`: age of still-running attempts with sequence ≥ 2; plus
  `retriedExecutions`.
- **reconciliationAge** — `nonTerminal`: age of the last observed change for every non-terminal
  execution (the same meaning as the inspection report's `reconciliationAgeMs`);
  `awaitingReconciliation`: count and oldest age for executions carrying
  `reconciliationRequiredAt` or sitting in `reconciliation_required`.
- **usage** — durable usage-ledger entries recorded inside the measurement window: total entries,
  quantity sums per unit, cost sums per currency split into exact and inexact microunits, and
  per-kind counts; plus point-in-time budget totals (records, open/settled, spent and reserved
  microunits per currency, using the same arithmetic as `calculateTotals` in
  `usage-ledger/durable.ts`). `unsafeTotals` marks a sum that left the safe-integer range; affected
  totals then hold their last safe value and are not complete.
- **storage** — payload bytes (`length(value)` in UTF-8; row and index overhead excluded) and
  record counts per measured namespace, scoped to the selected workspace, with
  `bytesTouchedInWindow` from the row's `updated_at` as the in-window growth signal. A
  cross-workspace total is only a comparison base: store two reports to compute growth between
  them. `unmeasuredNamespaces` lists every namespace present in the store but outside the measured
  set, so their bytes are visibly excluded rather than silently missing.
- **activeObjects** — `active` counts (non-terminal executions and attempts, non-settled jobs,
  `active` sessions, `pending` approvals, unarchived effects awaiting publication) with a full
  bounded `byState` breakdown.
- **operatingCost** — never inferred. The usage component comes from the durable usage budgets
  (`spentMicrounits` and `reservedMicrounits` per currency); the storage component exists only
  when the operator passes an explicit `--storage-usd-per-gib-month` rate, priced as one month of
  retained bytes; `totalMicrounits` exists only when usage is recorded in exactly one currency
  (USD) and storage is priced. Every non-computed value is null with an explicit
  `totalAvailability` (`usage_unavailable`, `usage_currency_unsupported`,
  `storage_rate_not_configured` or `measured`). External-subscription usage keeps its recorded
  zero-authoritative-cost semantics; the report never invents a provider price.

## Telemetry points

`telemetry` lists ready-to-emit metric points whose names are members of `operationalMetrics` in
`@control-plane/telemetry/catalog`: `execution.queue.latency`, `execution.human.latency`,
`execution.retry.age`, `execution.reconciliation.age`, `usage.cost.usd`,
`storage.retained.bytes`, `storage.growth.bytes`, `runtime.active_object.count` and
`operations.operating_cost.usd`. Labels are bounded by the emitter contract
(`createOperationsMetricEmitter`): only fixed keys and fixed values (with an `other` fallback) are
ever forwarded, unknown keys are dropped, and identifiers — workspace, execution, prompt, payload —
never become metric labels. `usage.cost.usd` points are emitted only for USD-denominated windowed
cost; other currencies remain visible in the JSON report only. Live compositions can record the
same points through the shared metric adapter; this command computes them for an offline operator.

## Scope, authority and honest limits

- **Tenant scope.** `--workspace` is required and is the only scope: execution-attempt and
  interaction records carry no workspace field and are attributed through their execution anchor.
  Records that cannot be anchored (other workspaces, removed executions) are excluded from every
  total and reported in `summary.unattributedRecords`. Other workspaces are counted
  (`summary.outOfScopeExecutions`) but never named. Project/profile narrowing is an inspection
  concern; a measurement report is workspace-scoped by construction.
- **Current authority.** Measurement reads only current authoritative records: the stored
  execution and its current attempt, the highest reserved channel generation per node, the current
  discovery projection and the current publication status. It never reconstructs state from
  historical journals or superseded generations.
- **Window.** `--window-seconds` (default 86400, range 60–31536000) bounds windowed usage entries
  and the storage-growth window; latencies, active objects, budgets and retained bytes are
  point-in-time over whatever the store currently holds.
- **Bounds and incompleteness.** Namespaces are walked with continuation under explicit budgets
  (echoed in `thresholds`). A walk that stops early appears in `summary.incompleteScans` and flips
  `summary.complete` to `false`; dependent dimensions are marked `scan_incomplete`, and every count
  in such a report is a lower bound — never read an empty or small result as confident. Malformed
  records are counted in `summary.malformedRecords` and never emitted. The correlation listing is
  bounded by `--limit` (default 100, maximum 500) with `summary.correlationsUnlisted` reporting
  the rest; aggregates always cover every in-scope record the walk reached.
