# Skill library maintenance cadence (M11.11 / #196)

Companion to [`library-baseline.md`](./library-baseline.md). This document fixes
the maintenance ownership, review cadence, deprecation process, and update
process for the repository Skill library (`.agents/skills/`), satisfying the
#196 acceptance line "Maintenance/deprecation/provenance/security/update
procedures are documented."

## Ownership

- **Owner:** the Control Plane maintainers (the same owners recorded in each
  SKILL.md's `metadata.owner`).
- **Changes to skills** follow the standard flow: branch, pull request with the
  `tests/skill-library.test.mjs` lane green, independent review for substantive
  rewrites, squash merge to main.
- **Validation:** `bun scripts/validate-skills.mjs` plus the smoke-lane skill
  tests must pass. Checks include frontmatter name/description/version,
  directory match, no machine-specific absolute paths, inventory in sync, and every
  inline `bun run <script>` reference in bundled Markdown must name a script
  in the repository's `package.json`. This checks declared command names; it
  does not execute the referenced commands or prove their described results.

## Review cadence

| Trigger                                                          | Review scope                                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Any change to `.agents/skills/**`                                | validate references/contracts + refresh inventory; update the Skill changelog                                  |
| Change to `AGENTS.md`, `.github/CONTRIBUTING.md`, `.agents/*.md` | check skill routes and safety guidance against the canonical instruction owner; link to it rather than copying |
| Change to Code Foundry config/runtime/workflows                  | check documented commands, runner gates, and skill validation against `.github/code-foundry.yml` and workflows |
| Each M-milestone closeout                                        | full inventory re-baseline (purpose, triggers, overlaps, gaps, available evidence)                             |
| Ad hoc: a skill's guidance contradicts repo reality              | immediate fix or deprecation, per the update process                                                           |

## Versioning and deprecation

- Every skill declares `metadata.version` in its frontmatter; the validator
  fails the lane if absent.
- Substantive guidance changes bump the version (semver-style: guidance edits
  patch, workflow/process changes minor, removals major).
- Record each Skill-library change in [`CHANGELOG.md`](./CHANGELOG.md), naming
  affected Skills, old/new versions, the decision changed, validation performed,
  and known compatibility or evidence limitations. Do not describe an
  unexecuted eval or unobserved human review as completed evidence.
- Deprecation: mark the SKILL.md frontmatter with `deprecated: true` plus a
  `superseded_by:` pointer, keep the directory for one release, then remove
  the directory and delete the inventory entry via `--refresh`.

## Provenance and security

- Skills adapted from external sources keep their attribution note
  (e.g. code-simplification credits its upstream origin).
- New skills must not embed secrets, credentials, or machine-specific paths.
  The validator rejects absolute paths, and the repository credential scan
  covers the directory.
- Skills must never instruct an agent to treat issue closure, sampled checks,
  stale memory, fake adapters, or skipped tests as completion proof. This is
  the library's core safety invariant and review enforces it alongside tooling.

## Update process (summary)

1. Branch from main; edit the skill under `.agents/skills/<name>/`.
2. Bump `metadata.version`; keep the description's trigger boundary accurate.
3. Check the canonical instruction and validation owners (`AGENTS.md`,
   `.github/CONTRIBUTING.md`, `.agents/validation.md`, `.agents/ci.md`) and the
   configured Code Foundry source (`.github/code-foundry.yml` plus the checked-in
   workflows). Verify that referenced commands still exist and that the Skill
   does not weaken or duplicate those policies. Record the compatible Code
   Foundry version/source in the changelog when relevant; do not pin a second
   copy of a version owned by configuration.
4. Run `bun scripts/validate-skills.mjs --refresh`; commit the refreshed
   inventory only when the task's commit authorization allows it.
5. Open a pull request; the smoke lane fails on inventory drift, missing
   versions/contracts, machine-specific paths, or broken local Markdown links.
