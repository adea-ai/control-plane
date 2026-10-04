# Integration fixture cleanup — 2026-10-04

## Candidate and requirement

Base: `cb68d5914cd5f34489706bbdcf887c487f3faf28`. This lane supports
[#189](https://github.com/adea-ai/control-plane/issues/189)'s isolated integration
resources, cleanup assertions and documented time limits. It does not close the
full M11 acceptance scope.

## Reproduction and change

The previous runner queried Docker before selecting a remote database target.
A fake unavailable Docker executable made a remote verification fail before any
integration command. Locally, the runner stopped a fixture it started but left
its named volume behind. The new command-double suite reproduced these defects:
initially 2 cases passed and 7 failed.

Remote classification and required administrator validation now precede every
Docker call. Local runs reuse an already running service without stopping it.
A newly started fixture without an explicit caller project gets a unique project
name recorded before startup; `finally` removes only that project's containers,
network and volumes after success, test failure or partial startup failure.
Explicit caller projects preserve their volume and retain the original stop-only
behavior when the runner started PostgreSQL. The recovery matrix retains its
outer project cleanup. The runner and its nested PostgreSQL disruption/restore Docker calls have a
90-second process ceiling; each SQL
readiness probe is capped by both five seconds and the remaining 30-second readiness
window; polling sleeps use the remaining budget too.
Cleanup failure fails the run; simultaneous verification and cleanup failures
retain both errors.

The pull-request PostgreSQL job assigns a run/attempt-specific project and owns
an `always()` volume cleanup step with a three-minute step ceiling. The lifecycle
suite belongs to the primary smoke lane and executes the actual integration
runner with bounded fake Docker/Bun executables.

## Local evidence

- `bun test tests/integration-runner-lifecycle.test.mjs`: 16 passed, 0 failed,
  52 assertions, 5.68 seconds after the review repairs. Four additional source-function
  regressions first reproduced readiness overshoot and missing nested command bounds. Each runner child has a two-second deadline;
  each invocation owns one temporary directory and removes it in `finally`.
- `bun test tests/neon-workflow.test.mjs --test-name-pattern 'runs pull-request PostgreSQL'`:
  1 passed, 33 filtered out, 0 failed, 11 assertions.
- `bun test tests/repository.test.mjs --test-name-pattern 'integration-test runner|schedules every test file|primary test job'`:
  1 passed, 29 filtered out, 0 failed. Only the documented runner case matched
  this filter. The separate four-case inventory check reproduced the missing
  smoke inventory expectation; that expectation was repaired alongside registration.
- `bun test tests/repository.test.mjs --test-name-pattern 'discovers disjoint Bun|schedules every discovered integration|provides a documented isolated integration|enforces deterministic Bun'`:
  4 passed, 26 filtered out, 0 failed after the inventory repair.
- Scoped Oxfmt check, Oxlint with `--deny-warnings`, and `git diff --check` passed.
- Existing cached Code Foundry 1.44.3 `doctor`: passed from the source checkout.
- Full `bun test tests/neon-workflow.test.mjs`: 34 passed, 0 failed,
  270 assertions, 12.67 seconds (before the final error-propagation lint repair).

## Limits

No local Docker command contacted the engine, and no database, package install,
heavy build, persistent server or actual integration suite was run locally.
Command doubles prove ownership and command selection, not physical reclamation
or full Docker/profile acceptance. The reported 150 GB and its source are not
measured or reclaimed by this change. Shared images/build caches and unrelated
resources are never pruned. A hard kill, daemon loss or machine shutdown cannot
execute JavaScript cleanup; residual projects still require their recorded owner
identity. Explicit SIGINT/SIGTERM handlers are also absent; docs retain that
interruption gap and the owner-scoped follow-up command. Whole-candidate CI, actual PostgreSQL cleanup and independent review are
pending until separately verified at the current PR head.
