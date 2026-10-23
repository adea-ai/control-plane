# Continuous integration

Code Foundry v1.48.1 is the CI runtime pinned by the generated callers under
`.github/workflows/`. Feature branches target `main`; Railway staging is an
on-demand reference environment, not a Git promotion branch.

## Required pull-request gate

`Validation / Gate` is the single stable Code Foundry check. The repository uses
the direct Git workflow, so the generated pull-request caller targets `main`.
Ordinary ready-for-review pull requests run CI, all four test
jobs, Security, and CodeQL. Release Please pull requests use
the separate release-policy tier. Each tier fans out independent jobs
and aggregates their results. Each workflow cancels superseded work for the same
branch while unrelated pull requests, scheduled audits, and manual runs remain
parallel. Turborepo schedules build work from its dependency graph, while Bun's
`--parallel` mode is limited to the independent top-level test groups.

The gate covers:

- frozen Bun lockfile installation with the pinned Node and Bun toolchain;
- formatting, lint, package-boundary enforcement, workspace type-checking, and
  builds;
- unit, E2E, and smoke groups as independent parallel jobs, including isolated
  databases, deterministic migration replay, enforced 80% unit coverage, and LCOV upload;
- the E2E group split into two balanced shards, so the lane's wall clock is the
  slower shard instead of the sum of all 43 files. The shards run the same
  files, tests and assertions, and each shard is measured against the same
  reviewed lane ceiling;
- OpenAPI drift and Drizzle migration-schema drift through `bun run type-check`;
- dependency auditing that does not require production or vendor credentials.
- repository credential-pattern scanning through `bun run security:scan` without echoing matches.

The complete unit coverage lane runs on `ubuntu-latest` in both pull-request
validation and default-branch audits. It includes real SQLite transactions,
filesystem durability barriers, and repeated graph approval/resume cycles.
The single-CPU `ubuntu-slim` runner produced repeated thirty-second recovery-test
timeouts; moving this heavy lane to a VM keeps the existing test deadlines,
assertions, and coverage threshold. Lightweight CI and automation jobs retain
`ubuntu-slim`. GitHub documents the single-CPU runner as intended for lightweight
work rather than typical heavy CI builds in its
[runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#single-cpu-runners).
Standard GitHub-hosted runners are free for this public repository; runtime and
reliability still require measurement on the actual runner.

Repository settings allow squash merges and disable rebase and merge commits.
Feature branches and Release Please version pull requests must squash into
`main`; Code Foundry fails closed for any other configured merge strategy.

## Release pull-request readiness

Readiness of a Release Please version pull request is a validation transition:
it cancels the pull request's current-head validation. An unchanged ready
release head must therefore not be reset and re-readied when release
preparation repeats, because that cancels a live validation and allocates a
replacement run.

The shared Code Foundry release workflow carries that behaviour from `v1.46.4`
onwards. It classifies the current-head validation owner from the Actions runs
for the exact head before it touches the pull request:

- an owner that is live or successful is preserved, together with the pull
  request's readiness;
- a missing owner still needs the explicit readiness transition, because a
  cancelled, skipped or neutral run proves nothing about the current head;
- a failed, timed-out or action-required owner fails closed and is never
  reallocated;
- an unverified pull-request state, a run status the API does not define, a
  nonpositive attempt number, a malformed entry and an incomplete Actions page
  are refused rather than interpreted, and an unvalidated automation
  credential leaves the pull request in draft for manual readiness.

This repository owns a copy of that policy in `scripts/release-pr-readiness.mjs`
so the behaviour can be proved offline, without executing a release and without
deciding it by matching a workflow file. `tests/release-pr-readiness.test.mjs`
proves the no-op path, the required-readiness path and the fail-closed cases.
The policy decides; the shared workflow performs the mutation, and the release
tier is not forked.

**Compatibility limit.** The fix first appears in Code Foundry `v1.46.4`. Every
earlier release, including the `v1.44.11` and `v1.45.2` pins named in issue
#916, resets an unchanged ready release head instead of preserving it.
`assertReleaseRuntimeCarriesReadinessFix` makes that limit executable: this
repository's release wiring is checked against the floor and refused below it,
and an empty detected-version set is refused rather than passing vacuously. A
repository that cannot be moved to `v1.46.4` or later keeps the canonical
behaviour of every other release, but must keep its release pull requests in
draft until the shared runtime carries the fix.

**Remaining gate.** The hosted repeated-preparation witness — the observation
that an unchanged ready release head keeps its running validation when release
preparation repeats — is not yet recorded. It requires repeating release
preparation on a hosted runner, which is a release, so it remains an open gate
and issue #916 stays open.

## Public-repository security gates

CodeQL and GitHub Dependency Review use Code Foundry's `auto` policy and are
enabled for this public repository. TypeScript and GitHub Actions analysis run
in parallel with Code Foundry's native dependency audit as part of the audit
gate. OpenCode Security is controlled exclusively by the `OPENCODE_SECURITY`
repository variable. Its Detect and Scan jobs run only when that variable is
`true` and the repository exposes `OPENCODE_API_KEY`; those optional jobs are
not part of the credential-free `Validation / Gate`.

Maintainers must treat successful `Validation / Gate`, `Foundation Acceptance /
Gate`, and `M9 Production Readiness / Gate` checks as required and merge only
through pull requests. Repository rules should require these stable gates without
enumerating their internal parallel jobs.

## Neon preview lifecycle

Pull requests run the full general PostgreSQL integration suite in the required
Code Foundry `Validation / Gate` against one runner-owned disposable local
Compose PostgreSQL project. `postgres-pull-request.yml` keeps a separate local
lane for migration and cross-profile conformance; it does not repeat that full
integration suite. Both use synthetic local-only credentials and contain no
Neon connection or credential references.

This is a source-level guard, not repository-wide secret access control:
repository secrets can be referenced by any workflow in the repository. If the
threat model includes untrusted contributors with branch-write access, keep the
Neon credentials only in a GitHub environment restricted to `main` and remove
the repository-scoped copies. See GitHub's
[secret security guidance](https://docs.github.com/en/actions/reference/security/secrets).

The credentialed Neon workflow runs only on pushes to main, after the PR
source has been merged and when all required Neon inputs are configured. It
creates a run-scoped preview from the staging branch, sets a one-day expiry as
a fallback, and deletes the exact temporary branch after validation. The
pinned delete action only receives an ID found by
a read-only, paginated exact-name lookup using the
[Neon branch-list API](https://api-docs.neon.tech/reference/listprojectbranches).
A verified absent branch is a no-op; HTTP failures, malformed or incomplete
listings, pagination loops and unsafe targets fail closed.

After migrations, shard 1 checks the pooled runtime URL, direct runtime URL,
and direct migrator URL against Neon. It verifies TLS configuration, role
identity, and a transaction round trip through each endpoint before the broad
integration shards run. Pull requests never receive these Neon credentials.

This moves real-Neon migration/conformance verification to post-merge; the
secretless local PostgreSQL workflow remains the pre-merge database gate.
Local workflow tests use synthetic responses and do not prove that a hosted
Neon run or cleanup completed successfully.

## Reversible billing pause

`npx code-foundry ci pause` disables Code Foundry jobs through the
`CI_BILLING_PAUSED` repository variable before a runner is allocated, while
`npx code-foundry ci resume` restores the validation gate and resumes normal
automation. A release may run during a pause only through an explicit manual
dispatch with `release-while-paused=true`; that bypass does not enable
validation, security, CodeQL, or draft-pull-request jobs.

## Foundation acceptance extension

`Foundation Acceptance / Gate` is the repository-specific M1 extension added after the Code Foundry
baseline. Code Foundry remains authoritative for generic formatting, lint, build, test, audit, CodeQL,
and dependency-review behavior. The extension exists only for requirements generic CI cannot infer:
accepted milestone ancestry, the Railway service manifest, and the shared service/migration container
graph. Its ancestry and manifest checks run alongside Code Foundry's generic validation; its
container and image-security jobs remain independent and converge on one gate.

## Extension policy

Add repository-owned workflows only when the generic Code Foundry jobs cannot
express a real project requirement. Deeper security scans, image publication,
and deploy or rollback verification are future hooks. They must be
credential-free on pull requests, use isolated resources for parallel jobs,
and become required only after they run reliably on the repository's plan.
