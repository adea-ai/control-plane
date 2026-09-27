# M11 operator feature-entrypoint checkpoint

Decision: **not accepted**. This is a partial checkpoint for #188 and #194,
based on PR #743 at `a3796bc4ee870c58984baafedff377332bc0a894` and released
main `622f90cecd4c2923abccc8b68a6b540f0ea78bf9`. Full validation is still failing.

## Implementation and compatibility

The catalog and context administration scripts now import their domain feature
entrypoints and load only the selected persistence backend. SQLite publishes
provider, catalog and context-administration subpaths. The provider, two catalog
repositories and shared record helpers were extracted without changing their
method bodies, namespace identifiers, hash keys or transaction behavior.
The aggregate package still re-exports the same implementations. A regression
checks public aggregate/subpath constructor identity and prohibits unrelated
repository re-exports from the provider source.

The contention fixture's two native workers now import the actual provider and
event repository directly instead of the entire aggregate. It still observes a
real blocked `BEGIN IMMEDIATE`, commits the hold first, checks no deletion and
retained readback, and terminates both workers before reopening. Its original
five-second deadline and all assertions remain unchanged.

The PostgreSQL operator fixture no longer imports a root script across the
package boundary. Its session expectation uses the OS principal and the owning
database adapter's authenticated `current_user`. Every operator child still runs
the real CLI. Spoofing, wrong target, scoped authority, hold, release, deletion
and journal assertions remain intact, with original deadlines.

## Evidence and failures

- Before extraction, the original catalog subprocess case reproduced its
  five-second timeout. The initial public-entrypoint regression failed because
  the provider subpath did not exist.
- Domain and SQLite TypeScript builds passed after extraction. An independent
  bounded Luna source review compared the extracted provider, catalog methods
  and record helpers with their originals. Its initial finding of three
  repository exports on the provider was corrected by moving those exports
  to the aggregate root, preserving compatibility.
- Final independent source review verified matching SHA-256 values for the
  extracted provider and catalog class bodies, and equivalent helpers after
  accounting for their new export declarations. It verified aggregate API
  preservation and unchanged contention/ordering/readback/deadline logic;
  no actionable finding remained. This is not a full security or human audit.
- Scoped formatting passed on all 15 changed implementation/test/manifest files;
  dependency boundaries passed for 1,466 files across 41 packages.
- The initial catalog/entrypoint checks passed three tests and 22 assertions;
  the catalog subprocess case completed in 2.899 seconds. An intermediate
  full SQLite run passed 156 tests and 992 assertions in 19.85 seconds, **before**
  the final provider-isolation regression and worker-import change. This is
  historical evidence, not final-head whole-package acceptance.
- Current domain suite: 163 passed, zero failed, 547 assertions, 20 files.
- Current operator/CLI/restore/repository checks: 52 passed, zero failed,
  172 assertions, four files. These do not cover every workspace or profile.
- A full SQLite run concurrent with the above suites failed: 156 passed,
  one failure, one error, 994 assertions in 46.65 seconds. Catalog timed out.
- The subsequent SQLite-only run passed catalog (4.615 seconds) and context
  administration (10.387 seconds), but failed the original five-second
  contention case: 156 passed, one failed, 992 assertions in 39.97 seconds.
- After narrowing the worker imports, the contention case passed alone:
  one test, three assertions, 3.986 seconds, without changing its deadline.
- The final full SQLite run still failed: 156 passed, one failed, one error,
  989 assertions, 157 tests/26 files in 63.55 seconds. Contention passed, but
  catalog timed out at 5.190 seconds with empty replay output. Context
  administration passed in 19.447 seconds. No further retry is used as acceptance.
- The actual migrated PostgreSQL operator fixture passed one test and all
  40 assertions in 24.56 seconds. Zero isolated test databases remained, and
  the task-owned container was stopped with its listener closed.

Observed host CPU contention from unrelated workloads may contribute to timing
variance; it is not established as the sole cause, and those processes were
left untouched. Startup reliability remains an open validation defect.

## Remaining gates

Do not mark this PR ready or merge on these results. Final-head full package and
workspace validation, required CI, review of the new patch, released activation
and all original M11 acceptance gates remain required. The completed security
review of the earlier authorization checkpoint does not cover this new diff.

Released-hold disposition, independently durable ordered hold/delete outcomes,
restore reconciliation before exposure, every remaining durable class and
provider TTL coordination remain incomplete. In particular, usage retention
must not delete raw accounting rows before durable budget/settlement state,
aggregates and replay/conflict fences exist. Runtime/provider/profile evidence,
native document reconciliation and independent human acceptance are separate
unwaived requirements. No production or staging resources were changed.
