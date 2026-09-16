# Skill library baseline (M11.11 / #196)

Status: baseline inventory, measured 2026-09-15 on release 1.23.x. The validated,
machine-readable inventory lives in [`skill-library.json`](./skill-library.json) and is
regenerated with `bun scripts/validate-skills.mjs --refresh`; validation runs in the
smoke lane via `tests/skill-library.test.mjs`.

## Baseline measurements

| Metric                                           | Value                                               |
| ------------------------------------------------ | --------------------------------------------------- |
| Skills                                           | 9                                                   |
| Total SKILL.md bytes                             | see `skill-library.json` (`skillMdBytes` per skill) |
| Skills with frontmatter `name` mismatch          | 0 (validated)                                       |
| Skills with machine-specific absolute paths      | 0 (validated)                                       |
| Skills referencing files outside their directory | 0 (validated)                                       |

## Coverage map: skill → M11 audit lane

| Skill                            | Primary M11 lane / purpose                                     |
| -------------------------------- | -------------------------------------------------------------- |
| `control-plane-audit`            | #190/#194/#197 repository-wide acceptance and evidence reviews |
| `code-review`                    | standards + spec review for every merged lane                  |
| `security-and-hardening`         | #190 security and hardening guidance                           |
| `test-driven-development`        | #192/#193 regression discipline                                |
| `verification-before-completion` | #197 evidence-before-claims discipline                         |
| `incremental-implementation`     | bounded vertical slices (#192 consolidation)                   |
| `code-simplification`            | #192 stale/complexity removal                                  |
| `turborepo`                      | build/CI lane knowledge                                        |
| `typescript-advanced-types`      | implementation reference                                       |

## Known gaps against #196 acceptance (owned, sequenced)

1. **No golden/adversarial skill evals yet** — depends on #191's calibration work for
   the human baseline; the eval harness is the follow-up lane.
2. **No per-skill version field** in every frontmatter (only some carry `metadata.version`);
   the inventory JSON records current structure so version additions are diffable.
3. **Evidence contracts** (inputs, allowed mutations, outputs, verification commands,
   conditions forbidding a completion claim) are documented informally inside skill bodies;
   they must be surfaced into frontmatter-adjacent structured sections.
4. **Maintenance cadence** (review interval, deprecation process) is not yet written down.

These gaps are tracked on #196; none of them weaken repository safety rules.
