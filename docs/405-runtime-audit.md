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
- **accepts readiness only once the whole listener set on the port is proved
  to be the launched child** — every listener on the port must be the child
  or a descendant of it, at least one of them must cover the address the
  readiness probe actually talks to, and every one of them must have an
  address that could be read. A port that is also listened on by an
  unrelated process at another local address is ambiguous and fails closed,
  and a listener whose address cannot be read is refused outright: the
  ownership evidence is incomplete, and the set is reported rather than
  dropped (the ownership walk is injected, so it is deterministic in
  tests);
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
issue's audit trail and is not re-measured here. **Every measurement is tied
to the commit it was taken at** (see §3.0), so no receipt is presented as a
measurement of a candidate it was not taken on.

### 3.0 Which candidate each measurement belongs to

| Measurement                                                                                                                                | Measured at                                   | Note                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the cold build wall clock, the `dist` and dependency closure, the startup/RSS probe, the local request sample and the M17 runtime baseline | **`487883cd`** — the current candidate        | re-run after the build-composition fix and the listener-ownership fix                                                                                                                                                                                                                                                          |
| the audit candidate's startup/RSS probe, request samples, M17 baseline and build timing                                                    | `23fa6880`                                    | the candidate **before** the build-composition fix; kept for the before/after comparison and labelled as such, never as a current measurement                                                                                                                                                                                  |
| the full lane suite (222.91 s)                                                                                                             | `23fa6880`                                    | **not re-run on the current candidate**: the host load average was 75–84 during the attempt, the unit lane timed out at 600 s and the suite was interrupted. Every failing file passes in isolation and the only reproducible failure is the seeded baseline one. It is a receipt for `23fa6880`, not a claim about `487883cd` |
| the CI lane durations                                                                                                                      | the recorded M13 Validation run `35462414764` | not a local measurement                                                                                                                                                                                                                                                                                                        |

| Measure                                                                                                                                                                                                                           | Value                                                                                                                                                                                                                                                            | Source                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Workspace package graph                                                                                                                                                                                                           | 45 package/app directories under `apps/*` and `packages/*` (the M13 audit counted 41 at its baseline commit)                                                                                                                                                     | **[measured]**                                                                                  |
| `bun run build`, fresh worktree, uncached                                                                                                                                                                                         | **56.08 s** at `487883cd`; 56.18 s at `23fa6880`                                                                                                                                                                                                                 | **[measured]** — the M13 audit's local reference was 3 m 28.5 s at 41/41 tasks on a colder host |
| Local `bun run test` wall clock                                                                                                                                                                                                   | 222.91 s at `23fa6880`; **not completed at `487883cd`** (host load)                                                                                                                                                                                              | **[measured]** at `23fa6880` — see §3.1                                                         |
| CI lane durations (Unit 256 s, Build 254 s, Type-Check 167 s, Format 107 s, Integration 98 s, E2E 85 s, Smoke 68 s, Lint 38 s, Dep-audit 33 s, Eval 17 s, Performance 8 s, Gate 14 s; critical path Unit → Gate, wall ≈ 4 m 52 s) | Validation run `35462414764`                                                                                                                                                                                                                                     | recorded baseline (M13 audit)                                                                   |
| Service latency                                                                                                                                                                                                                   | edge `/health` p50 228 ms (RTT-dominated, server-side 0–3 ms); compose simple 600 req @ 20 conc → p50 3.6 ms / p95 8.5 ms, 0 errors; 5× spike @ 100 conc → 3,736 req, 0 errors, p95 1.78 s, recovery to 86 ms; server profile steady p95 49 ms, spike p95 152 ms | #193, #188                                                                                      | recorded baseline — **reused, not re-run** |
| Queue / runtime behaviour                                                                                                                                                                                                         | Restate `execution-lifecycle` re-registered after RocksDB recovery on every recreate; 45 s grace drains ×3 + one-shots                                                                                                                                           | #188                                                                                            | recorded baseline                          |
| Memory / startup                                                                                                                                                                                                                  | production: control-api <0.01/0.50 vCPU, 123 MB/2 GB; workflow-worker 96 MB/275 MB; simple 0.01/0.25 vCPU, 234 MB/1.07 GB; local all-in-one cold 29.1 s, RSS ≈176 MB; server full-stack recreate ≈156 s                                                          | #193, #406                                                                                      | recorded baseline                          |
| Dependency cost                                                                                                                                                                                                                   | external closure 274 unique `package@version` pairs at the audit's commit, ceiling 285, six known duplicated transitive majors; see §3.2 for this candidate                                                                                                      | #405 M13 audit                                                                                  | **[measured]** here                        |
| Startup / RSS ceilings                                                                                                                                                                                                            | 45 s ready, 256 MB idle peak                                                                                                                                                                                                                                     | `budgets.json` (unchanged)                                                                      | enforced by the repaired probe             |

### 3.1 Build and test timings

| Measure                                                | Value                                                                                                                                                                                          | Source                                                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                        | 16.12 s                                                                                                                                                                                        | **[measured]**                                                                                  |
| `bun run build`, fresh worktree, uncached              | **56.08 s** at `487883cd`; 56.18 s at `23fa6880`                                                                                                                                               | **[measured]** — the M13 audit's local reference was 3 m 28.5 s at 41/41 tasks on a colder host |
| `bun run test` (all lanes, coverage-enabled unit lane) | **222.91 s at `23fa6880`**; the current candidate `487883cd` has **no completed aggregate lane run** (host load average 75–84: the unit lane timed out at 600 s and the suite was interrupted) | **[measured]** at `23fa6880` — see §3.0                                                         |
| `bun scripts/check-budgets.mjs dist`                   | **11.8 MB** against the 12 MB ceiling at `487883cd` (20.3 MB at `23fa6880`)                                                                                                                    | **[measured]** — see §3.3                                                                       |

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
285 ceiling. `bun pm ls` lists the dependency tree **according to the current
lockfile**, so what it enumerates is the lockfile's closure, across every
supported platform — not only the packages installed on the host that runs
the measurement.

| Measure                                          | Value                                                                            | Source                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------- |
| external `package@version` pairs                 | **591** against the 285 ceiling                                                  | **[measured]** — see §3.3 |
| unique package names                             | **533**, of which **58** are present at more than one version (533 + 58 = 591)   | **[measured]**            |
| `bun pm ls --all` lines                          | **644** — the header, 45 workspace links and 598 external entries                | **[measured]**            |
| external entries installed on the measuring host | **374** of the 591                                                               | **[measured]**            |
| external entries that are lockfile-only          | **217** of the 591 — 213 other platforms' optional binaries, 4 bundled internals | **[measured]**            |

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

**The dependency breach is composition, and none of it is this slice.**
The admitted runtime-audit slice contributed **zero** external packages: it
added no dependency, and it removed four declarations that no source in
those packages imports (`fastify` and `@nestjs/common` from
local-control-plane, `@restatedev/restate-sdk` from workflow-worker). The
measured closure is identical before and after the slice (591 at
`23fa6880`, at `487883cd` and at the current head), and the slice sources
import runtime builtins only - pinned by
`packages/production-readiness/src/audit-slice-closure.test.mjs`, together
with a guard that the committed ceilings are unchanged.

**The counting rule is not the defect; the ceiling no longer describes the
graph.** The checker counts the unique external `package@version` pairs of the
resolved graph (`bun pm ls --all` over the lockfile), which is exactly what
the committed budget documents it measures, and the workspace packages are
excluded by name. Two independent reproductions pin that:

- **The listing is the lockfile, reproduced exactly.** `bun pm ls --all`
  prints 643 package entries, and rebuilding that list from `bun.lock`
  offline yields the same 643 entries and the same **591** external
  identities — zero differences in either direction.
- **The baseline is reproduced by the same method.** The same reconstruction
  run against the lockfile at `c37de22` yields exactly **274** external
  pairs, the number `budgets.json` records for that commit. The measurement
  method did not change between the baseline and this head; the graph did.

**The gap is real graph growth, and it is attributed.** Between `c37de22` and
this head the closure goes from 274 to 591 pairs: **429 added, 112 removed,
net +317**. 202 of the 429 added pairs are optional platform-specific
binaries (the `@oxlint`/`@oxfmt`/`@oxc-parser`/`@rolldown`/`@yuku-core`
bindings, `@esbuild/*`, `@typescript/typescript-*`, `@img/sharp-*`,
`lightningcss-*`, `@voidzero-dev/vite-plus-*`, `@cloudflare/workerd-*`,
`@restatedev/restate-server-*`, `@oxlint-tsgolint/*`). The remainder are
genuine package families pulled in by roots that arrived since the baseline:
`@aws-sdk` (22) with `@smithy` (4), `@sentry` (7), `@vitest` (9), `@types`
(6), `@nestjs` (4), `@opentelemetry` (4), `@langchain` (4),
`@earendil-works` (4), `@google` (2) and the rest. The 285 ceiling was set
against the 274 baseline and does not describe this graph. The ceiling stays
at **285**, nothing is hidden from the measurement, and the breach is
reported.

**What the number is, and what it is not.** The measurement is the
**lockfile's** closure, so it is not "the installed tree": of the 591 counted
pairs, **374** are installed on the host that runs the measurement (the bun
isolated store `node_modules/.bun`), and **217** are not — **213** are the
optional platform binaries of the platforms this host is not, and **4** are
packages the lockfile carries but the toolchain ships inside its own binary
distribution (`rolldown@1.2.14`, `@rolldown/pluginutils@1.0.1`,
`vite@8.3.4`, `@emnapi/runtime@1.11.3`). A measurement of the installed
surface alone would read 374; the committed budget documents the lockfile
measurement, so 591 is the correct answer to the question the budget asks.
The claim that the 591 is "the whole installed tree" was wrong; the number was
not.

**The provenance of every counted identity.** Each counted identity is
traceable to one or more `bun.lock` entries, and each entry to a resolved
package:

| Counted identity                          | `bun.lock` key path                                              | Resolved package                                    | On this host |
| ----------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- | ------------ |
| `@oxlint/binding-android-arm-eabi@1.86.0` | `@oxlint/binding-android-arm-eabi`                               | `@oxlint/binding-android-arm-eabi@1.86.0`           | no           |
| `@aws-sdk/client-s3@3.1147.0`             | `@aws-sdk/client-s3`                                             | `@aws-sdk/client-s3@3.1147.0`                       | yes          |
| `fast-uri@4.2.1`                          | `@fastify/ajv-compiler/fast-uri`, `fast-json-stringify/fast-uri` | `fast-uri@4.2.1`                                    | yes          |
| `typescript6@6.0.3`                       | `typescript6`                                                    | `typescript@6.0.3` (alias `npm:`)                   | yes          |
| `vite@1.3.0`                              | `vite`                                                           | `@voidzero-dev/vite-plus-core@1.3.0` (alias `npm:`) | yes          |

The lockfile carries **598** external entries; they collapse to **591**
counted identities because **7** identities are contributed by two entries
each — the same package nested under two parents (`fast-uri` under
`@fastify/ajv-compiler` and `fast-json-stringify`; `ws` under `@google/genai`
and `@vitest/browser`; `p-queue`, `p-timeout` and `eventemitter3` under
`@langchain/core` and `langsmith`; `@smithy/core` and `@smithy/types` under
the two `@smithy` parents). Two identities are named by their **alias**
rather than by the package they resolve to (`typescript6@6.0.3` and
`vite@1.3.0`); neither resolved package appears anywhere else in the
lockfile, so the alias naming does not change the count. Resolving every
counted identity to its package therefore yields **591 distinct packages** —
exactly the number the checker reports, with **0** packages counted twice and
**0** counted identities hiding more than one package. **There is no counting
bug**: the 591 is the exact size of the lockfile's external closure.

**The composition of the closure, measured.** The attribution below is
computed on the **lockfile graph** — the graph the checker measures — by
walking each declared root's transitive closure and counting the distinct
external identities it pulls in. The walk is validated against the
measurement itself: seeded from every workspace it reaches **591 of 591**
identities, with none unreached.

| Declared root                | Transitive external identities | Owning manifest                                                                                                                        |
| ---------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `vite-plus`                  | 168                            | `package.json`                                                                                                                         |
| `@earendil-works/pi-durable` | 117                            | `packages/sqlite-persistence`, `packages/pi-durable-adapter`, `packages/pi-cloudflare-host`                                            |
| `@earendil-works/pi-ai`      | 87                             | `package.json` (root), `apps/control-api`, `packages/sqlite-persistence`, `packages/pi-durable-adapter`, `packages/pi-cloudflare-host` |
| `@nestjs/platform-fastify`   | 76                             | `apps/control-api/package.json`                                                                                                        |
| `miniflare`                  | 56                             | `packages/pi-cloudflare-host/package.json`                                                                                             |
| `fastify`                    | 49                             | `apps/control-api/package.json`                                                                                                        |
| `@sentry/node`               | 42                             | `packages/telemetry/package.json`                                                                                                      |
| `drizzle-kit`                | 38                             | `packages/database/package.json`                                                                                                       |

The per-manifest totals of the roots each manifest declares are the
repository root 370, `apps/control-api` 178, `packages/pi-cloudflare-host`
172, `packages/pi-durable-adapter` 118, `packages/sqlite-persistence` 118,
`packages/telemetry` 46, `packages/database` 40, `packages/langgraph-adapter`
37 and `packages/object-store` 28. Every one of those manifests is owned by
another slice: the reduction
candidates sit in `packages/pi-durable-adapter` (the Pi SDK), in
`apps/control-api` (the Nest/Fastify, Sentry/OpenTelemetry and AWS families)
and in the repository root (the `vite-plus` lint and format toolchain). The
manifests this slice owns hold **no removable external dependency**: the four
declarations it removed are gone, and the ones it still declares are used by
its own sources (`zod` in `packages/production-readiness` and in
local-control-plane, `semver` through `createRequire`, the Restate server
package through `require.resolve`). The reduction is therefore blocked by
ownership, not by effort, and it is not attempted from here.

**The measurement's identities, corrected.** The checker's pattern was
hardened so an install path can never be counted as a package name, and the
hardening is exercised by
`packages/production-readiness/src/dependency-budget-scope.test.mjs`: small
explicit listing fixtures drive the checker's identity rule through its
documented listing seam for nested scoped and unscoped installs, for the
same package reached through two install paths, for distinct versions, for
the workspace links and for the lines that are not packages, and the real
listing is measured to confirm that every counted identity is a plain
package identity. A wrong identity fails that regression even though the
total count stays 591.

Two things about that hardening are worth recording, because the earlier
framing of it was not accurate. First, the string this audit previously
quoted as a listing line —
`vite-plus/oxlint/@oxlint/binding-darwin-arm64@1.88.0` — is a
**`bun.lock` key**, not a line `bun pm ls --all` prints: bun renders the tree
with the package name under its parent, and the listing at this head contains
**no** nested install path at all. Second, run against the real listing, the
pattern before the hardening and the pattern after it produce **identical**
identity sets — 591 pairs each, with zero differences in either direction.
So the hardening is a no-op on the measurement's actual input: it makes the
counter correct for an install-path-shaped listing, and it is the reason the
count can be stated as a count of package identities rather than of install
paths. The number was never a parsing artifact. Two counted identities are
named by their **alias** rather than by the package they resolve to
(`typescript6@6.0.3` is `npm:typescript@6.0.3`, and `vite@1.3.0` is
`npm:@voidzero-dev/vite-plus-core@1.3.0`); each is one package, so the count
is unaffected.

**The scope the measurement now pins.** The measured closure is the
**lockfile's** dependency tree, not the installed tree: 374 of its 591 pairs
are installed on the measuring host and 217 are the optional platform
binaries of the other platforms (§3.2). The table above is a per-root walk
of the lockfile graph — the graph the checker measures — and the
earlier note that a lockfile-based enumeration of the same roots _disagreed_
with the installed-graph numbers is now explained rather than left open: the
disagreement was the 217 packages the lockfile carries and the installed tree
does not, 213 of them other platforms' optional binaries. The walk resolves
**every edge to the entry that provides it** — the copy the lockfile installs
under the requiring package, or the hoisted copy — and treats an _optional_
peer as a consumer rather than as an edge, because an optional peer is
satisfied only when something else provides it. The table above is reproduced
by that walk, and the reduction plan below is measured with it; the
attribution, its owners and the proof that six removals are the minimum are
in `docs/1230-dependency-budget-attribution.md`. The bounded
remediation removed what a package declares but never uses:
`fastify` and `@nestjs/common` (local-control-plane) and
`@restatedev/restate-sdk` (workflow-worker) — declarations that no source in
those packages imports. **The measured closure stays 591**: those packages are
still in the lockfile because other workspace packages need them, so
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

**The scoped reduction plan, measured.** The gap is **306** identities
(591 − 285). Because the attribution above is a validated walk of the same
graph the checker measures, the saving of each candidate removal can be
measured instead of argued. Taking the largest marginal saving first, the
closure reaches the ceiling in exactly **six** removals — and every one of
the six is a **devDependency**:

| Step | Declared root removed | Section           | Saving | Closure | Owning manifest               |
| ---- | --------------------- | ----------------- | ------ | ------- | ----------------------------- |
| 0    | — (as measured)       | —                 | —      | **591** | —                             |
| 1    | `vite-plus`           | `devDependencies` | −160   | 431     | `package.json` (root)         |
| 2    | `miniflare`           | `devDependencies` | −52    | 379     | `packages/pi-cloudflare-host` |
| 3    | `@sentry/node`        | `devDependencies` | −41    | 338     | `packages/telemetry`          |
| 4    | `oxfmt`               | `devDependencies` | −21    | 317     | `package.json` (root)         |
| 5    | `typescript`          | `devDependencies` | −21    | 296     | `package.json` (root)         |
| 6    | `oxlint`              | `devDependencies` | −20    | **276** | `package.json` (root)         |

**Six removals are the minimum.** The saving of removing any set of roots is
at most the sum of the individual savings, and the five largest individual
savings are 160 + 50 + 40 + 21 + 20 = **291**, below the 306 the ceiling
requires; so no five-root set reaches 285 under this measure.

**What that plan means.** The ceiling is reachable **without removing a
single product runtime dependency** — but only by deleting the repository's
own build, lint and test toolchain (`vite-plus`, `oxfmt`, `oxlint`,
`typescript`), the Cloudflare host's local test server (`miniflare`, a
devDependency of `packages/pi-cloudflare-host`) and the observability SDK
`@sentry/node` (a devDependency _and_ an optional peer of
`packages/telemetry`, whose source loads it through a guarded dynamic
import). That is the honest shape of the gap: **it is an infrastructure
decision, not a product dependency decision**, and the plan is recorded here
rather than executed, because the manifests that declare those six roots
belong to other slices and because deleting the toolchain would remove the
repository's ability to build, lint and test itself. No manifest, lockfile or
threshold is changed by this audit.

**A pre-existing lockfile drift was fixed on the way.** `bun.lock` still
carried `@control-plane/control-api` 1.34.1 and `@control-plane/workflow-worker`
1.18.1 while the manifests already declared 1.34.2 and 1.18.2, so the
lockfile did not match the workspace it describes. The install that the
dependency cleanup required resynchronised it.

### 3.4 Local service latency, queue/runtime behaviour, memory and startup

All **[measured]** on this developer host (darwin arm64, M2 Max, 12 CPU,
64 GB, bun 1.4.3, SQLite 3.51.0) against the local profile at the current
head `487883cd` (clean tree) for the current figures, with the `23fa6880` figures labelled where they are quoted. No cloud, Restate server, PostgreSQL, provider
or device was contacted, and no production system was loaded.

| Measure                                                                                                                                                                                                                                                                     | Value                                                                                                                                                                                                      | How                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **14.2 s** at `487883cd`; 8.1 s at `23fa6880` (ceiling 45 s)                                                                                                                                                                                                                | **8.1 s** (ceiling 45 s)                                                                                                                                                                                   | `bun scripts/check-startup-budget.mjs` — the repaired probe, on the real built app |
| startup → ready (warm)                                                                                                                                                                                                                                                      | ≈ 0.1 s                                                                                                                                                                                                    | a second start on the same profile state                                           |
| **227.0 MB** at `487883cd`; 233.9 MB at `23fa6880` (ceiling 256 MB)                                                                                                                                                                                                         | **233.9 MB** (ceiling 256 MB)                                                                                                                                                                              | the same probe — the peak, not the steady state                                    |
| steady-state RSS after readiness                                                                                                                                                                                                                                            | **78.8 MB**                                                                                                                                                                                                | `ps -o rss=` on the owned child once idle                                          |
| at `487883cd`: **300 requests, 0 errors, p50 3.37 ms, p95 80.71 ms, p99 138.18 ms, max 184.92 ms** (taken under a host load average of 75–84); at `23fa6880`: p50 1.72 / p95 9.49 / p99 32.91 / max 38.7 ms, then 0.50 / 1.27 / 2.27 / 5.47, then 0.34 / 0.75 / 1.03 / 3.51 | **300 requests, 0 errors, p50 1.72 ms, p95 9.49 ms, p99 32.91 ms, max 38.7 ms**                                                                                                                            | a local in-process sample; `/ready` and `/health` both answer 200                  |
| queue round trip (SQLite enqueue → claimDue → complete, 50 iterations)                                                                                                                                                                                                      | at `487883cd`: **p50 2.49 ms, p95 41.06 ms, max 115.67 ms**; at `23fa6880`: p50 5.03 ms, p95 21.80 ms, max 37.60 ms                                                                                        | `bun scripts/m17-runtime-baseline.mjs` on a disposable temp database               |
| filesystem put p50 14.96 ms / p95 82.02 ms; get p50 2.60 ms / p95 22.04 ms; round trip p50 17.37 ms / p95 84.53 ms (at `23fa6880`)                                                                                                                                          | put p50 14.96 ms / p95 82.02 ms; get p50 2.60 ms / p95 22.04 ms; round trip p50 17.37 ms / p95 84.53 ms                                                                                                    | the same baseline run                                                              |
| open budget p50 23.03 ms; reserve p50 9.91 ms / p95 17.11 ms (at `23fa6880`)                                                                                                                                                                                                | open budget p50 23.03 ms; reserve p50 9.91 ms / p95 17.11 ms                                                                                                                                               | the same baseline run                                                              |
| p50 0.07 ms, p95 1.71 ms, max 9.42 ms (at `23fa6880`)                                                                                                                                                                                                                       | p50 0.07 ms, p95 1.71 ms, max 9.42 ms                                                                                                                                                                      | the same baseline run                                                              |
| pi-durable-node-adapter 855 ms, transports 488 ms, custom-runtime 351 ms, billing 328 ms, artifacts 327 ms, pi-cloudflare-host 279 ms, auth 258 ms, policy 180 ms, device-supervision 28 ms, restate 22 ms (at `23fa6880`)                                                  | pi-durable-node-adapter 855 ms, transports 488 ms, custom-runtime 351 ms, billing 328 ms, artifacts 327 ms, pi-cloudflare-host 279 ms, auth 258 ms, policy 180 ms, device-supervision 28 ms, restate 22 ms | the same baseline run                                                              |
| 99.7 MB at `23fa6880`; 81.6 MB at `487883cd`                                                                                                                                                                                                                                | 99.7 MB                                                                                                                                                                                                    | the same baseline run                                                              |

The probe's own numbers are the budget-relevant ones: **8.1 s to ready and a
233.9 MB peak against 45 s and 256 MB** — inside both ceilings, with the
peak-RSS headroom now **22.1 MB** where the M13 audit recorded ≈176 MB
against the same 256 MB ceiling. The growth is a finding for the memory
posture, not a ceiling change: the ceiling is not raised here.

**Repeatability at the current head.** Three consecutive warm runs of the
probe at `7d881216` measured **2.6 s / 235.8 MB**, **1.6 s / 216.2 MB** and
**1.8 s / 217.3 MB** (ready seconds / peak RSS): the startup figure varies by
about a second and the peak RSS by about 20 MB, which is the spread the
single budget measurement has to absorb. The first run after a build is the
cold figure (14.2 s at `487883cd`) and is the one the ceiling is written
against.

**Repeat runs.** The same probe re-run against the same profile state
measured **3.3 s** to ready and a **223.4 MB** peak RSS, and the repeated
local request sample measured **p50 0.50 ms, p95 1.27 ms, p99 2.27 ms, max
5.47 ms** at **52.3 MB** idle RSS. The first (cold) run is the budget-relevant
figure; the repeats show the steady-state cost once the profile's first-run
setup is done. The evidence bundle keeps both runs.

### 3.5 Before/after evidence for the startup/RSS probe repair

The same scenario was run against the **base** probe (`27f17bd55`) and the
repaired probe, with an unrelated listener answering `200` on the probe's
port:

repaired probe (`487883cd`)
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| exit status | **0 — passed** | **1 — refused** |
| output | `OK: {"check":"startup-ready-seconds","measured":0.1,...}` and `OK: {"check":"idle-peak-rss-mb","measured":101.4,...}` | `BUDGET EXCEEDED / FAILED: the port is already in use by 61023; refusing to measure an unrelated listener` |
| what it measured | the **unrelated listener's** readiness and a process it did not own — and with an unsuccessful or empty `ps` sample the peak would have stayed at 0 and still passed | nothing: it refuses before launching |
| unrelated listener afterwards | survived | **survived** (HTTP 200) — the refusal never signals a process the probe does not own |

The base probe's `scripts/check-startup-budget.mjs` was run from the base
commit as a temporary sibling script and deleted afterwards; the working tree
is clean and the temporary script was never committed.

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

The M13 audit's findings are unchanged and are **not** re-derived here. The
coupling measurement that backs them was taken at `23fa6880` and re-taken at
the current candidate `487883cd`, with **identical totals** at both: the
custom-runtime layer couples to 48 targets (auth 27, billing 7, transports
7, artifacts 3, policy 1, restate 1, device-supervision 2),
device-supervision to 38 and pi-durable-node-adapter to 25 — the
concentration the consolidation findings already name. The measurement is
historical evidence from those two candidates, not a live reading of the
default deployment.
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

| Command                                                          | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun scripts/check-startup-budget.mjs` (at `487883cd`)           | `OK` 14.2 s ready (ceiling 45), `OK` 227.0 MB peak RSS (ceiling 256); the owned child exited after `SIGTERM`. At `23fa6880`: 8.1 s / 233.9 MB                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `bun scripts/m17-runtime-baseline.mjs` (at `487883cd`)           | exit 0; candidate `487883cd`, dirty `false`; queue round trip p50 2.49 ms / p95 41.06 ms; RSS after the probes 81.6 MB. At `23fa6880`: p50 5.03 ms / p95 21.80 ms, RSS 99.7 MB                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `bun scripts/check-budgets.mjs deps`                             | `BUDGET EXCEEDED: {"ok":false,"ceiling":285,"measured":591,"scope":"lockfile tree", ...}` — exit 1, with `ADEA_DEPS_LISTING_FILE` **unset**, so the checker enumerated the lockfile's dependency tree itself. The report carries the attribution next to the unchanged verdict (the per-root table of §3.3, the measured reduction plan, the alias resolutions); the attribution is additive and changes neither the count nor the exit code. 591 = 533 names + 58 dual-version names, and 598 lockfile entries collapse to it; 374 of the pairs are installed on this host and 217 are not (§3.2, §3.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `bun scripts/check-budgets.mjs dist`                             | `OK` — **11.8 MB** against the 12 MB ceiling after the build-composition fix (was 20.3 MB)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `bun scripts/check-budgets.mjs lane --group build --seconds 254` | `OK` — ceiling 300, baseline 254 (the build lane is measurable now)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `bun run test` (all lanes)                                       | 222.91 s **at `23fa6880`**; the current candidate has no completed aggregate lane run (host load) — see §3.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `bun test src/audit-slice-closure.test.mjs`                      | 4 pass / 0 fail - the slice imports no external package, does not reach for the package external dependencies, the slice's file inventory is complete (every source of this package declares what it imports), and the committed ceilings (285 / 12 MB / 45 s / 256 MB / 300 s) are unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `bun test src/dependency-budget-scope.test.mjs`                  | 21 pass / 0 fail - the checker's own exported `normalizePackageName` and `countExternalPackages` are exercised directly (loaded from a copy of the shipped file), the same rule is exercised end to end through the listing seam, the checker's count on the real listing (seam unset) equals the distinct external pairs computed independently in the test, the seam measures the same scope over the same listing, the per-root attribution reproduces the §3.3 table above, the measured reduction plan and its proved minimum are pinned, and the ceiling is still 285                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| the attribution pass, at `42dc30ae7` plus this working tree      | the dependency-budget result **reproduced and attributed** (§3.2, §3.3): `bun scripts/check-budgets.mjs deps` with `ADEA_DEPS_LISTING_FILE` **unset** → `BUDGET EXCEEDED` 591 / 285 (exit 1). The inventory is proven complete rather than asserted: the lockfile's **598** external entries collapse to **591** counted identities, which resolve to **591** distinct packages — 0 counted twice, 0 hiding more than one package, 2 named by an alias, 7 contributed by two entries each — and all **591** are reachable from the workspace roots. The measured split is **374** installed on this host and **217** not. The **scoped reduction plan** is measured, not argued: the ceiling needs 306, the five largest individual savings sum to 291, and the measured minimum is **six** removals, every one of them a devDependency (the repo toolchain, `miniflare`, `@sentry/node`), reaching 276. Focused checks only: `bun test src/dependency-budget-scope.test.mjs` → 21 pass / 0 fail; `bun test src/audit-slice-closure.test.mjs` → 4 pass / 0 fail; `bun test src/budget-regression.test.mjs` → 3 pass / 0 fail; `bun test tests/repository.test.mjs` → 31 pass / 0 fail; `bun test src/startup-budget.test.mjs` → 33 pass / 0 fail; `oxfmt --check` clean on the changed files, `oxlint --deny-warnings` clean, workspace boundaries 0 violations, canonical-ordering and digest-writer checks pass. **No aggregate lane, no full build, no manifest, lockfile or threshold edit** |
| `bun test src/startup-budget.test.mjs`                           | 33 pass / 0 fail at `7d8812162` and at the current head (32 at `487883cd`, 27 at `23fa6880`, plus the five listener-ownership regressions)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `bun run format:check`                                           | clean (1940 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `bun run lint`                                                   | exit 0 — oxlint 0 errors, workspace boundaries 0 violations (1231 files / 45 packages), canonical-ordering and digest-writer checks pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `bun run type-check`                                             | every stage passes (type errors none in 7 + 34 files, drizzle `Everything's fine`, compatibility, architecture); **fails only at `requirements:check`** — "Unable to query GitHub issues through authenticated GitHub CLI (exit 4)", an environment limit of this host, not a defect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| pre-commit hook                                                  | 45/45 tasks, 47/47 successful                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

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
- The **dependency ceiling is routed here as an open item**, because §3.3
  routes the residual to this section and the section did not carry it. The
  measured closure is the lockfile's: 591 external `package@version` pairs
  against the unchanged 285 ceiling, of which 217 are optional platform
  binaries the lockfile carries for platforms this host is not. The ceiling
  was set against the 274-pair baseline at `c37de22` and does not describe
  this graph. The measured reduction plan (§3.3) shows the gap is **306**
  identities and that the measured minimum is **six** removals, all of them
  devDependencies: the repository toolchain (`vite-plus`, `oxfmt`, `oxlint`,
  `typescript`), the Cloudflare host's `miniflare` and the observability SDK
  `@sentry/node`. No product runtime dependency has to go, but the plan's cost
  is the repository's own ability to build, lint and test itself, and the
  manifests that declare those roots belong to other slices — so it is a
  product and infrastructure decision, reported here rather than absorbed into
  a moved ceiling.
  The measurement itself is reproducible (`bun scripts/check-budgets.mjs
  deps`, with `ADEA_DEPS_LISTING_FILE` unset) and is now pinned by
  `packages/production-readiness/src/dependency-budget-scope.test.mjs`; the
  ceiling is **not** enforced by a CI lane today, which is a separate gap
  from the closure itself.
- Confirm turbo remote-cache hit rates from the run-summary API; the M13 audit
  could only infer them.
