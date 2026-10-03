# Continuous integration

Code Foundry v1.30.0 is the CI runtime pinned by the generated callers under
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

Pull requests receive database coverage through
postgres-pull-request.yml. It uses the disposable local Compose PostgreSQL
instance and synthetic local-only credentials; the checked-in workflow contains
no repository-secret references and does not connect to Neon.

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
graph. Its core and container jobs run in parallel and converge on one gate.

## Extension policy

Add repository-owned workflows only when the generic Code Foundry jobs cannot
express a real project requirement. Deeper security scans, image publication,
and deploy or rollback verification are future hooks. They must be
credential-free on pull requests, use isolated resources for parallel jobs,
and become required only after they run reliably on the repository's plan.
