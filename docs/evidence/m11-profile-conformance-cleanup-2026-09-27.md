# M11 direct-port profile conformance and failure cleanup

## Corrections

The CP1 profile matrix previously closed worlds only after successful assertions.
SQLite/PostgreSQL setup failures could escape before returning a world, and a
failed close could prevent the remaining cleanup. The fixture now registers each
owned directory, provider, runtime, or isolated database immediately after acquisition
and releases them in reverse order. Runtime drain precedes provider close and
directory removal. Every disposer is attempted; one error is preserved and multiple
scenario/cleanup errors are reported together rather than hidden.

The shared conformance runner also used fail-fast `Promise.all` for parallel profile
adapters. A failing adapter could return control to fixture cleanup while a sibling
was still acquiring or using its world. It now settles all started adapters before
propagating errors. A sole adapter rejection is preserved; multiple rejections are
aggregated in adapter order. Failed adapters never produce a passing partial report.

No native persistence path, scenario assertion, production deadline, or existing
fixture timeout was relaxed. The SQLite parity case retains 60 seconds; the actual
PostgreSQL matrix retains 600 seconds. Its comment now correctly describes six
PostgreSQL worlds across three cases, not three worlds.

## Regression and actual database evidence

- The resource helper's initial happy-path-only cleanup ordering failed all three
  new failure-contract regressions. The corrected helper passes partial acquisition,
  scenario-plus-close failure, and close-failure-with-successful-scenario cases.
- Actual SQLite tests verify a partially seeded world and a running world are closed
  and their exact temporary directories removed after failure.
- Two held-sibling package regressions failed with the old shared runner, then
  passed after the drain fix. They keep a sibling pending after another adapter fails,
  verify the overall operation has not settled, and cover single and multiple errors.
  The test releases its gate and joins the operation even when an assertion fails.
- Complete profile-portability package: 27 passed, zero failed, 225 assertions.
- Initial PostgreSQL-enabled CP1 run before the shared-runner correction:
  10 passed, zero failed, 35 assertions, 65.28 seconds.
- Final PostgreSQL-enabled CP1 run after all corrections:
  **11 passed, zero skipped, zero failed, 38 assertions**, 154.06 seconds.
  Includes real PostgreSQL partial-setup disposal and the full four-profile matrix.
  The matrix itself took 102.16 seconds. Separate application, migration, and
  administration roles were used; all worlds used actual migrated PostgreSQL or SQLite.
- After the final run: zero isolated test databases, no remaining PostgreSQL test
  sessions, owned container stopped, and its loopback listener verified closed.
- Bounded independent Luna review identified the sibling race; the final re-review
  found no new actionable issues. The reviewer made no changes and ran no tests.
- Canonical workspace `bun run test` passed: unit 1,575 passed/zero failed,
  E2E 146 passed/zero failed, smoke 205 passed/two PostgreSQL cases skipped/zero
  failed. Total **1,926 passed, two skipped, zero failed**. Both smoke skips were
  separately executed successfully in the PostgreSQL-enabled CP1 run above.
  Unit coverage: 82.39% lines, 84.15% functions; existing 80% thresholds unchanged.
  Native lane timing gates are CI-only and were not enforced by this local run.
- Workspace type-check/build, lint, and formatting passed. Five pre-existing package
  lint warnings remain. Repository credential scan passed across 1,243 files;
  this is not the full M11 security/adversarial audit.

## Evidence boundaries

The matrix covers acceptance/completion, interaction/resume, and cancellation
through the durable lifecycle and real persistence stores. Runtime responses are
scripted direct ports. It is not live Railway, HTTP ingress, Restate deployment,
provider certification, budget enforcement, or billing settlement evidence.
Original M11.3 and M11.9 production/profile gates and M11.12 independent acceptance
remain open. The PR remains draft until its outstanding readiness gates are proven.

The prior `c920c773` canonical report's total was mis-added: 1,571 unit + 146 E2E +
200 smoke = **1,917 passed**, not 1,817. The exact historical issue comment was
corrected; individual lane results were not changed.
