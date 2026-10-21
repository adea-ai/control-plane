# Measured redundant-layer retirement gate — offline qualification (CP #943, child #1029)

This document covers the offline qualification of the redundant-layer retirement gate: how a
**measured** profile-parity run and a **measured** failure-coverage run become the evidence the
gate decides on. The implementation is
`apps/local-control-plane/src/retirement-gate-qualification.ts`; the gate, the trusted verifier and
the artifact schema it uses are unchanged.

Nothing here retires a layer, deletes an object, stops a service or changes a production setting.
The qualification decides; the caller remains the only party that could act on the decision, and an
`allowed` verdict is a measurement result, not an action. No live operational acceptance is claimed
anywhere in this document.

## What already existed, and what was missing

The gate (`apps/local-control-plane/src/retirement-gate.ts`) and its trusted verifier
(`apps/local-control-plane/src/retirement-evidence-verifier.ts`) were merged with the operational
controls. Both are exhaustive in isolation: the gate decides from evidence handles and verified
facts, and the verifier turns a signed artifact read through the existing `ObjectStore` port into a
verified fact.

What did not exist was the step before them. Nothing in the repository produced the evidence the
gate consumes, so the gate was reachable only from a test, and the removal condition's
"profile parity and failure tests" had no producer. The qualification is that producer's offline
path.

## The measurement

Each gate dimension is backed by one measured run:

| Field                                           | Meaning                    |
| ----------------------------------------------- | -------------------------- |
| `runId`                                         | Identity of the run.       |
| `startedAt`, `completedAt`                      | The measurement window.    |
| `casesExpected`, `casesExecuted`, `casesPassed` | The run's own counts.      |
| `output`                                        | The measured output bytes. |

The output **digest is computed by the qualification** from those bytes. A declared digest is never
read, because a declared digest is only a claim about output nobody measured. The digest travels
into the signed artifact, so the signature covers the measurement's output, and the handle's digest
covers the stored artifact bytes.

A measurement that disagrees with itself is refused **before anything is stored**, with the bounded
code `RETIREMENT_MEASUREMENT_INVALID`:

- more passed cases than executed, or more executed cases than expected;
- a run that did not execute every expected case, or that did not pass every case it executed — an
  incomplete run, which the trusted verifier rejects as `EXECUTION_INCOMPLETE` anyway;
- a run that completed before it started, or that has not finished by the attestation time;
- empty output, or an empty run identity.

Refusing these up front means a qualification never leaves a half-written artifact behind, and never
stores an artifact that could only ever verify into a `blocked` decision.

## The qualification

`qualifyRetirementGate(options)` does five things, in this order:

1. **Validate both measurements.** Both are checked before any write, so a refused measurement
   leaves the object store exactly as it was.
2. **Attest and store.** For each dimension the artifact content is built from the measurement and
   signed with the attester's Ed25519 key, then written through the existing `ObjectStore` port
   under `retirementEvidenceObjectKey(reference)`. The handle that describes it is derived from the
   store's own descriptor, so the handle's digest is the digest of the bytes that were stored.
3. **Verify.** Both handles are verified by the existing trusted verifier, against the injected
   trusted attesters and the injected clock. Only a fact the verifier produced counts; the
   qualification never asserts one.
4. **Decide.** The existing gate is evaluated with the handles and the verified facts. An
   unverified dimension is passed as absent, so the gate blocks exactly as it would for any other
   caller.
5. **Report.** The decision, both verification results and what was measured are returned. Nothing
   else is returned and nothing else is done.

The clock is the caller's. The qualification never reads the wall clock, so the same inputs always
yield the same decision, and the verifier decides freshness against that same clock.

## What the qualification guarantees

| Property                                                                                                                                                                            | Why it holds                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The decision is `allowed` only when **both** dimensions are measured, complete, attested by a trusted attester, current, and bound to the target profile, source revision and layer | The gate requires a verified fact per dimension and the verifier produces one only from a matching signed artifact. A wrong key is `SIGNATURE_INVALID`, an unknown attester is `ATTESTER_UNTRUSTED`, a mismatched binding is `BINDING_MISMATCH`, and every one of them blocks. |
| The measurement cannot be a claim                                                                                                                                                   | The attested output digest is computed from the measured bytes; a caller cannot supply a digest for output it did not produce.                                                                                                                                                 |
| An incomplete run is never evidence                                                                                                                                                 | It is refused before anything is stored.                                                                                                                                                                                                                                       |
| A measurement that has not happened yet cannot be attested                                                                                                                          | The measurement must have completed at or before the attestation time.                                                                                                                                                                                                         |
| Nothing is retired                                                                                                                                                                  | The qualification writes only the two evidence objects, deletes nothing, and returns a decision. The gate itself performs no retirement either.                                                                                                                                |
| No provider is contacted                                                                                                                                                            | The only I/O is the injected offline `ObjectStore` port, which the verifier already reads from.                                                                                                                                                                                |
| A blocked decision never claims a zero                                                                                                                                              | The gate's claim vocabulary keeps unusable evidence out of the claim, and the qualification passes an unverified dimension as absent.                                                                                                                                          |

## Scope and holds

- This document and the qualification are **repository-side controls only**. Nothing shuts down,
  deletes, converts, reconciles or migrates work, and no deployment or provider was contacted.
- The qualification is not wired into a deployment. Wiring it into a composition is a separate step
  with its own owner, and this work does not make it.
- No live profile gate, no deployed observation and no attestation of a deployed scope is claimed.
  The verifier only trusts what it is given, and this work provisions no key material and no trust
  configuration.
- The removal condition itself is unchanged: zero retained legacy threads in deployed-dsn scope from
  complete reads with an attestation, every admissible legacy graph version covered by an
  evidence-equivalent replacement report, and profile and failure evidence proven for each
  replacement. A qualification that reaches `allowed` supplies the last of those; it supplies none
  of the others.
- Auto-merge stays off. No issue is closed, and no claim is made that CP #943 or child #1029 is
  complete.

## Coverage

`apps/local-control-plane/src/retirement-gate-qualification.test.mjs` runs entirely against a
disposable temporary object store and synthetic measurement output:

| Test                                                                                    | Covers                                                                                        |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `qualifies a measured gate when both dimensions are measured, verified and current`     | the allowed verdict, the claim vocabulary, and the echoed digests                             |
| `derives the attested output digest from the measured output bytes`                     | the digest is computed from the bytes, and the references are reported                        |
| `refuses a measurement that disagrees with itself or is incomplete, and stores nothing` | every refusal, including the incomplete run and the future measurement                        |
| `blocks the gate when the attester is not trusted, and names the dimension`             | the untrusted-key and unknown-attester paths, and that a blocked decision never claims a zero |
| `binds the measured evidence to the requested profile and source revision`              | the verified fact carries exactly the requested layer, profile and revision                   |
| `attests at the evaluation clock, never at a caller-declared earlier time`              | the attestation time is the evaluation clock                                                  |
| `never retires anything: the qualification only writes the two evidence objects`        | no deletion, and the decision is a result rather than an action                               |
| `is deterministic for the same inputs`                                                  | the same inputs yield the same decision and the same measurement record                       |
