# Skill library changelog

Record changes that alter Skill routing, behavior, or supporting validation.
Each entry should name the affected Skills, old/new versions, the decision
changed, validation performed, and any evidence or compatibility limits.

## Unreleased — 2026-10-08

- `control-plane-audit` 1.0.0 → 1.1.0: retrieve the current milestone and
  follow-up membership alongside the original twelve M11 issues. Apply source
  and milestone reconciliations while retaining legacy support and substantive
  acceptance gates. Route equivalent independent reproduction to agent evidence,
  isolate genuine authority/access prerequisites, and record explicit environment
  substitutions without weakening functional assertions.
- Updated registry guidance and generated inventory. Structural checks do not
  establish cold-audit agreement, measured efficiency/calibration, live-profile
  acceptance or complete M11 evidence.
- Validation: `bun scripts/validate-skills.mjs --refresh` validated all nine
  skills; `bun test ./tests/agent-skill-library.test.mjs ./tests/skill-library.test.mjs`
  passed 15 tests and 335 assertions. These are structural/library regression
  checks, not execution of the routed acceptance procedures.

## Unreleased — 2026-09-29

- Extended the smoke-lane command-reference check from each `SKILL.md` to every
  bundled Markdown file, including progressive-disclosure resources. It checks
  names against `package.json`; it does not execute commands or produce Skill
  behavior, human-calibration, cold-audit, or before/after efficiency evidence.

## Unreleased — 2026-09-27

- `security-and-hardening` 1.0.0 → 1.0.1: removed absent-reference paths and
  routed to existing repository security and validation owners.
- `test-driven-development` 1.0.0 → 1.0.1: replaced its absent testing-patterns
  reference with the repository testing guide.
- `incremental-implementation` 1.0.0 → 1.0.1: made Git writes conditional on
  authorization and clarified preservation/cleanup of pre-existing changes.
- Expanded inventory validation to check local Markdown links across every
  retained Skill. This is structural validation, not a behavior-eval result.
- Updated the lane map, baseline, and maintenance guidance. No new model-run,
  human-calibration, cold-audit, or before/after efficiency evidence was
  produced by these documentation and validator changes.
