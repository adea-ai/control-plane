# M11 Neon creation and cleanup reconciliation

## Finding and scope

On source `6d789a55c03cb306139fe7c0a0b10555229a9535`, trusted-main
[run 37570244992](https://github.com/adea-ai/control-plane/actions/runs/37570244992)
shard 3 timed out after 10 seconds in Create Neon branch. Its lookup and deletion
steps were skipped because cleanup required a successful creation acknowledgement.
The exact target is `preview/main-37570244992-1-s3`, attempt 1. Its existence was
unverified at preparation time. The run subsequently completed as cancelled;
shards 1 and 2 reported successful lookup/deletion, without a post-delete absence
check. This change does not establish the cause of the cancellation.

A lost response to a non-idempotent creation request does not prove that no branch
was created. The workflow now searches for the exact owned target whenever its
name was prepared, including after a failed creation action. It retains the
existing bounded, read-only lookup retries, complete pagination, and rejection of
duplicate, protected, primary, default, root, or malformed branch metadata. It
does not retry branch creation.

Main runs now use `cancel-in-progress: false`, preserving in-progress verification
and teardown. GitHub concurrency can replace pending runs; this is not a guarantee
that every pending source gets tested.

## Cleanup-only follow-up

The manual workflow accepts an original run ID, attempt, shard, and source SHA.
It runs only from `refs/heads/main`. Before querying Neon it requires a completed
push-to-main run of this exact workflow and repository, the recorded SHA and
attempt, a complete jobs response, and exactly one completed matching shard and
creator step. Active, ambiguous, mismatched, or incomplete ownership fails closed.
The current run attempt must match; an older attempt after a rerun is refused.

The manual path shares the normal lookup and verification scripts using YAML
anchors. It performs no creation, dependency installation, build, migration, or
database test. Deletion receives only the validated branch ID. All four database
connection variables are blank in cleanup steps. API errors are not absence.

For the recorded failure, after this workflow lands on main:

```sh
gh workflow run neon_workflow.yml --repo adea-ai/control-plane --ref main \
  -f cleanup_run_id=37570244992 -f cleanup_run_attempt=1 \
  -f cleanup_shard=3 \
  -f cleanup_head_sha=6d789a55c03cb306139fe7c0a0b10555229a9535
```

After deleting a resolved target, bounded GET retries require HTTP 404 for that
exact branch ID. This proves branch metadata absence at observation time, not
physical storage reclamation or completion of every asynchronous Neon operation.
An absent manual lookup after an uncertain creator keeps the original creation
acknowledgement unknown; it does not prove that creation never happened.

## Validation and resource boundary

The original workflow failed both new baseline regressions: cleanup after an
unacknowledged create was not eligible, and missing branch metadata incorrectly
settled an unknown creation outcome. The changed inline scripts are executed in
Node VM tests with synthetic API responses. Coverage includes terminal ownership,
wrong SHA/repository/workflow/attempt, live and ambiguous creators, unsafe branch
metadata, pagination, transport failures, authorization failures, bounded retries,
and post-delete metadata verification. These are synthetic checks, not a live
Neon deletion receipt or complete M11 operational acceptance.

The first hosted CI head caught another repository assertion that still required
push-only events (Core and Smoke both reported `tests/repository.test.mjs:779`).
That assertion now allows cleanup dispatch only from main, forbids PR events,
requires the verification job to remain push-only, and forbids provisioning or
database work in the manual job. The focused command
`bun test ./tests/neon-workflow.test.mjs ./tests/repository.test.mjs --test-name-pattern Neon`
passed 46 tests in 13.63 seconds. No production workflow behavior changed in this
follow-up; hosted CI must pass on its new head before merge.

Local validation uses a 20-second process-group deadline, one sequential fixture,
512 MiB Node heap cap, and no dependency installation. Local Docker is kept off;
no daemon queries, containers, images, volumes, global pruning, or VM file edits
are performed. The user-reported 150GB footprint and its reclamation remain
unverified. The small owned worktree and fixtures are removed after publication.
Full build, integration, and container checks belong to the existing hosted CI.

Standards and spec reviews are sequential local reviews because independent
review capacity was unavailable. This is not two independent review approvals.
Issue #194 remains open for its full original acceptance scope, including
retention, recovery, observability, rotation, and actual operational evidence.

## Primary references

- [Neon creation](https://api-docs.neon.tech/reference/createprojectbranch)
- [Neon branch listing](https://api-docs.neon.tech/reference/listprojectbranches)
- [Neon branch details](https://api-docs.neon.tech/reference/getprojectbranch)
- [Neon deletion and asynchronous operations](https://api-docs.neon.tech/reference/deleteprojectbranch)
- [GitHub workflow anchors and aliases](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)
