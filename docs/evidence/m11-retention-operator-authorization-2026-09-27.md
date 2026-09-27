# M11 retention operator authorization checkpoint

Decision: **not accepted**. This records a host-operator implementation and
focused regression evidence for #194, not whole-profile, deployment, security,
restore, or Milestone 11 acceptance. The source base is draft PR #743 at
`b04935af3b386c2edb466a0432f4ae7212743ceb`, based on released main
`622f90cecd4c2923abccc8b68a6b540f0ea78bf9`.

## Implemented boundary

The new hold administration command loads an explicitly provisioned, bounded,
UID-owned, non-group/world-writable, no-follow policy file. It binds the exact
SQLite canonical file or PostgreSQL hostname/database. Class owners must match
the decided retention policy. Finite grants bind verified OS principal,
authenticated database authority where applicable, class, scope, and action.
No owner or administrator grant is inferred from a role label or credential.
Request attribution must equal the real session; spoofed claims are not silently
replaced. Hold output excludes reason and principal.

Physical `retention-apply --apply` now requires `--hold-policy` and a class-wide
`sweep` grant, including when no holds exist. Workspace/project authority does
not authorize an unscoped whole-class pass. Configured dry runs need `assess`;
legacy unconfigured dry runs still depend on the existing empty-hold-namespace
guard. The parsed policy reaches the actual repository deletion guards.

## Actual checks and corrections

- Missing-policy regression initially failed: confirmation alone deleted the
  real eligible SQLite record. The new authorization gate refuses it and keeps
  the record without inventing a hold.
- Helper regressions reproduced two defects: a first grant for another project
  shadowed a later matching grant; an inherited object key was accepted as a
  configured class. The helper now searches all exact matching grants and uses
  own-key checks. Negative configuration tests first establish that the valid
  configuration loads, preventing a missing module from masquerading as a
  successful rejection.
- Initial operator/CLI/restore run passed **23 tests, 149 assertions**.
- A real subprocess created a SQLite project hold; actual deletion then retained
  the record and wrote no journal. A project-only sweep grant was denied without
  deleting or journaling. Explicit authorized release enabled deletion and one
  payload-free journal entry. The focused path passed **one test, 20 assertions**.
- Broader validation first failed **50 passed, two failed, 170 assertions**.
  The repository's expected integration inventory omitted five new PostgreSQL
  fixtures; its exhaustive expected list was corrected, not weakened. The close
  regression initially patched a source constructor rather than the CLI's public
  compiled adapter; that run was not proof of an injected cleanup failure.
- After correcting that injection, the actual public adapter emitted
  `RETENTION_APPLY_CLOSE_FAILED` but returned success: **zero passed, one failed,
  two assertions**. Returning the status after awaited cleanup fixes the
  entrypoint's overwrite of cleanup failure.
- Integrated operator, retention CLI, restore regressions and repository checks
  then passed **52 tests, 172 assertions, four files**, in 12.47 seconds. Existing
  assertions and deadlines were not relaxed. Scoped lint passed with zero warnings.
- The first actual PostgreSQL operator case failed before assertions because the
  root script imported undeclared `drizzle-orm`. The query was moved into the
  owning database adapter, using the authenticated connection's `current_user`.
  Its isolated database was disposed; this failed run is not PostgreSQL acceptance.

- After that dependency fix, the fresh build passed all **35 dependency-graph
  packages** (zero cached), in 6 minutes 41.959 seconds. This is not a claim that
  every workspace acceptance lane ran.
- The post-build integrated operator/CLI/restore/repository run passed again:
  **52 tests, 172 assertions**, in 39.02 seconds. The repository check now includes
  the new PostgreSQL operator fixture in its exact integration inventory.
- The actual PostgreSQL operator CLI case passed **one test, 38 assertions**, in
  69.04 seconds. Each child invokes the real entrypoint against the isolated
  migrated database; authority is checked against its authenticated application
  role. It rejects forged principal/authority without a hold, denies project-only
  class sweeps, preserves a held package without journaling, refuses a wrong-target
  release, replays authorized release, then deletes with the original 90-day
  reference window and exactly one journal operation. The isolated database was
  disposed and no test child remained.

Final fixture review moved its first reference observation after package
compilation and before the actual release, adding explicit release-between-
observation-and-expiry assertions. The final chronology-corrected rerun passed
**one test, 40 assertions, zero failures**, in 39.65 seconds. The original
90-second case deadline and 15-second child deadlines were unchanged. No
production or staging mutation is included.

## Remaining requirements

The subsequent [operator feature-entrypoint checkpoint](m11-operator-feature-entrypoints-2026-09-27.md)
records current import-boundary work and a passing PostgreSQL rerun. Final-head
full SQLite validation still fails the catalog CLI deadline, so the readiness
gate remains open despite intermediate passing runs.

Current-candidate full package/workspace checks, required CI, security review,
released activation, and least-privilege credential provisioning remain open.
The old full SQLite failures are not superseded by focused operator successes;
catalog CLI still reproduced its unchanged five-second timeout. Import timings
suggest fanout contributes to startup cost but do not prove it is the sole cause.

The host adapter is not a hosted product-user grant endpoint or proof of every
application composition. Unix UID/no-follow enforcement is not Windows support.
Released-hold disposition, independently durable ordered hold/delete outcomes,
restore reconciliation before exposure, every remaining durable class, provider
TTL/deletion coordination, actual supported-profile RPO/RTO, runtime/provider
evidence, native document reconciliation, and independent human acceptance remain
required. Neither this checkpoint nor a green focused suite closes #194 or M11.
