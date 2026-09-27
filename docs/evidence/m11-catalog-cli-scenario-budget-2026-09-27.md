# M11 catalog CLI scenario budget correction

This supersedes the outstanding catalog fixture deadline diagnosis in the
[feature-entrypoint checkpoint](m11-operator-feature-entrypoints-2026-09-27.md).
It does not accept #188, #194 or Milestone 11.

The fixture invokes five real CLI processes serially: record, replay, show,
reject stale revision and reject wrong target. Each has a 15-second subprocess
limit, but the combined test inherited Bun's five-second default. Earlier
whole-package failures show the runner killing an active child at that outer
limit, returning null status or empty output before the child limit expires.
An intermediate whole-package run passed with catalog taking 4.615 seconds;
later host-load variation again exceeded five seconds. These failed results
remain recorded in the earlier checkpoint.

Temporary phase tracing on the unchanged five-second fixture measured successful
record/replay/show calls at 255.75, 225.34 and 322.94 milliseconds and stale
rejection at 265.41 milliseconds, with expected exit statuses and no signals.
The complete original scenario passed in 1.364 seconds. This establishes that
the case is timing-sensitive, not that every workload meets a production SLO.
Tracing was removed.

The corrected fixture explicitly uses the existing canonical repository lane's
30-second scenario budget, also used by the adjacent context operator fixture.
All five subprocess limits remain 15 seconds; no production deadline changes.
Replay and show now also assert successful exit status before parsing output.
No existing assertion was removed, and no process call became an in-process mock.

The actual package command, `bun run test` from `packages/sqlite-persistence`,
then passed **157 tests, zero failures, 997 assertions, 26 files**, in
**44.79 seconds**. The native hold-contention case retained its five-second
deadline and passed in 534 milliseconds. This is whole-package evidence for
the corrected candidate, not whole-workspace, CI, deployment or profile acceptance.

An independent bounded Luna delta review verified the five real child calls,
unchanged child limits, preserved assertions, strengthened exit checks, and
alignment with the root unit/E2E/smoke and neighboring context scenario budgets.
No actionable finding remained. Independent security/human and all original
milestone acceptance gates remain separate. No provider resources were started.

## Canonical candidate validation

The full workspace build and OpenAPI checks passed **43 tasks, zero cached**, in
2 minutes 58.195 seconds. Type-checking initially exposed stale requirements
report and architecture package metadata. The maintained reports were regenerated
and verified without waiving requirements: architecture changed only 12 current
manifest versions and the two reviewed packages' public exports. The requirements
ledger changed only the M7.9 audit row semantically, correcting its overclaim:
row conversion and workspace-scoped PostgreSQL append/read tests do not prove
durable budget opening, reservation settlement, restart hydration or production
accounting wiring. That high-severity gap remains assigned to open #194.

After those corrections, `bun run type-check` passed build/OpenAPI, database
schema drift, runtime compatibility, live GitHub requirements checks, architecture
and infrastructure typing. The second build reused the first fresh build's 43
tasks. The ledgers validate 200 requirements, 103 historical issue audits,
41 packages, 16 public operations and four profiles; validation of their
structure does not certify every partially verified or missing behavior.

The canonical `bun run test` then passed:

- Unit: **1,571 passed, zero failed, 6,926 assertions**, 202 files, 154.92 seconds.
- E2E: **146 passed, zero failed, 876 assertions**, 17 files, 104.03 seconds.
- Smoke: **200 passed, one skipped, zero failed**, 24 files, 54.45 seconds.
- Unit coverage: **82.38% lines, 84.14% functions**, above both existing 80% gates.

The skipped case is cloud PostgreSQL persistence-profile conformance, explicitly
owned by the separate Neon integration lane. This run does not certify it.
Lane-duration budget enforcement is CI-only and was not executed locally.

Full `bun run format:check` passed 1,084 files. Full `bun run lint` passed all
41 package tasks, repository tests, dependency boundaries and canonical ordering;
existing package-level warnings remain, not a zero-warning claim. Required CI,
full actual PostgreSQL integration, production activation, security, durable
accounting/retention implementation and independent human/profile acceptance
are still unwaived. The earlier authorization security report covers its frozen
diff only; these new changes are not included in that report.
