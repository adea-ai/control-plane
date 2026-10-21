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

The tests use the **production** owned-child handle
(`createOwnedChildHandle`), the same one the repository entry point ships, so
a test-only reimplementation cannot mask a divergence between the tested and
the shipped lifecycle. Every real child the tests spawn is torn down with a
**bounded, awaited** teardown that is registered as soon as the child exists:
a timeout, a failed assertion or a failed fetch inside a test body can no
longer leak a test-owned process, and a teardown failure is reported next to
the primary failure rather than replacing it. Two focused regressions assert
that a failing test body still terminates the child it owns.

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

| Measure                                                | Value                                 | Source                                                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                        | 16.12 s                               | **[measured]**                                                                                                                                                                                             |
| `bun run build`, fresh worktree, uncached              | **56.18 s**                           | **[measured]** — the M13 audit's local reference was 3 m 28.5 s at 41/41 tasks on a colder host. The current head differs from that commit only in `.mjs` and `.md` files, so the build graph is unchanged |
| `bun run test` (all lanes, coverage-enabled unit lane) | **222.91 s**                          | **[measured]** at the current head `23fa6880` — smoke 629 pass / 0 fail, e2e 499 pass / 0 fail, unit 1 failure (the seeded baseline failure, see §5)                                                       |
| `bun scripts/check-budgets.mjs dist`                   | **20.3 MB** against the 12 MB ceiling | **[measured]** — see §3.3                                                                                                                                                                                  |

**CI timings.** The GitHub-visible _Code Foundry Validation_ runs on `main`
(`39543810015` at `27f17bd55`, `39542783282` at `6d16a4951`) report the
Code Foundry runtime, Gate, PostgreSQL-qualification and Mode jobs as
**skipped**: the lane runner is the Code Foundry CI runtime, so no per-lane
duration is publicly observable for the current `main`. The canonical CI lane
baseline therefore remains the recorded M13 Validation run `35462414764`
(Unit 256 s, Build 254 s, Type-Check 167 s, Format 107 s, Integration 98 s,
E2E 85 s, Smoke 68 s, Lint 38 s, Dep-audit 33 s, Eval 17 s, Performance 8 s,
Gate 14 s; critical path Unit → Gate, wall ≈ 4 m 52 s). The local candidate
timings above are the current-candidate evidence; no lane was re-run in CI
because the branch is not published.

### 3.2 Dependency cost

`bun scripts/check-budgets.mjs deps` enumerates the unique external
`package@version` closure with `bun pm ls --all` and compares it with the
285 ceiling.

| Measure                          | Value                                                     | Source                    |
| -------------------------------- | --------------------------------------------------------- | ------------------------- |
| external `package@version` pairs | **591** against the 285 ceiling                           | **[measured]** — see §3.3 |
| unique package names             | 578, of which **58** are present at more than one version | **[measured]**            |
| raw `bun pm ls --all` lines      | 644                                                       | **[measured]**            |

### 3.3 The committed regression budgets, and the remediation that closes one

Both budgets were measured on this candidate with the repository's own
checkers, and **neither ceiling is inflated here**. The artifact budget is
now met by a source-level fix; the dependency budget is reduced by a
composition fix and its residual is a product decision, reported rather than
absorbed.

| Budget                      | Committed ceiling    | Before                                            | After                    | Command                                                          |
| --------------------------- | -------------------- | ------------------------------------------------- | ------------------------ | ---------------------------------------------------------------- |
| `dist` total size           | 12 MB                | **20.3 MB — exceeded**                            | **11.8 MB — inside**     | `bun scripts/check-budgets.mjs dist`                             |
| external dependency closure | 285                  | **591 — exceeded**                                | **591 — still exceeded** | `bun scripts/check-budgets.mjs deps`                             |
| build wall clock (CI lane)  | 300 s (declared)     | 254 s recorded baseline; 36.40 s local cold build | unchanged                | `bun scripts/check-budgets.mjs lane --group build --seconds <n>` |
| unit / e2e / smoke lanes    | 480 s / 120 s / 90 s | unchanged                                         | unchanged                | the same lane subcommand                                         |

**The artifact breach was a build-composition problem, not a code-size
problem.** The compiled output carried the derived source-map and
declaration-map artifacts: 1,308 map files, 5.22 MB of the 14.13 MB of
built content — 37% of the bytes — and **nothing in the repository consumes
them** (no bundler, script, workflow or test reads a `.map` file, and no
package overrides the setting). The build configuration now stops emitting
them, and a cold rebuild measures **11.8 MB against the 12 MB ceiling**.

Two measurement facts make that number meaningful. First, the `dist` budget
must be read from a **cold** build: the repository's build cache replayed
the pre-change artifacts after a `tsconfig.base.json` change and after the
`dist` directories were deleted, so a cached build re-reported 20.3 MB
regardless of the configuration. Second, the headroom is now **0.2 MB** — the
next meaningful code growth in this graph breaches the budget again, which
belongs to the follow-up in §6.

**The dependency breach is composition, and most of it is product surface.**
The measured closure is the whole installed tree. Its composition, from the
lockfile and the installed tree, is: the Pi SDK family
(`@earendil-works/pi-durable` 102 and `@earendil-works/pi-ai` 96 packages),
the Nest/Fastify generation (64 + 55 + 18 + 10 + 8), the repository
toolchain (`vite-plus` 82, `miniflare` 31, `drizzle-kit` 13), Sentry and
OpenTelemetry (34), the AWS SDK and Smithy (31) and LangChain (23). The
bounded remediation removed what a package declares but never uses:
`fastify` and `@nestjs/common` (local-control-plane) and
`@restatedev/restate-sdk` (workflow-worker) — declarations that no source in
those packages imports. **The measured closure stays 591**: those packages are
still in the installed tree because other workspace packages need them, so
the cleanup is a composition fix, not a closure reduction, and it is reported
as exactly that. `class-transformer` was removed and then **restored**:
`@nestjs/common`'s `ValidationPipe`, which `apps/control-api` applies, needs
it, so the declaration is a peer requirement rather than an unused
dependency — it is recorded as a reviewed exception in the check below.

**The remaining gap to 285 is not reachable by a bounded source or
configuration change**: it is the Pi SDK, the Nest/Fastify generation, the
AWS and LangChain SDKs or the repository toolchain, and removing any of
those is a product and architecture decision, not a budget repair. The
ceiling stays at 285, nothing is hidden from the measurement, and the
residual is routed in §6.

**A pre-existing lockfile drift was fixed on the way.** `bun.lock` still
carried `@control-plane/control-api` 1.34.1 and `@control-plane/workflow-worker`
1.18.1 while the manifests already declared 1.34.2 and 1.18.2, so the
lockfile did not match the workspace it describes. The install that the
dependency cleanup required resynchronised it.

### 3.6 The remediation and its regression checks

- `tsconfig.base.json` stops emitting `sourceMap` and `declarationMap`;
  `declaration` stays on, because the packages publish their types. The
  trade-off is explicit: the built output no longer carries a mapping back
  to the sources, so a production stack trace points at compiled positions.
- Two workspace packages no longer declare the external dependencies nothing
  in them imports (`fastify` and `@nestjs/common` in local-control-plane,
  `@restatedev/restate-sdk` in workflow-worker).
- `packages/production-readiness/src/budget-regression.test.mjs` pins the
  repair: it asserts the build configuration does not emit the derived map
  artifacts, it runs the **production** checker (`scripts/check-budgets.mjs
  dist`) against the built output and asserts the measurement is inside the
  committed ceiling, and it asserts that **no workspace package declares an
  external dependency it never imports** — with two reviewed exceptions
  recorded, each a peer requirement of `@sentry/node` or of
  `@nestjs/common`'s `ValidationPipe`. The checker is
  spawned as a subprocess, so the regression is pinned against the
  production measurement rather than a test-only copy of it.

## 4. Safe shared runtime/data abstractions

The M13 audit's findings are unchanged and are **not** re-derived here; the
current candidate's coupling measurement (`scripts/m17-runtime-baseline.mjs`
at `23fa6880`) backs them: the custom-runtime layer couples to 48 targets
(auth 27, billing 7, transports 7, artifacts 3, policy 1, restate 1,
device-supervision 2), device-supervision to 38 and pi-durable-node-adapter
to 25 — the concentration the consolidation findings already name.
leave the two `gateway.ts` products separate (different semantics, per #192);
consolidate the duplicated promise-pending-map process clients into a
`ProcessRpcLink` primitive in `packages/deployment` (characterization suites
exist on both sides); consolidate the four hand-rolled exponential backoff
formulas into one pure `computeBackoffDelayMs` in `packages/domain`; SQLite
WAL/PG maintenance and bootstrap/jsonLogger are negative findings (the port
pattern and the shared `bootstrapService` already cover them). **No contract
changes** are proposed or made.

## 5. Receipts

Exact commands and results for this candidate:

| Command                                                          | Result                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun scripts/check-startup-budget.mjs`                           | cold run: `OK` 8.1 s ready (ceiling 45), `OK` 233.9 MB peak RSS (ceiling 256); repeat run: `OK` 3.3 s ready, `OK` 223.4 MB peak RSS; the owned child exited after `SIGTERM` in both                                                                                                                                                                                                                                         |
| `bun scripts/m17-runtime-baseline.mjs`                           | exit 0; candidate `23fa68806ebad0986239b0f3c311ff0c607ed6e7`, dirty `false`; queue round trip p50 5.03 ms / p95 21.80 ms                                                                                                                                                                                                                                                                                                    |
| `bun scripts/check-budgets.mjs deps`                             | `BUDGET EXCEEDED` — measured 591, ceiling 285 (unchanged by the composition cleanup; the residual is the product runtime surface)                                                                                                                                                                                                                                                                                           |
| `bun scripts/check-budgets.mjs dist`                             | `OK` — **11.8 MB** against the 12 MB ceiling after the build-composition fix (was 20.3 MB)                                                                                                                                                                                                                                                                                                                                  |
| `bun scripts/check-budgets.mjs lane --group build --seconds 254` | `OK` — ceiling 300, baseline 254 (the build lane is measurable now)                                                                                                                                                                                                                                                                                                                                                         |
| `bun run test` (all lanes)                                       | 222.91 s; smoke 629 pass / 0 fail, e2e 499 pass / 0 fail, **unit 1 failure — the seeded baseline failure** `Runtime Gateway production startup > forwards the host credential authority in an isolated subprocess`, which reproduces on the pristine baseline and is untouched by this diff (`git diff 27f17bd55..HEAD -- apps/runtime-gateway tests/` is empty). **The suite does not pass and is not reported as green.** |
| `bun test src/startup-budget.test.mjs` (package cwd)             | 27 pass / 0 fail                                                                                                                                                                                                                                                                                                                                                                                                            |
| `bun run format:check`                                           | clean (1940 files)                                                                                                                                                                                                                                                                                                                                                                                                          |
| `bun run lint`                                                   | exit 0 — oxlint 0 errors, workspace boundaries 0 violations (1231 files / 45 packages), canonical-ordering and digest-writer checks pass                                                                                                                                                                                                                                                                                    |
| `bun run type-check`                                             | every stage passes (type errors none in 7 + 34 files, drizzle `Everything's fine`, compatibility, architecture); **fails only at `requirements:check`** — "Unable to query GitHub issues through authenticated GitHub CLI (exit 4)", an environment limit of this host, not a defect                                                                                                                                        |
| pre-commit hook                                                  | 45/45 tasks, 47/47 successful                                                                                                                                                                                                                                                                                                                                                                                               |

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
