# M11 native Pi terminal measurements — 2026-09-27

## Scope and requirement boundary

This checkpoint continues #188, not its closure. The parent integrated candidate
is `d577b9b198c0fbc4c7a67dfc66146f0df72eff34` in draft PR #743. It fixes the native
Managed Pi process producer and proves its measurements reach the Local durable
consumer. This is spawned deterministic RPC-fixture evidence, not a live model,
Railway deployment, or complete profile acceptance result.

The full milestone remains unchanged: the managed-cloud, Local, Hosted simple
and Hosted server scenarios, actual runtime-node startup/outbound command
composition, tools/model/MCP/sandbox and graph/child-budget paths, durable usage
settlement with trusted funding/cost provenance, recovery/deployment/migration,
security, adversarial/manual evals, documentation/Skills and independent final
acceptance still need their own proof. No issue is closed by this checkpoint.

## Producer and consumer invariants

- Only validated final `get_session_stats` aggregates establish terminal usage.
  Partial/per-message progress values do not establish aggregate usage.
- Input/output counts, their sum and measured duration must be nonnegative safe
  integers. Missing, malformed or unsafe final stats remain unknown, not zero;
  a successful result cannot be manufactured from them.
- Valid final stats survive a provider error or independent final-text RPC
  failure. Failed and cancelled statuses preserve them through native terminal
  record recovery and runtime-adapter normalization.
- Cancellation preserves the first terminal winner. Its measurement opportunity
  is bounded; stats failure cannot undo cancellation or trigger redispatch.
  Concurrent observers must see one immutable published terminal snapshot, with
  no live-state terminalUsage or late stats rewriting a published record.
  The stats collection window is at most 500 ms (or the configured shorter RPC
  timeout); this is not a production cancellation SLO and excludes the abort
  acknowledgement and durable-record write.
- Local pre-start cancellation must return the actual confirmed terminal winner
  and its usage. Handle mismatch or a nonterminal follow-up observation fails
  closed rather than caching a synthesized cancellation.
- The Local receipt is durable before artifact publication and workflow-effect
  commit. Reopening SQLite and recreating the native client after a lost effect
  must reconcile the retained terminal record without another runtime start.
- Native token/duration measurements do not establish monetary cost, funding
  source or an authorized charge. This change adds no price inference and no
  ledger settlement. Absent accounting/cost stays absent.

## Reproduction and corrective evidence

1. The original native client lost unsuccessful terminal usage, defaulted
   missing/malformed aggregate fields to zero and coupled independent stats/text
   retrieval. The initial worker regression run reproduced four failures before
   implementation (10 pass, 4 fail). Subsequent review required additional
   bounded-finalization/concurrent-observer regressions before acceptance.
   The additional race reproduction was 14 pass, 4 fail, 111 assertions; it
   caught late mutation/live-schema exposure and two corrected fixture setup
   issues. Final worker validation was 33 pass, 0 fail, 198 assertions, with
   package build, lint, formatting and whitespace checks passing. Root
   integration and final candidate results are listed separately below.
2. Three Local queued-cancellation regressions failed before the consumer fix:
   the branch returned an unmeasured cancellation even when completion/failure
   won. They passed after the fix. Expanded tests additionally reject wrong
   handle ID, attempt ID, start timestamp and nonterminal observations, then
   recover without another start. The focused expanded run was 7 pass, 0 fail,
   7 filtered, 50 assertions.
3. An older Local fixture returned cancelled from `cancel()` while always
   returning completed from `status()`. The initial three-file regression run
   was 33 pass, 1 fail. The fixture now consistently preserves its immediate
   completed winner; the expanded run was 38 pass, 0 fail, 260 assertions.
4. The initial actual-native Local fixture incorrectly required unsupported
   capabilities and failed admission in all three cases. It now uses the same
   supported stream-only fixture requirements as the native process tests; this
   does not change production capability policy.
5. Bun 1.4's asymmetric `toMatchObject` matcher mutates a matched numeric subject
   into a matcher object (verified independently). The new Local test checks
   numeric duration directly instead of using that matcher before validation.
6. An expanded guard-test authoring error referenced the status fixture before
   initialization (7 failed cases). Declaration ordering was corrected; the
   seven empty test-owned temporary directories were removed. No application
   process or user data was involved.
7. The package-boundary gate rejected the original cross-package test-helper
   import (1 issue). The integration test now lives at
   `tests/m11-local-native-terminal-usage.test.mjs`, explicitly registered in the
   E2E lane and `test:m11-standalone` command. No private helper was exposed as a
   production package API. Boundary validation subsequently passed for 1,492
   files in 41 packages. Repository/foundation tests initially had 29 pass,
   1 fail because an exact inventory assertion omitted three existing
   budget/usage integration files. The exact inventory was updated without
   weakening it; all 30 repository/foundation checks then passed.

## Final integrated checks

Native producer commit `2d669f3e984a668b1bc927f03f7efad7d92e5c70` was integrated
as `d0c7bea0`, after the Local consumer fix `3bb0c7e6`. Node `24.18.0` and Bun
`1.4.0` ran the final checks. The deterministic spawned fixture advertises Pi
`0.84.2`; it is not proof of a live Pi/provider deployment.

```sh
bun run build
bun test ./packages/managed-pi-adapter/src ./apps/local-control-plane/src \
  tests/m11-local-native-terminal-usage.test.mjs tests/repository.test.mjs \
  tests/foundation.test.mjs --randomize --seed 1104 --timeout 30000
bun run compatibility:check
bun run architecture:check
bun run requirements:check
bun run check:boundaries
bun install --frozen-lockfile
```

- Full workspace build: **41 successful / 41 total**, no cached build tasks.
- Combined tests: **161 pass / 0 fail / 819 assertions / 22 files**, fixed seed
  `1104`. This includes all Managed Pi and Local package tests, the eleven
  actual-native-to-Local cold-replay scenarios and repository/foundation tests.
  None were skipped or filtered in this combined run.
- The eleven new scenarios cover normal completion; provider error; measured
  and delayed measured cancellation; bounded unknown cancellation; independent
  text RPC failure; process exit after valid stats; and missing, fractional,
  unsafe or overflowing aggregate counters. Each loses the workflow-effect
  commit, closes the native process, reopens SQLite, recreates the client and
  proves cold reconciliation without another start. Known usage remains exact;
  unknown usage creates no measurement receipt or successful artifact.
- Compatibility, strict changed-code lint, changed-file formatting and both
  working-tree/committed-diff whitespace checks passed.
- Architecture: **41 packages / 16 operations / 4 profiles**. Live requirements:
  **200 requirements / 103 issue audits**. Boundary check: **1,492 files / 41
  packages / no issues**. These are structural checks, not profile acceptance.
- Frozen lockfile: **284 installs / 316 packages / no changes**. No dependency,
  migration, compatibility certification or requirement-classification change.

The full standalone command, live Railway/provider scenarios, PostgreSQL/Restate
profile recovery, financial settlement and independent/manual acceptance were
not run for this bounded native/Local patch and are not inferred from it. The
original seven open M11 issues remain open.

## Resource ownership

The bounded Luna lane is complete. All test/build handles finished; test-owned
native processes and temporary SQLite data were stopped/removed by the fixture
lifecycle. No database/server or staging/production deployment was started.
The root and reusable worker worktrees remain owned by the unfinished milestone.
Unrelated long-lived test processes were identified as outside this lane and
left untouched. Resource-manager/process-table reconciliation is recorded in
the task-local ledger before publication.

## Rollout

No schema migration, deployment or funding-source change is introduced. Rebuild
the native Managed Pi adapter and Local consumer together. Previously persisted
terminal records without usage stay readable and unknown; they are not
backfilled from progress counters. Existing ambiguous in-flight admissions
still require reconciliation and must not be blindly restarted.
