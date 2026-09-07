# Continuous integration

Code Foundry v0.40.1 is the CI control plane for this repository. Generated callers are pinned under `.github/workflows/` and use the staging-release
topology: feature branches target `staging`, and validated `staging` changes are
promoted to `main`.

## Required pull-request gate

`Validation / Gate` is the single stable Code Foundry check. This repository sets
`staging_validation_mode: audit`, so pull requests into both `staging` and `main`
run CI, all four test jobs, Security, and CodeQL. Release Please pull requests use
the separate release-policy tier. Each tier fans out independent jobs
and aggregates their results. Each workflow cancels superseded work for the same
branch while unrelated pull requests, scheduled audits, and manual runs remain
parallel. Turborepo schedules build work from its dependency graph, while Bun's
`--parallel` mode is limited to the independent top-level test groups.

The gate covers:

- frozen Bun lockfile installation with the pinned Node and Bun toolchain;
- formatting, lint, package-boundary enforcement, workspace type-checking, and
  builds;
- unit, E2E, smoke, and PostgreSQL integration groups as independent parallel jobs, including
  isolated databases, deterministic migration replay, enforced 80% unit coverage, and LCOV upload;
- OpenAPI drift and Drizzle migration-schema drift through `bun run type-check`;
- dependency auditing that does not require production or vendor credentials.
- repository credential-pattern scanning through `bun run security:scan` without echoing matches.

Repository settings allow squash and rebase merges but disable merge commits.
Feature branches must squash into `main`. Release Please version pull requests
must rebase; Code Foundry fails closed for any other configured merge strategy.

## Public-repository security gates

CodeQL and GitHub Dependency Review use Code Foundry's `auto` policy and are
enabled for this public repository. TypeScript and GitHub Actions analysis run
in parallel with Code Foundry's native dependency audit as part of the audit
gate. OpenCode Security is opted in, but its Detect and Scan jobs skip when the
repository does not expose `OPENCODE_API_KEY`; those optional jobs are not part
of the credential-free `Validation / Gate`.

Maintainers must treat successful `Validation / Gate`, `Foundation Acceptance /
Gate`, and `M9 Production Readiness / Gate` checks as required and merge only
through pull requests. Repository rules should require these stable gates without
enumerating their internal parallel jobs.

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
