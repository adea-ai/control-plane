# Skill library baseline (M11.11 / #196)

Snapshot refreshed for the Control Plane workspace version `1.58.4` on
2026-09-27. The machine-readable inventory in [`skill-library.json`](./skill-library.json)
records each discovered Skill's description, version, bundled files, and
`SKILL.md` byte size. Regenerate it with `bun scripts/validate-skills.mjs
--refresh`; the smoke tests validate the committed inventory and local Markdown
references.

## Evidence available in this snapshot

| Measure                                          | Evidence                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| Retained Skills                                  | 9; see `skill-library.json` for names and versions                                |
| Bundled files                                    | Listed per Skill in `skill-library.json`                                          |
| Entrypoint size                                  | `skillMdBytes` per Skill in `skill-library.json`                                  |
| Frontmatter, evidence contracts, and local links | Checked by `scripts/validate-skills.mjs` and `tests/agent-skill-library.test.mjs` |
| Repository version                               | `@control-plane/workspace` `1.58.4` at the source HEAD used for this snapshot     |

These are inventory and consistency measures only. There is no comparable
before/after measurement here for loaded context, execution time, tool calls,
error rate, duplicate work, reviewer corrections, or pass/fail accuracy.

## Remaining acceptance evidence

1. The `SK-01`–`SK-03` runner uses deterministic fixtures and fixed executor
   functions. It exercises the evidence-audit harness; it does not invoke the
   Skills or measure trigger/non-trigger selection, context selection, or
   cold-task agent behavior.
2. `docs/evals/calibration-scoring-sheet.json` remains
   `awaiting-blinded-human-scoring`; a procedure or scripted trace is not human
   calibration. The prior #191 evidence also records an unsuccessful human
   calibration on harness 1.0.0 and calls for recalibration on 2.0.0.
3. No cold representative M11 audit has been compared with independent human
   reviewers in this snapshot. The earlier forward-test record explicitly
   identifies that as an outstanding gate.
4. No measured before/after efficiency comparison or committed baseline
   scorecard is available. Do not claim optimization from prose size or the
   deterministic fixture results alone.

The Skill validator is wired into the repository smoke test group. This does
not establish that the manual skill-eval runner is CI-gated or that agent
behavior has been calibrated; those are separate checks.

## Maintenance

Ownership, compatibility review, versioning, deprecation, provenance, security,
and update procedures are in [`maintenance-cadence.md`](./maintenance-cadence.md).
Changes to the library are recorded in [`CHANGELOG.md`](./CHANGELOG.md).
