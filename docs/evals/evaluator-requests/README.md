# Evaluator change requests (CP #191)

The adversarial evaluator is owned by the CP #191 lane. The skill-library lane
(#196) consumes it read-only and submits change requests here instead of editing
the shared evaluator files.

## Frozen consumer API

The following module surface is frozen for consumers. A consumer may import it
and rely on it; it does not change without a versioned, root-reviewed change to
the evaluator itself.

| Module                                                         | Frozen exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/production-readiness/src/evidence-audit-eval.ts`     | `EvidenceAuditFixtureV3Schema`, `EvidenceAuditFixtureSchema`, `EvidenceAuditReceiptSchema`, `EvidenceAuditObservedEffectSchema`, `EvidenceAuditObserver`, `EvidenceAuditExecutor`, `EvidenceAuditObservationMode`, `runEvidenceAuditEval`, `evidenceAuditMetrics`, `evidenceAuditFixtureDigest`                                                                                                                                                                                                                                                                                                            |
| `packages/production-readiness/src/adversarial-eval-corpus.ts` | `getOfflineAdversarialCorpus`, `getOfflineAdversarialSuite`, `runOfflineAdversarialCorpus`, `getOfflineSecurityProbes`, `runOfflineSecurityProbes`, `runHiddenAdversarialTaskSet`, `runRotatingAdversarialTaskSet`, `evaluateOfflineAdversarialCorpusPromotion`, `evaluateAdversarialPromotionDecision`, `compareAdversarialRuns`, `buildAdversarialRunIdentity`, `getHiddenTaskSet`, `buildAgentFacingTask`, `getRotatingTaskSet`, `runIsolatedAdversarialTask`, `runIsolatedAdversarialCase`, `buildBlindedCalibrationPacket`, `computeCalibrationAgreement`, `validateOfflineAdversarialCorpusManifest` |

Consumers import these modules directly, for example:

```ts
import { runEvidenceAuditEval } from '../../../packages/production-readiness/src/evidence-audit-eval.ts'
```

## Receipt versions

| Receipt schema | Harness | Status                                                                                                                                                          |
| -------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1              | 2.0.0   | Legacy; readable, never re-interpreted as newer evidence quality.                                                                                               |
| 2              | 3.0.0   | Current legacy lane used by the skill-library evals.                                                                                                            |
| 3              | 4.0.0   | Adds actor/runtime/source identity, independent observation, observed tool counts, and observed usage. The adversarial program runs on this version by default. |

`evidenceAuditMetrics` keeps the older metric shape for the older receipt
versions. A consumer that requires the 4.0.0 metric set must assert
`receipt.schemaVersion === 3` before reading `tool_use`, `cost_usd`, or
`tokens`.

In receipt version 3, `tool_use` counts the tool calls the host actually
observed across both the in-process tool ports and the independent observer; a
call both channels saw is counted once. `cost_usd` and `tokens` appear only when
the host supplied actually observed usage, and are never defaulted to zero.

## How to submit a change request

1. Copy `TEMPLATE.md` to `docs/evals/evaluator-requests/<YYYY-MM-DD>-<slug>.md`.
2. Fill in every section. A request without a reproducible failing case and an
   exact expected receipt is rejected.
3. The #191 owner reviews the request, decides whether the evaluator changes,
   and bumps the harness version and the pinned corpus/suite digests in the same
   change when it does.
4. Consumers never edit `packages/production-readiness/src/evidence-audit-eval.ts`,
   `packages/production-readiness/src/adversarial-eval-corpus.ts`, or their
   focused tests directly. A consumer that needs a new capability submits a
   request instead.

## Current open requests

None. Requests that are not yet accepted are listed here by the #191 owner.
