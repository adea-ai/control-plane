# Evaluator change request: <slug>

- Requested by: <owner and lane>
- Date: <YYYY-MM-DD>
- Target module: `packages/production-readiness/src/evidence-audit-eval.ts` or
  `packages/production-readiness/src/adversarial-eval-corpus.ts`
- Consumed by: <consumer, for example the #196 skill-library lane>

## Problem

<What the consumer cannot do with the frozen API, and why the existing surface
does not already cover it.>

## Requested change

<The smallest change that unblocks the consumer. Include the exact exported
names, signatures, and shapes.>

## Compatibility

- Existing consumers affected: <none, or list>
- Existing receipt versions affected: <none, or list>
- New harness version required: <no, or yes: 4.0.0 -> 4.1.0>
- Pinned corpus/suite digest change required: <no, or yes>

## Reproducible failing case

<The smallest test that fails today and passes after the change. Include the
fixture, the executor, and the expected receipt.>

## Expected receipt

<The exact expected assertions, verdicts, and metric values.>

## Alternatives considered

<Other approaches and why they were rejected.>
