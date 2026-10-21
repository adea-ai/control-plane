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
  tests must pass. Checks include frontmatter name/description/version, the
  routing convention, the directory match, the registry drift check, unique
  and non-overlapping routing clauses, the evidence and boundary contracts, the
  provenance record, the deprecation lifecycle, the manifest against the
  published schema, the provenance ledger against the skill frontmatter, no
  machine-specific absolute paths, inventory sync, and every inline
  `bun run <script>` reference in bundled Markdown must name a script in the
  repository's `package.json`. This checks declared command names; it does not
  execute the referenced commands or prove their described results.

## The per-skill contract

Every retained skill carries one contract, split between the frontmatter the
agent sees and the body it reads:

| Contract    | Location                                        | Requirement                                                                                        |
| ----------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Trigger     | frontmatter `description`, `Use when …` clause  | unique across the library, at least 20 characters, must not overlap another skill's routing clause |
| Non-trigger | frontmatter `description`, `Not for …` clause   | unique across the library, at least 20 characters, must not overlap another skill's routing clause |
| Owner       | `metadata.owner`                                | non-empty, and identical to the registry row                                                       |
| Version     | `metadata.version`                              | a semantic version, and identical to the registry row                                              |
| Evidence    | `## Evidence contract`                          | all nine labelled fields, including `**Stop conditions:**` and `**Cleanup:**`                      |
| Boundaries  | `### Boundary contract`                         | all five labelled clauses, each at least 30 characters and unique per label across the library     |
| Provenance  | `metadata.provenance`                           | `origin`, plus `source` and `upstream_version` for vendored content                                |
| Lifecycle   | `metadata.deprecated`, `metadata.superseded_by` | a deprecated skill names a retained replacement and carries a `> **Deprecated:**` notice           |

Start a new skill from
[`skill-library.template.md`](./skill-library.template.md). The machine-readable
shape is [`skill-library.schema.json`](./skill-library.schema.json) and the
provenance record is [`provenance.md`](./provenance.md).

## Review cadence

| Trigger                                                          | Review scope                                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any change to `.agents/skills/**`                                | validate references/contracts + refresh inventory; refresh the cold-task evidence artifact for any byte change to a skill entrypoint; update the Skill changelog |
| Change to `AGENTS.md`, `.github/CONTRIBUTING.md`, `.agents/*.md` | check skill routes and safety guidance against the canonical instruction owner; link to it rather than copying                                                   |
| Change to Code Foundry config/runtime/workflows                  | check documented commands, runner gates, and skill validation against `.github/code-foundry.yml` and workflows                                                   |
| Each M-milestone closeout                                        | full inventory re-baseline (purpose, triggers, overlaps, gaps, available evidence)                                                                               |
| Ad hoc: a skill's guidance contradicts repo reality              | immediate fix or deprecation, per the update process                                                                                                             |
| Change to `docs/evals/skill-evals/**`                            | re-run the cold-task suite and refresh the committed evidence artifact                                                                                           |

## Versioning and deprecation

- Every skill declares `metadata.version` in its frontmatter; the validator
  fails the lane if absent.
- Substantive guidance changes bump the version (semver-style: guidance edits
  patch, workflow/process changes minor, removals major). Adding a contract
  field or changing routing is a workflow/process change: bump the minor
  version.
- The inventory's `schemaVersion` is bumped when the manifest record shape
  changes, in the same change that changes the shape.
- Record each Skill-library change in [`CHANGELOG.md`](./CHANGELOG.md), naming
  affected Skills, old/new versions, the decision changed, validation performed,
  and known compatibility or evidence limitations. Do not describe an
  unexecuted eval or unobserved human review as completed evidence.
- Deprecation: mark the frontmatter with `metadata.deprecated: true` plus a
  `metadata.superseded_by:` pointer to a retained skill, add a
  `> **Deprecated:**` notice to the body naming the replacement, keep the
  directory for one release, then remove the directory and delete the inventory
  entry via `--refresh`. The validator rejects a deprecated skill without a
  replacement, a replacement that names no retained skill, and a
  `superseded_by` pointer on a skill that is not deprecated.
- A skill is removed only after its lane is covered by another entry in the
  registry, with the removal and its replacement recorded in
  [`CHANGELOG.md`](./CHANGELOG.md).

## Provenance and security

- Skills adapted from external sources keep their attribution note and are
  recorded in [`provenance.md`](./provenance.md). A vendored skill declares
  `origin: vendored-upstream`, the upstream `source`, the pinned
  `upstream_version` (equal to `metadata.version`), and the local
  `integration_version`.
- New skills must not embed secrets, credentials, or machine-specific paths.
  The validator rejects absolute paths and secret-shaped content, and the
  repository credential scan covers the directory.
- Skills must never instruct an agent to treat issue closure, sampled checks,
  stale memory, fake adapters, or skipped tests as completion proof. This is
  the library's core safety invariant and review enforces it alongside tooling.
- The boundary contract is the per-skill statement of the secret, dirty
  worktree, migration, generated-file, and provider rules. A boundary clause
  that is identical to another skill's clause for the same label is rejected:
  a shared boilerplate boundary is not a declared boundary.

## Update process (summary)

1. Branch from main; edit the skill under `.agents/skills/<name>/`.
2. Bump `metadata.version`; keep the description's routing clauses accurate
   and unique.
3. Update the evidence contract, the boundary contract, and the provenance
   record; add the registry row for a new skill, or update the existing row
   for a changed skill.
4. Check the canonical instruction and validation owners (`AGENTS.md`,
   `.github/CONTRIBUTING.md`, `.agents/validation.md`, `.agents/ci.md`) and the
   configured Code Foundry source (`.github/code-foundry.yml` plus the checked-in
   workflows). Verify that referenced commands still exist and that the Skill
   does not weaken or duplicate those policies. Record the compatible Code
   Foundry version/source in the changelog when relevant; do not pin a second
   copy of a version owned by configuration.
5. Run `bun scripts/validate-skills.mjs --refresh`; commit the refreshed
   inventory only when the task's commit authorization allows it. The refresh
   validates the manifest against
   [`skill-library.schema.json`](./skill-library.schema.json) and checks
   [`provenance.md`](./provenance.md) against the skill frontmatter, so the
   schema and the ledger cannot drift from the skills unnoticed.
6. Run `bun docs/evals/skill-evals/run-skill-evals.mts` when a routing,
   evidence, or boundary change can alter a cold-task outcome, and refresh the
   committed evidence artifact with `--write-evidence`. The artifact pins each
   skill entrypoint's digest, so **any byte change to a `SKILL.md` requires the
   refresh**, not only a change that alters a cold-task outcome. A wording
   edit that leaves the verdicts unchanged still changes the pinned digest,
   and the comparison in the test lane fails on that difference. The evaluation
   lane also has its own type-check boundary:
   `bun check -p docs/evals/skill-evals/tsconfig.json`.
7. Open a pull request; the smoke lane fails on inventory drift, missing
   versions/contracts, routing duplicates or overlaps, boundary gaps,
   provenance errors, a manifest that does not satisfy the published schema, a
   provenance ledger that disagrees with the skills, machine-specific paths, or
   broken local Markdown links.
