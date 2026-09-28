# Skill library changelog

Record changes that alter Skill routing, behavior, or supporting validation.
Each entry should name the affected Skills, old/new versions, the decision
changed, validation performed, and any evidence or compatibility limits.

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
