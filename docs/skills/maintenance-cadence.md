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
- **Validation:** `bun scripts/validate-skills.mjs` (invoked by the smoke-lane
  test) must pass — frontmatter name/description/version present, directory
  match, no machine-specific absolute paths, inventory in sync.

## Review cadence

| Trigger | Review scope |
| --- | --- |
| Any merged change to `.agents/skills/**` | validate + inventory refresh in the PR itself |
| Each M-milestone closeout | full inventory re-baseline (purpose, triggers, overlaps, gaps) |
| Ad hoc: a skill's guidance contradicts repo reality | immediate fix or deprecation, per the update process |

## Versioning and deprecation

- Every skill declares `metadata.version` in its frontmatter; the validator
  fails the lane if absent.
- Substantive guidance changes bump the version (semver-style: guidance edits
  patch, workflow/process changes minor, removals major).
- Deprecation: mark the SKILL.md frontmatter with `deprecated: true` plus a
  `superseded_by:` pointer, keep the directory for one release, then remove
  the directory and delete the inventory entry via `--refresh`.

## Provenance and security

- Skills adapted from external sources keep their attribution note
  (e.g. code-simplification credits its upstream origin).
- New skills must not embed secrets, credentials, or machine-specific paths —
  the validator rejects absolute paths, and the repository credential scan
  covers the directory.
- Skills must never instruct an agent to treat issue closure, sampled checks,
  stale memory, fake adapters, or skipped tests as completion proof — that
  rule is the library's core safety invariant and is enforced by review, not
  just tooling.

## Update process (summary)

1. Branch from main; edit the skill under `.agents/skills/<name>/`.
2. Bump `metadata.version`; keep the description's trigger boundary accurate.
3. Run `bun scripts/validate-skills.mjs --refresh`; commit the refreshed
   inventory with the change.
4. Open a pull request; the smoke lane fails on inventory drift, missing
   versions, or unsafe content.
