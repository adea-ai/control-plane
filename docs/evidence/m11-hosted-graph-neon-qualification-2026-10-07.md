# Hosted graph qualification on the Neon lane — 2026-10-07

## Finding and scope

The complete post-merge Neon run 37643352492 on
`f693e1153b00e1c5af539ec76818b8fc263d6d95` passed 245 tests but skipped the Hosted
PostgreSQL/Restate graph scenario and its hooks. The generic database runner did not supply
`RUN_HOSTED_GRAPH_RESTATE_INTEGRATION` or a Restate environment. A successful aggregate therefore
did not qualify that graph scenario on its candidate. This is a qualification gap in #188/#194;
the historical 2026-10-03 host-launcher evidence is not a replacement for a current run.

## Implementation

Shard 3 delegates this one file to the required **Verify Hosted PostgreSQL and Restate graph**
step. Every integration file retains its existing shard owner. The dedicated qualifier uses that
shard's existing least-privilege Neon URLs and the digest-pinned Restate image from supported
Compose configuration. It creates one bounded, labeled Restate container on the disposable Linux
GitHub runner, with an ephemeral journal and a fresh request-signing identity. It creates no extra
Neon branch and adds no integration-file retry or job-timeout increase.

The root command is:

```sh
bash scripts/run-hosted-graph-qualification.sh
```

This entry point requires GitHub Actions, an absolute runner temporary directory, numeric run
identity, and the existing shard's application, migration, and administration database URLs.
It refuses a normal local invocation before any Docker command. No local Docker operation is
needed to validate the runner's control flow with the executable doubles.

The qualifier enables the real graph integration flag and requires the named scenario to pass,
one passing test, and no failed or skipped tests. Empty output or an unrelated passing scenario
fails qualification. It exercises the existing authenticated Hosted launcher, PostgreSQL
checkpoint, persisted approval, cold application restart, one artifact/tool charge, and replay.
The baseline classifier requires this successful step on shard 3; older green runs that skipped
the graph can no longer authorize a skip. Qualifier, identity, cleanup, and Compose-pin changes
are migration-relevant inputs.

## Resources and cleanup

The owned fixture records container identity and ports before startup. Docker commands are
bounded, and the container has CPU, memory, and PID limits, no restart policy, no capabilities,
and no persistent volume. The container uses the identity creator's UID/GID, with matching
private journal ownership, so dropped capabilities do not prevent reading the 0600 signing key.
The private identity and test temporary directories stay under the
owned fixture. The test child is recorded before launch, waited for through an interruptible
background job, and reaped before container removal. Cancellation forwards TERM only to the
still-owned child; GNU timeout forwards it to the test process group with its five-second
escalation bound. Success, failure, failed creation acknowledgement, and handled signals run
teardown. SIGKILL cannot run shell traps; the disposable runner remains the final containment
boundary for an abruptly killed runner process. Test output is printed after reaping.
Removal requires the exact container name and matching ownership label; a failed lookup or
teardown preserves reconciliation data and fails the step. Successful removal is followed by
an absence check before the owned fixture is removed. No broad prune or image-cache deletion
is performed.

## Evidence limits

The local lifecycle tests use fake executables; they prove control flow and cleanup, not Restate
or deployed graph execution. The optional system-timeout regression uses GNU `gtimeout` or
`timeout`; it is explicitly skipped when neither is available on a developer machine, while
the executable-double lifecycle cases still run. Ubuntu CI supplies GNU timeout. Real qualification is pending a complete trusted-main run containing
the new step and its cleanup receipt. The Hosted application runs through its production `start()`
launcher on the runner, with real Docker Restate and Neon PostgreSQL. This is not the Hosted
Compose application image, native Pi/ACP/provider execution, capacity, measured RPO/RTO, financial
hard-budget enforcement, or complete frozen-candidate M11 acceptance. Those original gates remain
open. No new acceptance waiver is introduced.
