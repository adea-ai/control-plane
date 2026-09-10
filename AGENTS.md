# Agent Instructions

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
staging is an on-demand reference environment that deploys from `main` (or a
tag) for cloud-substrate debugging and is stood back down afterwards; Railway
production tracks Git `main`. The staging and production Neon database branches
are separate.

Nested `AGENTS.md` files and project documentation take precedence for their directory.

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
