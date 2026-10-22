# Integration runner interruption cleanup — 2026-10-15

## Candidate and requirement

Base: `f1bd75c58` (`main`) on `fix/issue-189-integration-runner-cleanup`. The
candidate was authored on `2a02db89f` and was rebased onto the current `main`
so it merges without a conflict; the interruption behaviour and its assertions
are unchanged, and the rebased runner keeps the current `main` command surface
(`vp` orchestration and the current root-level scenario list). This lane addresses the
[#189](https://github.com/adea-ai/control-plane/issues/189) audit finding that
`scripts/run-integration-tests.mjs` had only `finally` cleanup and no
`SIGINT`/`SIGTERM` handling, so an interrupted run could leave its owned Compose
project behind. It does not touch the other #189 acceptance items or #1048
fixtures, and it does not close #189.

## Reproduction

The command-double lifecycle suite first gained failure-injection hang points
(`FAKE_DOCKER_HANG_ON`, `FAKE_BUN_HANG`) and interruption regressions.
Against the unfixed runner:

```
bun test tests/integration-runner-lifecycle.test.mjs
24 pass, 5 fail, 72.91 seconds
```

The new cases failed because the runner died from the bare signal
(`status null`) instead of exiting `128 + signal`, and the frozen startup/cleanup
cases hung for the full 30-second harness budget. The 24 pre-existing ownership
and policy cases still passed, so the injection itself did not regress existing
behavior.

## Orphan finding and root cause

A later heavy smoke run was terminated mid-flight and left orphaned
runner-owned interpreter doubles running under this task's isolated
`cp-integration-lifecycle-*` scratch directories. They were reaped by exact PID
and their scratch directories removed before new qualification.

Root cause: `runLocalIntegrationShards` starts the three shards concurrently.
The first signal only reaped the children that were already tracked at that
instant, but the runner had no guard against starting _new_ owned commands
afterwards. A shard that spawned its command after the handler ran created a
frozen child that nothing ever killed; it then blocked `Promise.allSettled`, so
the runner never exited, the harness hard-killed it, and the detached child
groups were orphaned. The earlier choice to spawn every child in its own
(`detached`) process group made those orphans unreachable by any process-group
termination as well.

## Change

- Every runner-owned child is recorded in `activeChildren` and stays in the
  runner's own process group, so an explicit handler, a `process.on('exit')`
  reap, and an external group termination can all reach it. Only recorded
  children are signalled; nothing is looked up or killed by name.
- `run()` spawns asynchronously instead of `spawnSync`, so a frozen Docker
  command can be reaped during startup; every former non-awaited call site is
  awaited. The bounded readiness probe keeps its `spawnSync` deadline, gains an
  interruption check, and yields one macrotask after a timed-out probe so a
  signal delivered during the blocking wait is observed rather than surfaced as
  a probe timeout.
- Installed `SIGINT`/`SIGTERM` handlers reap the recorded children and run the
  same single, idempotent owned-cleanup path once (fresh project: `down
  --volumes`; caller project: `stop postgres`). The process exits with
  `128 + signal`.
- After the first signal, `run()`/`runStreaming()` refuse to start any new owned
  command. The shared cleanup is the sole caller that passes
  `allowInterrupted: true`, so it can still release owned resources.
- A recorded verification failure is still printed when an interruption owns the
  exit status, so the original failure is not masked by the signal or cleanup. A
  second signal stops immediately with the signal's status.
- **The owned PROCESS TREE is terminated, not only the direct child.** Killing
  the wrapper PID left a nested build/`vp` descendant alive; that descendant kept
  the inherited pipes open, so the child's `close` event never arrived and the
  interruption cleanup hung with the owned child still running. The runner now
  walks the parent links of the PIDs it already owns (never a lookup by name, and
  never upwards, so the caller's own process and process group are outside the
  result), terminates those descendants first and the direct child after them,
  and then VERIFIES the tree: a descendant that is still alive after a bounded
  wait is reported as a survivor, because the direct child's exit is not proof
  that its tree was reaped.
- **The completion of a terminated child is BOUNDED.** A descendant that cannot
  be attributed to the owned tree any more (it was re-parented to init) can
  still hold the pipes, so `close` is not guaranteed to arrive. The runner then
  fails the run with the exceeded bound, releases the pipes it still holds —
  an open reader would keep the event loop alive and the runner would never
  exit — and finishes. A survivor is never killed, because the runner cannot
  prove it owns it.

## Verification

- `bun test tests/integration-runner-lifecycle.test.mjs`: 34 passed, 0 failed,
  143 assertions on the reviewed head. The suite now covers startup,
  readiness-probe, test-execution and cleanup interruption, caller-owned
  project preservation, and the no-new-command guard.
- The two owned-tree regressions, run against the reviewed head's runner
  (`237ff5e41`, before this repair) and against the repaired one:
  - `an interruption reaps the owned descendant that holds the inherited pipes`:
    against the reviewed head the runner did not exit within 15 000 ms of
    `SIGINT`; against the repaired runner it exits `130`, the owned descendant is
    gone, the runner reports no survivor, and an unrelated process is untouched.
  - `a stalled pipe is bounded when the survivor can no longer be attributed to
    the owned tree`: against the reviewed head the runner did not exit within
    25 000 ms of `SIGTERM`; against the repaired runner it exits `143` with the
    bound reported, and the un-attributable survivor is left alive because the
    runner cannot prove it owns it.
    Both cases spawn the descendant deterministically through the command double,
    so the regression does not depend on a race.
- Isolated new cases
  (`--test-name-pattern 'readiness probe|spends no new owned command'`):
  2 passed, 9 assertions, 5.34 seconds; the readiness case spends its real
  five-second probe bound.
- `bun test tests/neon-workflow.test.mjs`: 55 passed, 0 failed, 448 assertions.
- `bun test tests/repository.test.mjs -t 'provides a documented isolated
  integration-test runner'`: 1 passed.
- `bun test tests/docker-pull-backoff.test.mjs -t 'integration and PR workflows
  pull before starting Postgres'`: 1 passed.
- Scoped `oxfmt --check`, `oxlint --deny-warnings`, `node --check` (pinned Node)
  and `git diff --check` on the changed files passed.

## Limits

No local Docker engine, database, install, build or real integration suite was
run to validate this change; the executable doubles prove command selection and
process reaping, not physical container/volume reclamation or full Docker/profile
acceptance. `SIGKILL`, daemon loss and machine shutdown still cannot execute
JavaScript cleanup, so the owner-recorded `COMPOSE_PROJECT_NAME` remains the
fallback for those cases. The nested image pull and SQL readiness probes are
still bounded synchronous calls, so an interruption is honored after the
in-flight probe returns (at most its own five- or ninety-second bound). The
working-tree `bun test tests/repository.test.mjs tests/docker-pull-backoff.test.mjs`
run reported 1 unrelated failure (`Cannot find module '@control-plane/contracts'`
from `packages/production-readiness`), which is a missing build output in a
clean worktree, not this change: after `bun run build` (47/47 successful) the
same repository policy suite passes 31 passed, 0 failed. Whole-candidate CI, the
full #189 acceptance map and independent review remain pending.
