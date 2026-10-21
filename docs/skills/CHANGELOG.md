# Skill library changelog

Record changes that alter Skill routing, behavior, or supporting validation.
Each entry should name the affected Skills, old/new versions, the decision
changed, validation performed, and any evidence or compatibility limits.

## Unreleased — 2026-10-21

- Skill-eval runner repair (root review of draft PR #1216): the runner
  serialized and wrote its outputs before scanning them for canary values, so
  a canary could reach a persisted artifact, and `--write-evidence` could
  still write repository evidence after a canary was found. The runner now
  precomputes every serialized output, scans the whole batch for canaries
  before the first write, and fails closed: a rejected batch creates no file,
  overwrites no existing artifact, and emits no canary value. `--write-evidence`
  obeys the same gate. A negative regression with a synthetic sentinel proves
  that no output file is created or overwritten when a serialized output
  carries it. The committed evidence artifact is byte-identical to the
  pre-repair run, and the successful output behavior is unchanged.

- Every retained skill gained one explicit contract, and the routing surface
  became machine-checkable:
  - `description` now follows `Use when <trigger>. Not for <non-trigger>. …`.
    The validator parses the two clauses, requires each to be at least 20
    characters, requires them to be unique across the library, and rejects a
    clause that overlaps another skill's clause. The registry mirrors both
    clauses and the lane fails on drift between the registry and the skills.
  - `## Evidence contract` gained a required `**Stop conditions:**` field, so a
    retained skill states when it halts and hands back.
  - New `### Boundary contract` section per skill, with five required clauses:
    secrets, dirty worktree, migration, generated files, provider. Each clause
    must be substantive and must be unique per label across the library, so a
    shared boilerplate line cannot pass as a declared boundary.
  - New `metadata.provenance` block: `origin` (`repository-owned` or
    `vendored-upstream`), the upstream `source` and `upstream_version` for
    vendored content, and the local `integration_version`.
  - New `metadata.deprecated` / `metadata.superseded_by` lifecycle, validated
    against the retained skill set.
- Version bumps: `code-review` 1.0.0 → 1.1.0, `code-simplification` 1.0.0 →
  1.1.0, `control-plane-audit` 1.1.0 → 1.2.0, `incremental-implementation`
  1.0.1 → 1.1.0, `security-and-hardening` 1.0.1 → 1.1.0,
  `test-driven-development` 1.0.1 → 1.1.0, `typescript-advanced-types` 1.0.0 →
  1.1.0, `verification-before-completion` 1.0.0 → 1.1.0. `turborepo` keeps its
  pinned upstream version 2.10.11-canary.4; its local integration revision is
  1.1.0.
- New versioned artifacts: `docs/skills/skill-library.schema.json` (manifest
  schema, version 1), `docs/skills/skill-library.template.md` (new-skill
  template), `docs/skills/provenance.md` (provenance ledger),
  `docs/evals/skill-evals/skill-eval-fixtures.v1.json` (cold-task fixture
  set), and `docs/evals/skill-evals/skill-eval-evidence.v1.json` (the
  committed baseline-versus-candidate measurement).
- The skill-eval lane moved from three scripted fixtures to ten cold-task
  scenarios (`SK-01`…`SK-10`) that use the #191 harness read-only on
  evidence-quality v3 fixtures, with a contract-driven cold executor instead of
  hard-coded reports. Measured against the pinned baseline
  `27f17bd55e0266439b5b3089163195c9e7a669be`: 4 of 10 scenarios passed at the
  baseline and 9 of 10 pass on the candidate; the negative control `SK-03`
  still fails as it must. Routing surface 2 167 → 2 707 bytes, entrypoints
  133 904 → 143 123 bytes, 0 executor errors in both. The observed durations
  are local harness timings, not provider latency, token, or cost.
- The blinded independent comparison is prepared and unexecuted:
  `docs/evals/skill-evals/blinded-comparison-packet.md` and
  `blinded-comparison-sheet.json` record `awaiting-blinded-human-scoring` with
  every human value `null`, including the reviewer-correction count. No human
  score is claimed.
- Validation: `bun scripts/validate-skills.mjs --refresh` validated all nine
  skills and refreshed the versioned inventory; `bun test
  ./tests/agent-skill-library.test.mjs ./tests/skill-library.test.mjs` covers
  the routing, boundary, provenance, and lifecycle rules and the committed
  evidence artifact; `bun docs/evals/skill-evals/run-skill-evals.mts` reported
  20 of 20 scenario runs within the documented error bounds. These are
  structural, contract-conformance, and modeled-executor checks. They are not
  human calibration, not live-model behavior, and not live-profile acceptance.

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
