# Skill library baseline and qualification evidence (M11.11 / #196)

Scope: the repository audit-skill library (`.agents/skills/`), its contracts,
its machine-readable inventory, and its cold-task evaluation lane. This
snapshot is measured against the pinned baseline commit
`27f17bd55e0266439b5b3089163195c9e7a669be` and the candidate head recorded in
the pull request.

## What the library contains

Nine retained skills, all repository-owned except the pinned vendored
`turborepo`. The machine-readable inventory is
[`skill-library.json`](./skill-library.json), described by
[`skill-library.schema.json`](./skill-library.schema.json); the provenance
ledger is [`provenance.md`](./provenance.md).

| Contract                | Where it lives                                                                                     | Enforced by                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Trigger and non-trigger | the `description` frontmatter clause `Use when …  Not for …`                                       | `scripts/validate-skills.mjs` (convention, uniqueness, non-overlap) and the registry drift check |
| Owner and version       | `metadata.owner`, `metadata.version`                                                               | validator, registry drift check, inventory                                                       |
| Evidence                | the `## Evidence contract` section, including `**Stop conditions:**` and `**Cleanup:**`            | validator and `tests/agent-skill-library.test.mjs`                                               |
| Boundaries              | the `### Boundary contract` section: secrets, dirty worktree, migration, generated files, provider | validator (presence, length, per-label uniqueness across the library)                            |
| Provenance              | `metadata.provenance` (`origin`, `source`, `upstream_version`, `integration_version`)              | validator, `docs/skills/provenance.md`, and the ledger anti-drift check                          |
| Lifecycle               | `metadata.deprecated` + `metadata.superseded_by`                                                   | validator (replacement must name a retained skill)                                               |
| Manifest shape          | `docs/skills/skill-library.schema.json`                                                            | the validator validates the manifest against the published schema                                |

The registry (`.agents/skills/README.md`) mirrors the routing clauses so a
human reader can scan the library; the validator fails the lane on any drift
between the registry and the skills. The provenance ledger
(`docs/skills/provenance.md`) mirrors the same facts for the provenance
columns, and the validator compares the two, so a ledger edited to record a
wrong upstream pin, owner, or integration revision fails the lane instead of
drifting silently.

## Measured baseline versus candidate

The cold-task suite in [`docs/evals/skill-evals/`](../evals/skill-evals/) runs
every scenario twice: once against the pinned baseline library and once
against the candidate library. The measured, committed artifact is
[`skill-eval-evidence.v1.json`](../evals/skill-evals/skill-eval-evidence.v1.json);
regenerate it with `bun docs/evals/skill-evals/run-skill-evals.mts
--write-evidence`.

| Measure                                                  | Baseline (`27f17bd5`)                            | Candidate  | Delta                      |
| -------------------------------------------------------- | ------------------------------------------------ | ---------- | -------------------------- |
| Retained skills                                          | 9                                                | 9          | 0                          |
| Retained skills exercised by at least one scenario       | 5                                                | 9          | +4                         |
| Routing surface (bytes an agent reads to select a skill) | 2 626                                            | 2 707      | +81                        |
| Entrypoints (all `SKILL.md`)                             | 133 904                                          | 143 179    | +9 275                     |
| Bundled skill files (all bytes)                          | 252 692                                          | 261 967    | +9 275                     |
| Cold scenarios run                                       | 14                                               | 14         | 0                          |
| Scenarios passing the harness                            | 4                                                | 13         | +9                         |
| Scenarios with honest reporting                          | 4                                                | 13         | +9                         |
| Failed harness assertions                                | 23                                               | 4          | −19                        |
| Tool calls (instrumented `inspect`)                      | 27                                               | 27         | 0                          |
| Executor errors                                          | 0                                                | 0          | 0                          |
| Observed harness duration per scenario                   | 0.1–17.5 ms (local runtime, first-run JIT noise) | 0.1–1.2 ms | not comparable across runs |

Routing bytes come from the YAML `description` values, with whitespace
normalized before counting UTF-8 bytes. This includes literal and folded block
scalars. The earlier 2 167-byte baseline treated the `|` block-style marker in
the pinned `turborepo` description as its one-byte value; the regenerated
artifact parses that source with Bun's YAML parser and records the full
description. Skill source bytes and scenario results did not change.

Nine scenarios changed: SK-04 (secrets), SK-05 (dirty worktree), SK-06
(migration and generated files), SK-07 (provider), SK-10 (stop conditions),
and SK-11 to SK-14, which extend the suite to the four skills it previously did
not exercise — `code-simplification`, `test-driven-development`, `turborepo`,
and `typescript-advanced-types`. The baseline library has no
`### Boundary contract` and no `**Stop conditions:**`, so a cold reader has no
instruction for those situations; the candidate library carries them and the
same scenarios now report the observed state.

The candidate still fails SK-03 on purpose: SK-03 is the negative control
that copies an untrusted summary without reading any evidence, and the
harness must reject it.

Two limits travel with these numbers and are recorded in the committed
artifact itself:

- **Coverage.** Every retained skill is now exercised by at least one
  scenario, and the artifact's `coverage` block names them. Coverage means the
  skill contract is exercised by the modeled cold executor; it is not a
  statement that the skill content is correct, complete, or actionable.
- **Measurement strength.** The baseline-versus-candidate difference is
  decided by whether the skill text carries the contract markers a scenario
  requires. The library-level contract is therefore a small number of
  independent facts — the evidence contract, the boundary contract, and the
  stop conditions — and the scenarios differ in their evidence fixtures rather
  than in the skill-side input. "13 of 14 scenarios pass" is not fourteen
  independent pieces of evidence and is not a quality measurement of the
  retained skills. The artifact's `measurementLimits` block states this.

The baseline arm is also not reproducible in every lane: the pinned commit has
to be present in the checkout, and the repository's standard validation
workflow checks out at depth 1, where the test reproduces the candidate arm
only and skips the baseline comparison. The baseline figures above were
measured in a checkout that contained the pinned commit. The artifact records
this in its `baseline.reproduction` field.

## Cold representative audit

A cold representative audit was run against the pinned baseline before the
candidate was developed, using the same fixture set: SK-06 is the
`control-plane-audit` lane scenario (migration never run, generated artifact
stale, summary claims both are current). Against the baseline library the
audit cannot honor the migration and generated-file boundaries, because the
skill text does not contain them, and the observed report claimed both gates
were verified. Against the candidate library the same cold run reports the
migration as unavailable and the generated artifact as failed, with the
partial status the harness requires.

## What this evidence does and does not establish

Established, by observation:

- every retained skill has a unique, non-overlapping trigger and non-trigger,
  a named owner, a version, a complete evidence contract with stop conditions
  and cleanup, five substantive boundary clauses, and a provenance record;
- the library's structural checks fail closed on drift, on duplicate or
  overlapping routing clauses, on a missing or duplicated boundary, on a
  malformed provenance record, and on an incomplete deprecation;
- the manifest satisfies the published schema, and the provenance ledger
  agrees with the skill frontmatter, so neither can drift silently;
- the cold-task suite observes the difference between the pinned baseline and
  the candidate across fourteen scenarios covering every retained skill, and
  the harness's negative control still fails as it must;
- no secret canary from an untrusted summary reaches any persisted artifact.

Not established, and deliberately left open:

1. **Human calibration.** The blinded independent comparison is an external
   gate. The packet is
   [`blinded-comparison-packet.md`](../evals/skill-evals/blinded-comparison-packet.md)
   and the scoring sheet
   [`blinded-comparison-sheet.json`](../evals/skill-evals/blinded-comparison-sheet.json)
   records `awaiting-blinded-human-scoring` with every human value `null`.
   The reviewer-correction count is `null` in the committed evidence for the
   same reason. The offline suite is a modeled executor over a deterministic
   harness; it is not a human score and must not be reported as one.
2. **Model behavior.** No provider was called and no model was run. The
   executor in the suite is a modeled cold agent, and the observed durations
   are local harness timings, not provider latency, token, or cost.
3. **Live profile acceptance.** Nothing here qualifies the managed-cloud,
   Local, or self-hosted profiles, and no skill in this library is an
   acceptance authority for them.
4. **Task-level routing by a live agent.** The uniqueness and non-overlap of
   the routing clauses is a property of the text. Whether a live agent selects
   the right skill — or correctly selects none — is what the blinded
   comparison measures.
5. **Skill-content quality.** The suite measures whether a skill carries its
   contract, not whether a boundary or stop-condition clause is correct,
   complete, or actionable. The new-skill template records the same limit.
6. **The vendored upstream pin.** `turborepo`'s `upstream_version` records the
   upstream content its body is based on, not a byte-for-byte reproduction:
   the permitted integration points changed the file, and
   [`provenance.md`](./provenance.md) records the adaptation. The local bytes
   are pinned by the inventory's `skillMdDigest`.
7. **The evaluation runner's output location.** The runner writes to a fixed
   path under the shared temporary directory and does not defend against a
   pre-created symlink there. That is inherited from the base revision, the
   runner is a developer-local research tool, and its outputs are not an
   authority for anything. It is recorded as a known limit rather than
   redesigned here.

## Maintenance

Ownership, compatibility review, versioning, deprecation, provenance,
security, and update procedures are in
[`maintenance-cadence.md`](./maintenance-cadence.md). Changes to the library
are recorded in [`CHANGELOG.md`](./CHANGELOG.md).
