# #405 — runtime, latency, memory and CI-cost audit (2026-10-21)

The consolidated audit the issue asks for, re-measured against the **current
candidate**, plus the repairs the reopened acceptance comment
(`6051493406`) requires. The earlier baselines and consolidation work are
**preserved**: the numbers in
[#405's M13 audit comment](https://github.com/adea-ai/control-plane/issues/405#issuecomment-5745313616)
and the later legitimate unit-budget revision stay as they were; no superseded
ceiling is reinstated and no threshold is inflated.

## 1. Scope of this pass

- Re-measure the current candidate's build/test/CI cost and the local
  service/runtime/memory/startup/dependency surface, and reuse the adjacent
  [#193](https://github.com/adea-ai/control-plane/issues/193) and
  [#406](https://github.com/adea-ai/control-plane/issues/406) measurements
  instead of re-running duplicate load and soak probes.
- Repair the two defects the reopened comment names: the **startup/RSS probe**
  that could pass without a valid RSS sample and could accept readiness from
  an unrelated listener, and the **build ceiling** that was claimed measurable
  but was not, because the committed budgets had no build lane and the
  checker rejected an absent group.
- Keep the safe shared-runtime/data-abstraction findings and the release
  follow-up from the M13 audit; this pass adds no contract change.

## 2. The repairs

### 2.1 The startup/RSS probe now fails closed

`scripts/check-startup-budget.mjs` previously initialised the peak RSS to
zero, ignored an unsuccessful or empty `ps` sample, and accepted readiness
on the selected port before proving the listener belonged to the launched
child. The probe now:

- **refuses an occupied port before it starts** — an unrelated listener's
  readiness is never measured as the application's own;
- **accepts readiness only once the listener is proved to be the launched
  child or a descendant of it** (the ownership walk is injected, so it is
  deterministic in tests);
- **refuses a malformed, empty, unsuccessful or zero `ps` sample**, and a run
  with no valid sample is a **failure**, not a zero-megabyte pass;
- **fails fast on a spawn failure, a missing PID and an early child exit**,
  and bounds the readiness wait;
- **fails closed when the listener ownership check cannot be made** (an
  unusable `lsof` is an inability to prove ownership, not an absence of a
  listener);
- **owns the child's whole lifecycle**: from the moment the child exists,
  every exit path — a refusal, a thrown dependency, a failed sample — runs its
  cleanup in a `finally`, so the probe never leaves a child behind, including
  on the `process.exit(1)` path;
- **preserves the primary failure** and reports a cleanup failure next to it
  rather than in place of it;
- **waits for the child's actual termination**: `SIGTERM`, then a bounded
  grace, then `SIGKILL`, and a child that still has not exited is an explicit
  cleanup failure — never a silent success;
- signals **only the child the probe spawned** — no discovered PID is ever
  signalled.

`packages/production-readiness/src/startup-budget.test.mjs` drives the probe
two ways: injected fakes pin the parsing, ownership and refusal rules, and
**real subprocesses** exercise the lifecycle — a failed spawn, a child that
exits early, a child that never becomes ready, a thrown dependency and a real
unrelated listener. The suite asserts that the owned child is actually
terminated on every failing path, and that the unrelated listener keeps
running and keeps serving, so no unrelated process can be killed.

### 2.2 The build ceiling is now measurable, as claimed

The corrected claim recorded in
[the 2026-09-20 scope comment](https://github.com/adea-ai/control-plane/issues/405#issuecomment-5751306317)
says the build ceiling is _measurable_ through the lane checker, while its CI
enforcement point is the **code-foundry runtime** that owns the Build lane.
As committed, that was not true: `budgets.json` had no build lane and
`scripts/check-budgets.mjs` rejected an absent group, so
`check-budgets.mjs lane --group build --seconds <n>` failed outright.

`budgets.json` now declares the build lane with the **canonical** ceiling and
baseline from the M13 audit (300 s ceiling, 254 s measured baseline), and
the checker's usage names the group. The ceiling is therefore measurable here
through the same lane subcommand, while the **CI enforcement point stays
external** — the code-foundry runtime owns the Build lane, and this repository
does not fake a lane it does not own. The reviewed `unit`/`e2e`/`smoke`
ceilings are untouched, including the later legitimate unit revision.

```
$ bun scripts/check-budgets.mjs lane --group build --seconds 254
OK: {"ok":true,"ceiling":300,"baseline":254,"measured":254}
$ bun scripts/check-budgets.mjs lane --group build --seconds 400
BUDGET EXCEEDED: {"ok":false,"ceiling":300,"baseline":254,"measured":400}
```

## 3. Measurements on this candidate

All timings are wall-clock on the development host and are marked
**[measured]**; every other number is a recorded baseline cited from the
issue's audit trail and is not re-measured here.

| Measure                                                                                                                                                                                                                           | Value                                                                                                                                                                                                                                                            | Source                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Workspace package graph                                                                                                                                                                                                           | 45 package/app directories under `apps/*` and `packages/*` (the M13 audit counted 41 at its baseline commit)                                                                                                                                                     | **[measured]**                |
| Uncached build, fresh worktree                                                                                                                                                                                                    | see §3.1                                                                                                                                                                                                                                                         | **[measured]**                |
| Local `bun run test` wall clock                                                                                                                                                                                                   | see §3.1                                                                                                                                                                                                                                                         | **[measured]**                |
| CI lane durations (Unit 256 s, Build 254 s, Type-Check 167 s, Format 107 s, Integration 98 s, E2E 85 s, Smoke 68 s, Lint 38 s, Dep-audit 33 s, Eval 17 s, Performance 8 s, Gate 14 s; critical path Unit → Gate, wall ≈ 4 m 52 s) | Validation run `35462414764`                                                                                                                                                                                                                                     | recorded baseline (M13 audit) |
| Service latency                                                                                                                                                                                                                   | edge `/health` p50 228 ms (RTT-dominated, server-side 0–3 ms); compose simple 600 req @ 20 conc → p50 3.6 ms / p95 8.5 ms, 0 errors; 5× spike @ 100 conc → 3,736 req, 0 errors, p95 1.78 s, recovery to 86 ms; server profile steady p95 49 ms, spike p95 152 ms | #193, #188                    | recorded baseline — **reused, not re-run** |
| Queue / runtime behaviour                                                                                                                                                                                                         | Restate `execution-lifecycle` re-registered after RocksDB recovery on every recreate; 45 s grace drains ×3 + one-shots                                                                                                                                           | #188                          | recorded baseline                          |
| Memory / startup                                                                                                                                                                                                                  | production: control-api <0.01/0.50 vCPU, 123 MB/2 GB; workflow-worker 96 MB/275 MB; simple 0.01/0.25 vCPU, 234 MB/1.07 GB; local all-in-one cold 29.1 s, RSS ≈176 MB; server full-stack recreate ≈156 s                                                          | #193, #406                    | recorded baseline                          |
| Dependency cost                                                                                                                                                                                                                   | external closure 274 unique `package@version` pairs at the audit's commit, ceiling 285, six known duplicated transitive majors; see §3.2 for this candidate                                                                                                      | #405 M13 audit                | **[measured]** here                        |
| Startup / RSS ceilings                                                                                                                                                                                                            | 45 s ready, 256 MB idle peak                                                                                                                                                                                                                                     | `budgets.json` (unchanged)    | enforced by the repaired probe             |

### 3.1 Build and test timings

| Measure                                   | Value                                 | Source                                                                                          |
| ----------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`           | 16.12 s                               | **[measured]**                                                                                  |
| `bun run build`, fresh worktree, uncached | **56.18 s**                           | **[measured]** — the M13 audit's local reference was 3 m 28.5 s at 41/41 tasks on a colder host |
| `bun run test` (full suite)               | see the pull-request receipt          | **[measured]**                                                                                  |
| `bun scripts/check-budgets.mjs dist`      | **20.3 MB** against the 12 MB ceiling | **[measured]** — see §3.3                                                                       |

### 3.2 Dependency cost

`bun scripts/check-budgets.mjs deps` enumerates the unique external
`package@version` closure with `bun pm ls --all` and compares it with the
285 ceiling.

| Measure                          | Value                                                     | Source                    |
| -------------------------------- | --------------------------------------------------------- | ------------------------- |
| external `package@version` pairs | **591** against the 285 ceiling                           | **[measured]** — see §3.3 |
| unique package names             | 578, of which **58** are present at more than one version | **[measured]**            |
| raw `bun pm ls --all` lines      | 644                                                       | **[measured]**            |

### 3.3 The committed regression budgets are NOT met by the current candidate

Two of the committed budgets are exceeded on this candidate, measured with the
repository's own checkers. **Neither ceiling is inflated here** — the ceilings
stay as the M13 audit and the later legitimate unit revision set them, and the
growth is reported as the finding it is.

| Budget                      | Committed ceiling                                      | Measured on this candidate                            | Command                                                          |
| --------------------------- | ------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------- |
| external dependency closure | 285 (`budgets.json`)                                   | **591**                                               | `bun scripts/check-budgets.mjs deps`                             |
| `dist` total size           | 12 MB (`budgets.json`)                                 | **20.3 MB**                                           | `bun scripts/check-budgets.mjs dist`                             |
| build wall clock (CI lane)  | 300 s (now declared)                                   | 254 s recorded baseline; 56.18 s local uncached build | `bun scripts/check-budgets.mjs lane --group build --seconds <n>` |
| unit lane                   | 480 s / 300 s baseline (the later legitimate revision) | unchanged                                             | `bun scripts/check-budgets.mjs lane --group unit --seconds <n>`  |
| e2e / smoke lanes           | 120 s / 90 s                                           | unchanged                                             | the same lane subcommand                                         |

**Consequence and reading.** The dependency and artifact surfaces have grown
well past the ceilings the audit recorded (274 → 591 external pairs; 9.8 → 20.3
MB of `dist`), while the workspace graph itself only moved from 41 to 45
packages. The growth is therefore not proportional to the package count: it is
per-package dependency and artifact weight. Both paths are **manual checks**
(the CI gate enforces the lane budgets only), so no CI gate breaks — but the
budgets are no longer being met, and the audit's dependency-cost finding is
now materially larger than it was. That is the finding #405 owes, and it is
routed to the dependency-cost work rather than absorbed by raising a ceiling.

## 4. Safe shared runtime/data abstractions

The M13 audit's findings are unchanged and are **not** re-derived here:
leave the two `gateway.ts` products separate (different semantics, per #192);
consolidate the duplicated promise-pending-map process clients into a
`ProcessRpcLink` primitive in `packages/deployment` (characterization suites
exist on both sides); consolidate the four hand-rolled exponential backoff
formulas into one pure `computeBackoffDelayMs` in `packages/domain`; SQLite
WAL/PG maintenance and bootstrap/jsonLogger are negative findings (the port
pattern and the shared `bootstrapService` already cover them). **No contract
changes** are proposed or made.

## 5. Receipts

The commands, their results and the exact head are in the pull request body
for this branch.

## 6. Release follow-up

- The build ceiling's **CI enforcement remains in the code-foundry runtime**,
  which owns the Build lane. This repository measures the ceiling; enforcing it
  there is an explicit **unowned external dependency**, not a gap in this
  repository's claim.
- The startup/RSS probe stays a reproducible, documented probe rather than a
  hard CI gate: developer hosts are contended, so its thresholds are enforced
  where the environment is controlled. The probe's _fail-closed_ behaviour is
  now CI-testable without a launch.
- Re-evaluate the RSS ceiling whenever the marketplace artifact budgets
  change (#194's rule); the memory posture is deliberately over-provisioned
  since the September OOM incident.
- Confirm turbo remote-cache hit rates from the run-summary API; the M13 audit
  could only infer them.
