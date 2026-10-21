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
| Provenance              | `metadata.provenance` (`origin`, `source`, `upstream_version`, `integration_version`)              | validator and `docs/skills/provenance.md`                                                        |
| Lifecycle               | `metadata.deprecated` + `metadata.superseded_by`                                                   | validator (replacement must name a retained skill)                                               |

The registry (`.agents/skills/README.md`) mirrors the routing clauses so a
human reader can scan the library; the validator fails the lane on any drift
between the registry and the skills.

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
| Routing surface (bytes an agent reads to select a skill) | 2 167                                            | 2 707      | +540                       |
| Entrypoints (all `SKILL.md`)                             | 133 904                                          | 143 123    | +9 219                     |
| Bundled skill files (all bytes)                          | 252 692                                          | 261 911    | +9 219                     |
| Cold scenarios run                                       | 10                                               | 10         | 0                          |
| Scenarios passing the harness                            | 4                                                | 9          | +5                         |
| Scenarios with honest reporting                          | 4                                                | 9          | +5                         |
| Failed harness assertions                                | 15                                               | 4          | −11                        |
| Tool calls (instrumented `inspect`)                      | 19                                               | 19         | 0                          |
| Executor errors                                          | 0                                                | 0          | 0                          |
| Observed harness duration per scenario                   | 0.1–17.5 ms (local runtime, first-run JIT noise) | 0.1–1.2 ms | not comparable across runs |

The five scenarios that changed are the ones whose contract the baseline
library does not carry: SK-04 (secrets), SK-05 (dirty worktree), SK-06
(migration and generated files), SK-07 (provider), and SK-10 (stop
conditions). The baseline library has no `### Boundary contract` and no
`**Stop conditions:**`, so a cold reader has no instruction for those
situations; the candidate library carries them and the same scenarios now
report the observed state.

The candidate still fails SK-03 on purpose: SK-03 is the negative control
that copies an untrusted summary without reading any evidence, and the
harness must reject it.

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
- the cold-task suite observes the difference between the pinned baseline and
  the candidate across ten scenarios, and the harness's negative control
  still fails as it must;
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

## Maintenance

Ownership, compatibility review, versioning, deprecation, provenance,
security, and update procedures are in
[`maintenance-cadence.md`](./maintenance-cadence.md). Changes to the library
are recorded in [`CHANGELOG.md`](./CHANGELOG.md).
