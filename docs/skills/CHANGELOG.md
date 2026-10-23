# Skill library changelog

Record changes that alter Skill routing, behavior, or supporting validation.
Each entry should name the affected Skills, old/new versions, the decision
changed, validation performed, and any evidence or compatibility limits.

## Unreleased — 2026-10-23

- Corrected the routing-byte measurement in the cold-task evidence. The pinned
  `turborepo` baseline uses a YAML literal block scalar (`description: |`);
  the previous line-based reader counted the style marker as one byte.
  The harness now parses the actual YAML frontmatter value, and the evidence
  was regenerated from pinned baseline
  `27f17bd55e0266439b5b3089163195c9e7a669be` plus the current candidate source.
  Routing surface is 2 626 → 2 707 bytes (+81), not 2 167 → 2 707 (+540).
  This is a measurement correction: the skill source and modeled scenario verdicts,
  and open blinded-human gate are unchanged. Persistence-only tests use an
  explicitly synthetic checkout-head baseline so they remain hermetic in
  shallow CI checkouts; historical-baseline qualification still uses the
  pinned commit when available.

## Unreleased — 2026-10-21

- Addressed the independent read-only advisory (F2W8) against this branch. The
  manifest schema is now enforced against the actual manifest, the provenance
  ledger is checked against the skill frontmatter, the cold-task suite covers
  every retained skill, and the documentation no longer overstates what is
  checked:
  - **Schema enforcement.** `scripts/validate-skills.mjs` validates the
    manifest against `docs/skills/skill-library.schema.json` on every run, and
    the schema now expresses the conditional rules it previously only
    described: the routing-convention pattern on `description`, the
    vendored-upstream requirements for `source` and `upstreamVersion`, the
    repository-owned exclusion of `source`, and the deprecation requirement for
    `supersededBy`. A manifest that satisfies the validator but not the schema
    fails the lane.
  - **Provenance ledger anti-drift.** The ledger's origin, upstream source,
    upstream version, integration version, and owner are compared with each
    skill's frontmatter, and a drift fails the lane. A wrong upstream pin, owner,
    or integration revision in the ledger can no longer pass silently.
  - **Coverage.** The cold-task suite grows from ten scenarios to fourteen.
    SK-11 to SK-14 exercise `code-simplification`, `test-driven-development`,
    `turborepo`, and `typescript-advanced-types`, so every retained skill is
    now covered. The committed evidence artifact records the coverage in a
    `coverage` block and the measurement-strength limit in a
    `measurementLimits` block: the baseline-versus-candidate difference is
    decided by a small number of contract-presence facts, so the scenario
    count is not a count of independent evidence and is not a quality
    measurement of the retained skills.
  - **CI baseline reproduction.** The artifact's `baseline.reproduction` field
    and the documentation state that the baseline arm is reproduced only when
    the pinned commit is present in the checkout; the standard validation
    workflow checks out at depth 1 and therefore reproduces the candidate arm
    only.
  - **Documentation corrections.** The blinded packet's rubric link resolved to
    a path that does not exist and now points at
    `docs/evals/calibration-scoring-sheet.json`; the blinding assignment is
    derived from a fixed position of the full commit id instead of a short
    abbreviation whose length depends on the clone; the new-skill template now
    states exactly which properties the validator checks and that it does not
    read the prose of the evidence or boundary contracts; the maintenance
    cadence states that any byte change to a skill entrypoint requires an
    evidence-artifact refresh, because the artifact pins each entrypoint's
    digest; and the vendored `turborepo` adaptation — the replaced upstream
    routing description — is recorded in `docs/skills/provenance.md` with the
    upstream source the vendored file itself cites.
  - **Inventory refresh.** `validate-skills.mjs --refresh` now normalizes the
    inventory with the repository formatter, so a refreshed inventory satisfies
    `bun run format:check` as written.
  - **Type-check boundary for the evaluation lane.** `docs/evals/` and
    `scripts/` are not workspace packages, so the repository's per-package
    checks do not reach the new TypeScript. The evaluation lane now carries
    `docs/evals/skill-evals/tsconfig.json` and the command
    `bun check -p docs/evals/skill-evals/tsconfig.json`. The first run of
    that check reported five type errors that no earlier lane could see
    (unchecked indexed access in the frontmatter and skill-name extraction,
    and an untyped `Bun` global); the harness and runner now use Node's typed
    `execFileSync` and explicit undefined guards, and the check is clean. The
    committed evidence artifact is byte-identical before and after that change.
  - `turborepo` local integration revision 1.1.0 → 1.1.1: the upstream source
    became identifiable from the vendored file's own source documentation and
    the local adaptation was recorded. The pinned upstream version
    2.10.11-canary.4 is unchanged.
- Skill-eval runner persistence reporting (root review of draft PR #1216,
  follow-up to `683fe954`): the runner's failure handler reported "no output
  file was created or overwritten" for every error, but the output batch is
  written sequentially, so a failure on a later output happens after the
  earlier ones are already on disk. The runner now distinguishes the failure
  modes and reports each truthfully: a canary rejection still states that
  nothing was created or overwritten, because the gate precedes every
  destination write; a write failure reports the partial state and names the
  outputs that had already been persisted, and never claims that nothing was
  written; any other failure escapes before the batch is written and says so.
  A deterministic regression injects a second-output I/O failure and asserts
  the partial persistence and the truthful report. The canary gate, its
  rejection semantics, and the committed evidence artifact are unchanged.
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
  still fails as it must. The original routing-surface report was 2 167 →
  2 707 bytes; it undercounted the pinned `turborepo` block description and is
  corrected in the 2026-10-23 entry above. Entrypoints were 133 904 → 143 123
  bytes, with 0 executor errors in both. The observed durations
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
