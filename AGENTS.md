# Agent Instructions

## Draft WIP loop

For work the user has authorized, this draft WIP loop takes precedence over
managed boilerplate that requires completed validation before opening or pushing
a draft. Keep the managed blocks intact. Full personal review of the exact head
permits readiness to trigger CI; applicable passing checks and protections gate merge.

Within the user's authorized implementation scope, proceed with ordinary edits,
checks, commits, and draft pushes without asking for repeated confirmation. Choose
routine implementation details; ask only for a genuinely missing consequential
decision or authority.

- Use the existing suitable draft PR and its branch; otherwise create one focused
  draft PR for this repository.
- Commit and push WIP directly to that draft branch throughout the task and before
  stopping or handing off. Verify the remote SHA after each push.
- Incomplete work or failing checks do not block draft pushes; record the failures
  and remaining work in the PR. A draft whose exact head has been fully personally
  reviewed may be marked ready to trigger CI before checks pass. Applicable
  passing checks and protections gate merge.
- Keep draft auto-merge off. Never force-push over others or push unreviewed work
  to an auto-merge head.

Production-shaped TypeScript monorepo for the Control Plane: a modular monolith with independently deployable workers and gateways.

## Quick reference

- **Package manager:** Bun (`bun.lock`)
- **Build:** `bun run build`
- **Lint:** `bun run lint`
- **Test:** `bun run test`
- **Format:** `bun run format:check`
- **Toolchain:** `toolchain: auto` in `.github/code-foundry.yml` (native tools, mise only if `.mise.toml` exists)

## Priorities

When instructions conflict: system/user instructions > this file and explicit task scope > nested `AGENTS.md` > project conventions > general best practices. Ask for clarification when a missing decision would materially change the implementation.

## Where to find things

- [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md) — branching, safety boundaries, standard workflow, review/merge protocol, completion report format, security procedures
- [`.agents/validation.md`](.agents/validation.md) — validation commands, test/coverage rules, runner constraints
- [`.agents/ci.md`](.agents/ci.md) — GitHub workflow design rules (when editing CI)
- [`.agents/conventions.md`](.agents/conventions.md) — documentation, dependencies, generated files

## Branch and deployment flow

Normal work branches from `main` and opens a pull request targeting `main`.
Feature pull requests merge with squash after required checks pass. Railway
production uses the protected promotion and database-schema gates. Railway hosts the production PostgreSQL database. Persistent preproduction
environments are absent; use disposable test sandboxes.
Tests use disposable local/CI databases. Optional hosted qualification requires
a separately reviewed isolated ephemeral environment, never production data or
credentials. See `docs/railway-production-database-cutover.md`.

Nested `AGENTS.md` files and project documentation take precedence for their directory.

## Refreshing the generated core

Sync the latest official Code Foundry core first, then add repository guidance
outside its managed blocks. Keep every generated block and its markers intact.
For an AGENTS-only task, let `SOURCE_PATH` name the official Code Foundry
checkout and `TARGET_PATH` the disposable repository copy. Preview with
`node SOURCE_PATH/src/cli.mjs sync --target TARGET_PATH --dry-run`.
Then import `syncRepository` from `SOURCE_PATH/src/commands/sync.mjs` and call
`syncRepository({ source: SOURCE_PATH, target: TARGET_PATH, configureHooks: false })`
with those directory paths as strings. Bring back only `AGENTS.md`; normal sync
also generates CI/config files, which belong to a separately scoped update.

The core here was verified against official Code Foundry v1.47.3, source commit
`f016be30c4f3b3573d9564c070c9e791f84154e0`. Both the disposable sync and the
configuration-rendered baseline matched all 15 existing managed blocks exactly.
This core verification does not change the repository's CI runtime pin.

## Control Plane repository map

| Area                             | Entry points                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud composition                | `apps/control-api`, `apps/workflow-worker`, `apps/runtime-gateway`                                                                            |
| Local and Hosted composition     | `apps/local-control-plane`, `apps/hosted-control-plane`                                                                                       |
| Domain contracts and ports       | `packages/domain`, `packages/contracts`, `packages/runtime-sdk`, `packages/tool-sdk`                                                          |
| Service authentication           | `apps/control-api/src/auth/service-authentication.ts`, `apps/control-api/src/auth/private-api-authentication.ts`                              |
| PostgreSQL schema and migrations | `packages/database/src/schema/index.ts`, `packages/database/drizzle`, `packages/database/src/cli/migrate.ts`                                  |
| SQLite persistence               | `packages/sqlite-persistence`                                                                                                                 |
| Architecture and contracts       | [architecture](docs/architecture/control-plane-architecture.md), [contracts](docs/contracts.md)                                               |
| Persistence and operations       | [database](docs/database.md), [infrastructure](docs/infrastructure.md)                                                                        |
| Test lanes                       | [testing](docs/testing.md), `scripts/run-bun-test-group.mjs`, `scripts/run-integration-tests.mjs`                                             |
| CI                               | `.github/code-foundry.yml`, `.github/workflows/validation.yml`, `.github/workflows/postgres-pull-request.yml`, [.agents/ci.md](.agents/ci.md) |

## Control Plane commands

Run from the repository root unless a package directory is specified.
`package.json` and `.bun-version` pin Bun 1.4.4; `.node-version` pins Node 24.21.0.

| Task                        | Command                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| Install                     | `bun install --frozen-lockfile`                                                              |
| Development / build         | `bun run dev` / `bun run build`                                                              |
| Format check / write        | `bun run format:check` / `bun run format`                                                    |
| Lint / types                | `bun run lint` / `bun run type-check`                                                        |
| All grouped tests           | `bun run test`                                                                               |
| Unit / E2E / smoke lanes    | `bun run test:unit` / `bun run test:e2e` / `bun run test:smoke`                              |
| Integration lane            | `bun run test:integration`                                                                   |
| OpenAPI / architecture      | `bun run openapi:check` / `bun run architecture:check`                                       |
| Migration check             | `bun run db:check`                                                                           |
| Generate / apply migrations | `bun run --cwd packages/database db:generate` / `bun run --cwd packages/database db:migrate` |

### Practical development notes

- Root `test` builds, then runs the unit, E2E and smoke groups in parallel.
  `scripts/run-bun-test-group.mjs` discovers tests in `apps`, `packages` and
  `tests` and assigns lanes. Bare `bun test` is scoped by `bunfig.toml` to
  `tests/`; it does not run the complete workspace selection.
- Build outputs are used by package exports and repository acceptance tests.
  The root lane commands include a build; a focused test command may need the
  affected workspace packages built first.
- `type-check` includes build, OpenAPI, migration, runtime compatibility,
  requirements, architecture and infrastructure checks. Its requirements check
  consults current GitHub issue identities; see [.agents/validation.md](.agents/validation.md).
- PostgreSQL and SQLite implement persistence for different deployment profiles.
  [Database guidance](docs/database.md) owns that mapping. The Control Plane
  database is separate from Adea's product database and authentication schema.
- Cloud, Local and Hosted composition roots wire the shared domain ports to
  their adapters. Start at the relevant composition root when tracing behavior
  across persistence, runtime transport and worker boundaries.
- `packages/database` owns Drizzle migration generation and application. Root
  `db:check` delegates to that package; migration generation/application commands
  use the package directory. SQLite has its own migration implementation.
- `.github/code-foundry.yml` configures the consumer CI runtime. Managed examples
  mentioning `src/runtime.mjs` refer to Code Foundry's runtime, not a root script
  in this repository. [.agents/ci.md](.agents/ci.md) retains local workflow notes.

<!-- code-foundry-managed: pull-request-policy -->

## Code Foundry workflow policy (mandatory)

This repository uses the `direct` workflow. Topic pull requests target `main`.

- Open every ordinary pull request as a draft. Use `gh pr create --draft` or
  set `draft: true` in the GitHub API; never create a ready ordinary pull
  request as a shortcut.
- Keep ordinary pull requests in draft while preparing them. The generated
  Draft Guard converts ready ordinary pull requests to draft when they are
  opened or reopened, and runner-heavy validation starts only after an
  explicit `ready_for_review` transition unless `draft_protection: false` is
  configured for generated callers. That opt-out does not disable Draft Guard
  or draft-PR automation. Cloudflare reusable callers use
  `draft-protection: false`.
- Run local validation and finish review preparation before marking an ordinary
  pull request ready. Ready pull requests stay ready when new commits arrive,
  and validation reruns for the current head; draft updates allocate no
  validation runner until the pull request is ready.
- This contract is mandatory for every agent scope. Nested `AGENTS.md` files
  may add stricter rules but must not weaken or replace it.
- Release Please version pull requests are managed by the Code Foundry release
  workflow; do not manually change their draft state unless the workflow asks.

<!-- /code-foundry-managed: pull-request-policy -->

<!-- code-foundry-managed: config-aware-policy -->

These instructions are the repository-level operating contract for coding agents, including Hermes, OpenCode, and other automation.

They complement `.github/CONTRIBUTING.md`. More specific instructions in nested `AGENTS.md` files and project documentation take precedence for their directory.

<!-- /code-foundry-managed: config-aware-policy -->

<!-- code-foundry-managed: mission -->

## Mission

- Keep formatting, linting, type checking, builds, tests, and coverage reproducible locally and in CI.
- Prefer the repository's configured toolchain; `toolchain: auto` uses native
  tools unless an existing `.mise.toml` is present.
- Do not commit secrets, generated credentials, local environment files, or machine-specific paths.
- Add tests for behavior changes and keep coverage thresholds explicit in the project configuration.
- Make the smallest complete, well-tested change that solves the requested problem without disturbing unrelated work.

This repository may contain TypeScript, Rust, Python, or any combination of them. Detect the active stack from the files present; do not assume every check applies.

<!-- /code-foundry-managed: mission -->

<!-- code-foundry-managed: contributing-back -->

## Contributing back

Consumers are encouraged to help improve this open-source project. Open a small,
focused pull request for bug fixes, performance improvements, documentation, or
other narrowly scoped changes. For larger feature requests or architectural
changes, create an issue first so the proposal can be discussed and scoped.
Contributions should help make the tool as performant, reliable, and helpful as
possible for everyone.

<!-- /code-foundry-managed: contributing-back -->

<!-- code-foundry-managed: read-before-acting -->

## Read before acting

Before editing:

1. Read this file and `.github/CONTRIBUTING.md`.
2. Find and read any nested `AGENTS.md` that covers the files you will touch.
3. Read the nearest README, package manifest, build configuration, and relevant tests.
4. Inspect the current branch, worktree, remotes, and recent history:

   ```sh
   git status --short --branch
   git remote -v
   git log -5 --oneline
   ```

5. Identify the repository's package manager, lockfile, runtime versions, test commands, deployment assumptions, and generated files.

If the worktree is dirty, preserve existing changes and avoid overlapping edits until their ownership is clear.

<!-- /code-foundry-managed: read-before-acting -->

<!-- code-foundry-managed: priorities -->

## Priorities

When instructions conflict, use this order:

1. System and user instructions
2. This repository's instructions and explicit task scope
3. Nested directory instructions
4. Existing project conventions
5. General best practices

Ask for clarification when a missing decision would materially change the implementation. Otherwise make the smallest reasonable assumption and document it.

<!-- /code-foundry-managed: priorities -->

<!-- code-foundry-managed: safety-boundaries -->

## Safety boundaries

- Do not discard, reset, overwrite, or rewrite user-owned changes.
- Do not expose or commit secrets, credentials, tokens, private keys, local environment files, or personal machine paths.
- Do not modify production resources, repository settings, branch protections, secrets, deployments, or external systems unless explicitly requested.
- Do not add organization- or product-specific details to this reusable baseline.
- Do not change dependency managers or lockfiles unnecessarily.
- Do not bypass hooks, tests, review requirements, or required checks to hide a failure.
- Do not claim completion while required validation, review, deployment, or user decisions remain pending.
- Publishing, committing, or opening a pull request requires explicit task scope or user authorization.

<!-- /code-foundry-managed: safety-boundaries -->

<!-- code-foundry-managed: standard-workflow -->

## Standard workflow

1. Restate the desired outcome and identify the files or systems in scope.
2. Inspect before editing; preserve unrelated work.
3. Plan the smallest coherent change.
4. Implement with existing project patterns.
5. Run `npx code-foundry init` for a new checkout, or `npx code-foundry doctor` to diagnose setup drift.
6. Run focused checks while iterating.
7. Inspect the final diff for accidental changes, secrets, formatting, and generated files.
8. Run the broadest applicable validation available.
9. Report what changed, exact checks and results, skipped checks with reasons, risks, and remaining work.

For normal feature work, branch from `main` and target pull requests at `main`. Treat `main` as the protected release branch. Follow `.github/CONTRIBUTING.md` for the complete internal and external contribution flow.

<!-- /code-foundry-managed: standard-workflow -->

<!-- code-foundry-managed: git-workflow-and-merging -->

## Git workflow and merging

This repository uses the `direct` workflow: topic branches **squash** directly into `main`, and the Release Please version PR **squashes** into `main` (`release_merge_strategy: squash`). Feature and release PRs land on `main` with squash merges. No integration branch exists; all pull requests target `main`.

Merge only with the repository's canonical method. Never merge with `--admin`, never default or auto-select a merge method, and never use a method the branch ruleset does not allow. When in doubt, prefer the merge button's configured method and verify the ruleset after merging. Check `.github/CONTRIBUTING.md` for the complete flow and merge table.

### Branch and commit policy

Branch rulesets enforce deletions, force-pushes, required status checks, pull
requests, conversation resolution, and linear history where the repository's
plan supports them. Mirror those rules even where the plan cannot enforce
them:

- Branch from the default branch using
  `feat/*`, `fix/*`, `chore/*`, `refactor/*`, `docs/*`, or `test/*` names.
- Never push directly to protected branches; open a pull request.
- Use Conventional Commit subjects (`feat:`, `fix:`, `chore:`, …); Release
  Please depends on them to version releases.
- Keep pull requests focused; merge with the canonical method only after
  required checks pass.

<!-- /code-foundry-managed: git-workflow-and-merging -->

<!-- code-foundry-managed: toolchain-and-dependencies -->

## Toolchain and dependencies

- Follow `toolchain: auto` in `.github/code-foundry.yml`; use native tools by
  default and reuse mise only when the repository already has `.mise.toml`.
- If `toolchain: mise` is selected, run `mise install` before validation.
- Use the package manager indicated by the existing lockfile:
  - `bun.lock` or `bun.lockb` → Bun
  - `pnpm-lock.yaml` → pnpm
  - `yarn.lock` → Yarn
  - `package-lock.json` → npm
- Use the existing Python environment and dependency manifest. Prefer a project-managed virtual environment.
- Use Cargo commands and the committed Cargo lockfile for Rust projects.
- Do not mix package managers or regenerate lockfiles as a side effect.
- Keep dependency additions narrowly scoped and explain security, licensing, and runtime impact.

<!-- /code-foundry-managed: toolchain-and-dependencies -->

<!-- code-foundry-managed: validation -->

## Validation

From a consumer repository, use its documented package scripts or the installed
Code Foundry CLI:

```sh
npx code-foundry plan --tier fast
npx code-foundry check --tier fast
npx code-foundry check --tier audit
```

`plan` discovers tasks without running them. `check` invokes the shared runtime;
`fast` includes CI tasks, unit tests and performance, while `audit` adds
integration, E2E and smoke.

From a Code Foundry source checkout only, the shared runtime is also available.
The paths below are relative to that checkout, not a consumer repository. The
runtime detects supported tools and skips inapplicable checks:

```sh
node src/runtime.mjs ci format
node src/runtime.mjs ci lint
node src/runtime.mjs ci type_check
node src/runtime.mjs ci build
node src/runtime.mjs ci unit
node src/runtime.mjs ci integration
node src/runtime.mjs ci e2e
node src/runtime.mjs ci smoke
node src/runtime.mjs ci eval
node src/runtime.mjs ci performance
```

Security and dependency audits run through the GitHub Security workflow.

Run focused tests first, then the complete applicable set for release, security, workflow, dependency, and configuration changes.

At minimum:

- TypeScript/JavaScript: Oxfmt formatting, Oxlint linting, type-check, build, and Bun's native test runner for unit/integration tests; use the project's native browser runner for E2E tests. Repositories using a different linter or formatter keep full control through their own `lint`/`format` scripts, which the runtime honors.
- Do not add Vitest. Preserve specialized native runners such as Matchstick for The Graph and Hardhat for smart contracts.
- Rust: default rustfmt, Clippy with warnings treated as errors, check, unit/integration tests, and dependency audit
- Python: Ruff formatting and linting, compile or type checks, pytest, coverage, and dependency audit
- Mixed projects: validate each active ecosystem and its integration boundaries

If a check cannot run, state the exact reason. A skipped check is not a passing check.

The generated `.githooks/pre-commit` gate is change-aware so parallel work on a
shared checkout is not serialized behind repository-wide checks. It blocks
whitespace errors, formats and lints only staged files, runs the project's
type-check command only when typed sources or compiler configuration are
staged, and does not build unless `pre_commit_build: true` is set. Passing the
hook is not full validation: run the broader checks above before opening or
readying a pull request.

<!-- /code-foundry-managed: validation -->

<!-- code-foundry-managed: tests-and-coverage -->

## Tests and coverage

- Add or update tests for behavior changes and regressions.
- Keep unit, performance, integration, E2E, and smoke coverage in the suite where each applies.
- Preserve project-specific coverage thresholds; do not lower them to make CI green.
- Keep test data deterministic and remove secrets from logs and fixtures.
- Use the narrowest test command while iterating, then run the affected package or workspace suite.

<!-- /code-foundry-managed: tests-and-coverage -->

<!-- code-foundry-managed: github-workflows-and-configuration -->

## GitHub workflows and configuration

- Keep workflows concise, independently runnable, and safe to re-run.
- Use `push` for `main` and `pull_request` for `main` unless a workflow has a documented event-specific reason.
- Give workflows clear names and jobs concise names; avoid repeating the workflow name in the job name.
- Use per-workflow concurrency groups keyed by pull request or ref that cancel superseded pull-request runs while allowing independent workflows to run in parallel. Do not cancel in progress for pushes to `main`, release, publication, or deployment runs; let them queue.
- Do not put `always()` on heavy jobs: it keeps a cancelled run alive and holding its concurrency group. Use `!cancelled()` for jobs that must run after upstream failures, and keep `always()` for lightweight aggregate gates only.
- Keep setup language-aware and cache dependency downloads by lockfile; do not cache secrets, `node_modules`, virtual environments, or broad build output without a measured reason.
- Use least-privilege permissions and pin action versions consistently with the template.
- Keep CI, Test, Security, CodeQL, Draft Guard, Draft PR, Release PR, and Release concerns separated.
- Security and CodeQL may skip when repository visibility or GitHub plan support does not permit them. Do not make an unavailable check required.
- Optional Turborepo Remote Caching uses `TURBO_TOKEN` and `TURBO_TEAM`; do not add Vercel deployment behavior just to enable caching.
- Update branch protection when adding or renaming required job checks; verify the actual GitHub status context.

<!-- /code-foundry-managed: github-workflows-and-configuration -->

<!-- code-foundry-managed: documentation-and-generated-files -->

## Documentation and generated files

- Update documentation when behavior, setup, configuration, commands, or operational procedures change.
- Keep `.env.example` limited to variable names and safe placeholders.
- Do not commit build output, caches, coverage output, dependency directories, generated credentials, or temporary files.
- Preserve formatting and line-ending conventions from `.editorconfig` and `.gitattributes`.

<!-- /code-foundry-managed: documentation-and-generated-files -->

<!-- code-foundry-managed: completion-report -->

## Completion report

End every agent task with:

```text
Summary:
Files changed:
Validation:
Skipped checks:
Risks or follow-up:
Branch/PR:
```

Use exact command names and outcomes. Mention external changes separately from local changes, and distinguish completed work from recommendations.

<!-- /code-foundry-managed: completion-report -->

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
