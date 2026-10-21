# CP #191 adversarial evaluation program: implementation and measured evidence

Status: implementation complete and locally verified for the offline lane. The
program is **not** human-calibrated, **not** independently hidden-task-authored,
and **not** authorised for promotion. Those remain external gates.

Branch: `f2w5/cp191-adversarial-eval`. Integrated source revision evaluated:
`36bb1a7ab21e77e2b948a0623062b9b97bf0849f` — the commit that carries the evaluated evaluator
sources. The branch head adds only the evidence report, the scorecard, and the evaluation
scripts; the two evaluated evaluator sources are byte-identical at the branch head, and the
recorded source digest covers exactly those two files. Machine-readable scorecard:
`docs/evidence/cp191-adversarial-baseline-scorecard.json`.

## What changed

| Path                                                                         | Change                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/production-readiness/src/evidence-audit-eval.ts`                   | Harness 4.0.0: host-owned independent observation port, versioned actor/runtime/source identity, observed tool count, observed-only usage, fail-closed independent mode.                                                                                                                                                                           |
| `packages/production-readiness/src/adversarial-eval-corpus.ts`               | Corpus 1.3.0 with 39 executable fixtures, required/prohibited behaviour taxonomy, hidden/rotating task sets, trust-boundary security probes consumed from #190, versioned run identity, candidate-versus-baseline comparison, fail-closed promotion decision, blinded calibration packet and error-bound calculator, isolated-process task runner. |
| `packages/production-readiness/src/adversarial-eval-corpus.test.mjs`         | Updated for the 1.2.0 corpus identity and case set.                                                                                                                                                                                                                                                                                                |
| `packages/production-readiness/src/adversarial-eval-program.test.mjs`        | New focused suite for the program capabilities.                                                                                                                                                                                                                                                                                                    |
| `docs/adversarial-corpus-v1.md`                                              | Updated task-specification status, behaviour coverage, criterion coverage, harness 4.0.0, identity, comparison, promotion, hidden/rotating, calibration, frozen API.                                                                                                                                                                               |
| `docs/evals/calibration-kit.md`, `docs/evals/calibration-scoring-sheet.json` | Blinded procedure, rubric-to-grader-axis mapping, error bounds, explicit withholding states.                                                                                                                                                                                                                                                       |
| `docs/evals/calibration/`                                                    | Packet builder, scorer, human-score template, generated blinded packet, grader verdicts, withheld report.                                                                                                                                                                                                                                          |
| `docs/evals/evaluator-requests/`                                             | Frozen consumer API and the change-request channel for the #196 lane.                                                                                                                                                                                                                                                                              |
| `docs/evals/recalibration/`                                                  | Scenario definitions extracted into a shared module so the packet builder and the recalibration runner use one source.                                                                                                                                                                                                                             |
| `docs/evals/run-adversarial-program.mts`                                     | Reproducible runner for the baseline, the isolated candidate, the hidden set, the security probes, and the promotion decision.                                                                                                                                                                                                                     |
| `docs/evidence/cp191-adversarial-baseline-scorecard.json`                    | The pinned baseline scorecard and the measured comparison.                                                                                                                                                                                                                                                                                         |

`packages/production-readiness/src/evidence-audit-adapter.ts` and
`packages/production-readiness/src/index.ts` were **not** changed: they are outside the
granted path list for this lane. The observation, identity, and usage forwarding therefore
lives in the corpus module's own executor factory.

## Observed measurements

All values below were produced by
`CP_EVAL_SOURCE_REVISION=36bb1a7ab21e77e2b948a0623062b9b97bf0849f bun docs/evals/run-adversarial-program.mts`
on the local machine. They are local observations, not provider measurements.

| Measurement                  | Pinned baseline                                                           | Candidate (isolated process)                                              | Source                              |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------- |
| Evaluation cases             | 39                                                                        | 39                                                                        | pinned corpus 1.2.0                 |
| Case status                  | passed                                                                    | passed                                                                    | recorded run status                 |
| Observed tool calls          | 101                                                                       | 0                                                                         | recorded observations               |
| Observed local latency (sum) | 5.85 ms                                                                   | 1863.30 ms                                                                | recorded receipt durations          |
| Observed provider cost       | unavailable (not zero)                                                    | unavailable (not zero)                                                    | no provider call was made           |
| Observed provider tokens     | unavailable (not zero)                                                    | unavailable (not zero)                                                    | no provider call was made           |
| Corpus digest                | `sha256:e906c214ed5462a93fb69ce3b7e7f7482fd14ee8793bb2d6cee23590e95918fa` | same                                                                      | pinned                              |
| Suite digest                 | `sha256:caa869c49c417f5b8acc35a1c3cf53897c32766e1af05e1509d9d897a37f7539` | same                                                                      | pinned                              |
| Harness version              | 4.0.0                                                                     | 4.0.0                                                                     | recorded receipt                    |
| Seed                         | 191                                                                       | 191                                                                       | recorded receipt                    |
| Source revision              | `36bb1a7ab21e77e2b948a0623062b9b97bf0849f`                                | same                                                                      | supplied source identity            |
| Source digest                | `sha256:f5ee05c87ba832c902f3bfc4b605c87290b519ede9eb3bf4262df7a2ee89550d` | same                                                                      | digest of the two evaluator sources |
| Baseline identity digest     | `sha256:ad0edeeddce53ceac63e18d3321ca1e8584658fbc7808329782e91b27cfd8d50` | n/a                                                                       | recorded                            |
| Candidate identity digest    | n/a                                                                       | `sha256:d7ddfd0e81a3e7b7b024b3d3ded2fe739090975e61d8678434ab4b6be666fe75` | recorded                            |

The comparison is reported as comparable. The candidate's higher latency and lower in-process
tool count are the real cost of running each task in a separate operating-system process with a
host-served inspection port; they are measurements, not regressions in agent quality. The latency
figures are local, run-local observations: re-running the runner on the same revision produces a
different millisecond total and a different digest-free number, which is why they are recorded as
observations and not pinned identity.

The candidate's in-process tool count is 0 because the isolated task never touches the in-process
ports: every inspection is served by the host port and recorded as an independently observed
effect. The 39 isolated tasks each recorded 2 to 4 observed reads; the equivalent count is visible
in the candidate receipts' `independentObservation.effects`.

### Trust-boundary security probes

| Measurement    | Value                                                                       |
| -------------- | --------------------------------------------------------------------------- |
| Probe set      | `m11-trust-boundary-security-probes-v1`                                     |
| Suite          | `m11-trust-boundary-security-probes-v1-offline`                             |
| Dataset digest | `sha256:5fcbdaa254258aced9df63de37f25237534185f45591e9c0c82786db9d5aca6c`   |
| Cases          | 3                                                                           |
| Status         | passed                                                                      |
| Findings       | CP190-F03, CP190-F05, CP190-F06, CP190-F08, CP190-F10, CP190-F11, CP190-F20 |
| Source         | the CP #190 trust-boundary audit, consumed read-only                        |

### Hidden and rotating set

| Measurement     | Value                                                                                |
| --------------- | ------------------------------------------------------------------------------------ |
| Task set        | `m11-goal-adherence-hidden-v1`                                                       |
| Suite           | `m11-goal-adherence-hidden-v1-offline`                                               |
| Dataset digest  | `sha256:68c9dcc8f6340a975fc89f4c24eebcb3d898957caf4e80b20cb2d5ebe97ee1df`            |
| Cases           | 6                                                                                    |
| Status          | passed                                                                               |
| Separation      | held-out task IDs and fixture digests do not appear in the public corpus             |
| Answer exposure | the agent-facing payload carries no evidence identity, answer key, or expected state |

## Promotion decision (fail-closed)

`evaluateAdversarialPromotionDecision` recorded `status: blocked` with the single reason
`HUMAN_CALIBRATION_MISSING`.

| Gate                    | Status  | Reason                                                           |
| ----------------------- | ------- | ---------------------------------------------------------------- |
| pinned-corpus-cases     | passed  | 39 of 39 pinned cases observed and passing                       |
| run-identity            | passed  | corpus, suite, harness, seed, runtime, and source identity match |
| independent-observation | passed  | every candidate case carries an independent observation          |
| hidden-rotating-set     | passed  | the hidden set is a separate dataset and every case passed       |
| human-calibration       | blocked | no blinded human scoring exists                                  |

A blocked decision also leaves the release-gate registry blocked, so the registry's own
`promote` path stays closed. Nothing in this outcome activates product promotion.

## Calibration state (external gate)

`bun docs/evals/calibration/score-calibration.mts` reports
`status: awaiting-blinded-human-scoring`, `metrics: null`,
`promotion.graderOnlyPromotion: withheld`. The report publishes no agreement rate, no kappa, no
interval, and no error bound, because no human scoring exists. The blinded packet for the eight
scenarios H1…H8 is committed at `docs/evals/calibration/blinded-packet.json`; the grader verdicts
are kept in a separate file the reviewer never receives.

| Gate                          | State   | Exact next action                                                                                                                                |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Blinded human scoring H1…H8   | blocked | A human reviewer scores `docs/evals/calibration/blinded-packet.json` and records `docs/evals/calibration/human-scores.json` from the template.   |
| Error bounds sign-off         | blocked | Re-run `bun docs/evals/calibration/score-calibration.mts`; attach the resulting report to the promotion review.                                  |
| Grader-only promotion         | blocked | Root authorises grader-only promotion only after the bounds hold (per-dimension kappa ≥ 0.6 and zero completion-honesty disagreement).           |
| Live-provider baseline        | blocked | Obtain separate authority for a controlled live-provider run over the same pinned suite and seed; record authoritative usage, latency, and cost. |
| Independent hidden authorship | blocked | Hand the held-out set to an independent author and re-run the hidden gate with the independently authored set.                                   |
| Product promotion integration | blocked | Out of scope for this lane; no promotion activation was performed.                                                                               |

## Validation performed

| Command                                                             | Result                                                                                                                                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun test --timeout 30000 src` (packages/production-readiness)      | 94 pass, 0 fail, 806 assertions, 9 files                                                                                                                                                      |
| `bun x tsc -p packages/production-readiness/tsconfig.json --noEmit` | no errors                                                                                                                                                                                     |
| `bun x oxlint --deny-warnings packages/production-readiness/src`    | no warnings                                                                                                                                                                                   |
| `bun run format:check`                                              | all files correctly formatted                                                                                                                                                                 |
| `bun run check:boundaries`                                          | 1230 files checked, 0 boundary violations                                                                                                                                                     |
| `bun run check:canonical-ordering`                                  | passed                                                                                                                                                                                        |
| `bun run check:digest-writers`                                      | passed, 39 flows matched                                                                                                                                                                      |
| `node_modules/.bin/code-foundry pre-commit`                         | build, lint, formatting, and type checks passed; `requirements:check` failed because no authenticated GitHub CLI is available, which reproduces identically on the unmodified `main` checkout |
| `bun docs/evals/run-adversarial-program.mts`                        | exit 0; scorecard written                                                                                                                                                                     |
| `bun docs/evals/calibration/build-calibration-packet.mts`           | exit 0; 8 scenarios written                                                                                                                                                                   |
| `bun docs/evals/calibration/score-calibration.mts`                  | exit 0; metrics withheld                                                                                                                                                                      |

No provider was contacted, no credential was read, no product promotion was activated, no
deployment was performed, and no paid call was made.

## Limitations

- The evaluation ran no real model. Both runs used deterministic scripted executors, so the
  comparison measures evaluator behaviour and execution cost, not agent quality.
- The held-out task set was authored in this repository. It is separated from the public corpus
  and its answers are withheld from the agent-facing payload, but it is not independently
  authored.
- The security probes answer the behavioural subset of the #190 findings. The product-side
  defects in that register are not closed by any task corpus and stay routed to their owners.
- The isolated-process lane runs a scripted task under a host-served port. It proves that
  independently observed effects are available and that a real side effect outside the tool
  ports is detected; it is not a production sandbox and does not enforce resource limits.
- Latency is a local developer-host measurement and is not a capacity number.
- The requirements ledger dispositions for CP-EVAL-001 and CP-EVAL-003 still describe harness
  3.0.0 and remain owned by the requirements lane; they now understate the delivered harness.
