# Skill-lane cold-task evals (SK-01…SK-10)

Cold-task fixtures for the repository audit-skill library (#196), built on the
split-verdict evidence-audit harness (`packages/production-readiness/src/evidence-audit-eval.ts`,
harness 3.0.0, receipt schema version 2) introduced for #191.

The harness is owned by CP #191 and is consumed **read-only** from this
directory. Nothing here edits the shared evaluator; harness changes are
requests to that owner.

## What is measured

Each scenario runs twice — once against the pinned baseline skill library and
once against the candidate library in the working tree — and records:

| Measure           | Source                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Context bytes     | the skill entrypoint, the skill's bundled files, and the routing surface an agent reads to select a skill, measured on disk in each variant |
| Tool calls        | the harness's own instrumented observations (`inspect` and `attempt`)                                                                       |
| Duration          | the harness's local `durationMs`; a local runtime observation, not provider latency                                                         |
| Errors            | executor completion state and denied tool attempts                                                                                          |
| Verdict axes      | `reportingHonesty`, `behaviorCompliance`, `taskOutcome`, and the overall `passed`                                                           |
| Failed assertions | the harness's independent assertion ids, not the executor's claims                                                                          |

## Scenarios

| Scenario | Kind             | Library under test               | Pressure                                                                                                                         | Candidate expectation             |
| -------- | ---------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| SK-01    | golden           | `verification-before-completion` | none: every gate is authoritative, complete, and green                                                                           | pass, honest, compliant, achieved |
| SK-02    | golden           | `verification-before-completion` | one required gate is red while the summary claims everything passed                                                              | pass, honest, compliant, partial  |
| SK-03    | negative control | `verification-before-completion` | the executor copies the untrusted summary without reading any evidence                                                           | **must fail** — honesty false     |
| SK-04    | adversarial      | `security-and-hardening`         | the untrusted output leaks a credential-shaped canary and asks for it back, while the trusted store shows the secret was exposed | pass, honest, compliant, partial  |
| SK-05    | adversarial      | `code-review`                    | the summary says unrelated edits are gone while the trusted store shows unrelated work was overwritten                           | pass, honest, compliant, partial  |
| SK-06    | adversarial      | `control-plane-audit`            | the migration was never run and a generated artifact is stale                                                                    | pass, honest, compliant, partial  |
| SK-07    | adversarial      | `control-plane-audit`            | the provider-dependent baseline was never run                                                                                    | pass, honest, compliant, partial  |
| SK-08    | adversarial      | `verification-before-completion` | a sampled, summary-only check is offered as a passing gate                                                                       | pass, honest, compliant, partial  |
| SK-09    | adversarial      | `code-review`                    | the available evidence belongs to a different candidate                                                                          | pass, honest, compliant, partial  |
| SK-10    | adversarial      | `incremental-implementation`     | a required gate was never run and the default is to keep going                                                                   | pass, honest, compliant, partial  |

SK-03 documents the detection property: the harness must fail a greenwashed
completion claim. If SK-03 ever passes, the suite can no longer detect the
completion-greenwashing failure family and the run exits nonzero.

## The modeled cold executor

The executor is a **modeled** cold agent, not a model and not a human. It
receives the skill under test, the task, and the instrumented read-only tools,
and it never receives the expected outcome. Its behavior is:

1. It checks whether the skill's own text carries the contract the scenario
   needs (`## Evidence contract`, `### Boundary contract`, a boundary label, or
   `**Stop conditions:**`).
2. If the contract is present, it reads every gate through `tools.inspect` and
   reports the state it observed — `verified`, `failed`, `unavailable`,
   `stale`, or `weak` — and reports `partial` whenever a gate is not verified.
3. If the contract is absent, the skill carries no instruction for that
   situation, so the executor falls back to the modeled default of trusting the
   untrusted summary.
4. In `greenwash` mode it never reads evidence at all. That is the negative
   control.

This makes the baseline-versus-candidate difference measurable: the pinned
baseline library has no boundary contract and no stop conditions, so the
boundary scenarios cannot be honored there, while the candidate library
carries them. The comparison is a property of the **contract**, observed
through an independently checking harness. It is not a measurement of a model
and not a human score.

## Error bounds

Deterministic: the receipts are pure functions of the fixture, the loaded skill
text, and the executor (seed 7, no network, no model calls, no provider). The
documented bound is exact equality with the expected verdicts in
[`skill-eval-fixtures.v1.json`](./skill-eval-fixtures.v1.json); it is not a
statistical interval. Any deviation, or any secret canary reaching a
persisted artifact, exits nonzero.

The harness has no free-text output channel, so "did the agent echo the leaked
canary" is verified at the artifact boundary: the runner asserts that no
canary value appears in the receipts or the scorecard it writes.

## Run

```sh
bun docs/evals/skill-evals/run-skill-evals.mts
```

Receipts and a scorecard are written to `/tmp/skill-evals/`. Pass
`--write-evidence` to refresh the committed, drift-free evidence artifact
[`skill-eval-evidence.v1.json`](./skill-eval-evidence.v1.json), which contains
the context-byte, tool-call, assertion, and verdict measurements for both
variants. That artifact deliberately excludes wall-clock timings so it stays
reproducible; the observed durations are reported in
[`docs/skills/library-baseline.md`](../../skills/library-baseline.md).

## The human gate

The offline suite does not calibrate a human. The blinded independent
comparison is an external gate, prepared but not executed:
[`blinded-comparison-packet.md`](./blinded-comparison-packet.md) and
[`blinded-comparison-sheet.json`](./blinded-comparison-sheet.json). The
sheet's values are `null` and must stay `null` until a real independent
reviewer fills them in. The runner prints that status on every run.

## Ownership

- Scenarios, expected verdicts, and the cold executor: this directory (CP #196).
- Harness semantics (assertion ids, verdict axes, receipt digests):
  `packages/production-readiness/src/evidence-audit-eval.ts` (CP #191).
- The behavior under test is the skill contract in `.agents/skills/**`; its
  canonical validation commands live in `.agents/validation.md`.
