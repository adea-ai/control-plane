import { createHash, type KeyObject } from 'node:crypto'
import type { ObjectStore } from '@control-plane/deployment'
import {
  createRetirementEvidenceVerifier,
  retirementEvidenceObjectKey,
  signRetirementEvidenceArtifact,
  type RetirementEvidenceArtifact,
  type RetirementEvidenceVerification,
  type TrustedRetirementAttester,
} from './retirement-evidence-verifier.js'
import {
  evaluateRetirementGate,
  type RetirementEvidenceDimension,
  type RetirementGateDecision,
} from './retirement-gate.js'

/**
 * Offline qualification of the measured retirement gate (CP #943, child #1029).
 *
 * The gate and its trusted verifier already exist and are exhaustively unit
 * tested, but nothing in the repository produced the evidence they consume, so
 * the gate could only be reached from a test. This module is that producer's
 * offline path: it takes a **measured** run for each gate dimension, attests it
 * with the attester key, stores the signed artifact through the existing
 * `ObjectStore` port, verifies it through the existing trusted verifier, and
 * evaluates the existing gate. The gate, the verifier and the artifact schema
 * are unchanged; this only supplies their inputs from real measurements.
 *
 * Boundary, stated as refusals rather than as permissions:
 *
 * - **Nothing is retired.** This module decides; it never removes a layer,
 *   never deletes an object, never touches a service and never changes a
 *   production setting. A `allowed` verdict is a measurement result, not an
 *   action, and the caller remains the only party that could act on it.
 * - **No provider is contacted.** The only write is the signed evidence
 *   artifact into the injected `ObjectStore`, which is the same offline port
 *   the verifier reads from.
 * - **The measurement is measured, not declared.** The attested output digest
 *   is computed here from the measured output bytes, so a caller cannot assert
 *   a digest for output it did not produce. The signed execution facts, the
 *   handle and the stored bytes then all bind the same measurement.
 * - **A measurement that disagrees with itself is refused** before anything is
 *   stored, with a bounded code and no partial artifact.
 * - **The clock is the caller's.** This module never reads the wall clock: the
 *   evaluation time is supplied, so the same inputs always yield the same
 *   decision, and freshness is decided by the verifier against that same clock.
 */

/** Bounded failure code for a measurement that cannot be attested as it stands. */
export const RETIREMENT_MEASUREMENT_INVALID = 'RETIREMENT_MEASUREMENT_INVALID'

/** One measured test run behind one retirement-evidence dimension. */
export interface RetirementGateMeasurement {
  /** Identity of the run, for example a test-run identifier. */
  readonly runId: string
  readonly startedAt: string
  readonly completedAt: string
  readonly casesExpected: number
  readonly casesExecuted: number
  readonly casesPassed: number
  /**
   * The measured run output. Its digest is computed from these bytes by this
   * module; a declared digest is never read, because a declared digest would
   * only be a claim about output nobody measured.
   */
  readonly output: Uint8Array
}

/** The measurement for one gate dimension, with the reference it is known by. */
export interface RetirementGateDimensionMeasurement {
  /** Stable reference of the run, for example a test-run identifier. */
  readonly reference: string
  readonly measurement: RetirementGateMeasurement
}

export interface RetirementGateQualificationOptions {
  /** Identifier of the redundant layer whose retirement is being decided. */
  readonly layerId: string
  /** The profile the retirement targets; the evidence attests this profile. */
  readonly targetProfileId: string
  /** The source revision the retirement targets; the evidence attests it. */
  readonly targetSourceRevision: string
  /** The measured profile-parity run. */
  readonly parity: RetirementGateDimensionMeasurement
  /** The measured failure-coverage run. */
  readonly failure: RetirementGateDimensionMeasurement
  /** Identity of the attester signing both artifacts. */
  readonly attesterKeyId: string
  /** The attester's private key. This module provisions no key material. */
  readonly attesterPrivateKey: KeyObject
  /** The offline object store the evidence is written to and read from. */
  readonly objectStore: ObjectStore
  /** The attesters the verifier trusts. */
  readonly trustedAttesters: readonly TrustedRetirementAttester[]
  /** Deterministic evaluation clock (server time). */
  readonly now: string
  /** Attestation age beyond which evidence counts as stale. */
  readonly maxEvidenceAgeSeconds?: number
}

export interface RetirementGateQualification {
  /** The gate decision, in the gate's own shape. */
  readonly decision: RetirementGateDecision
  /** The trusted verification result for each dimension. */
  readonly verification: {
    readonly parity: RetirementEvidenceVerification
    readonly failure: RetirementEvidenceVerification
  }
  /** What was measured, for the caller's own record. */
  readonly measured: {
    readonly parity: { readonly reference: string; readonly outputDigest: string }
    readonly failure: { readonly reference: string; readonly outputDigest: string }
  }
}

/**
 * The signed execution facts of one measurement.
 *
 * The counts must agree with each other and with the measurement window: a run
 * that reports more passed cases than it executed, or more executed cases than
 * it expected, or that completes before it started, cannot be attested as a
 * measurement of anything. A run that did not execute every expected case, or
 * that did not pass every case it executed, is an **incomplete** measurement:
 * the trusted verifier rejects such an artifact as `EXECUTION_INCOMPLETE`, so
 * it is refused here, before anything is stored, rather than stored and
 * verified into a decision that can never be anything but `blocked`.
 *
 * The measurement must also have finished at or before the attestation: an
 * attestation cannot cover a run that has not happened yet.
 */
function executionFacts(
  measurement: RetirementGateMeasurement,
  attestedAt: string
): {
  readonly runId: string
  readonly startedAt: string
  readonly completedAt: string
  readonly casesExpected: number
  readonly casesExecuted: number
  readonly casesPassed: number
  readonly outputDigest: string
} {
  const startedAt = Date.parse(measurement.startedAt)
  const completedAt = Date.parse(measurement.completedAt)
  const attestedAtMs = Date.parse(attestedAt)
  const counts =
    Number.isInteger(measurement.casesExpected) &&
    Number.isInteger(measurement.casesExecuted) &&
    Number.isInteger(measurement.casesPassed)
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    !Number.isFinite(attestedAtMs) ||
    completedAt < startedAt ||
    completedAt > attestedAtMs ||
    !counts ||
    measurement.casesExpected <= 0 ||
    measurement.casesExecuted < 0 ||
    measurement.casesPassed < 0 ||
    measurement.casesExecuted > measurement.casesExpected ||
    measurement.casesPassed > measurement.casesExecuted ||
    measurement.casesExecuted !== measurement.casesExpected ||
    measurement.casesPassed !== measurement.casesExecuted ||
    measurement.runId.length === 0 ||
    measurement.output.length === 0
  ) {
    throw new Error(RETIREMENT_MEASUREMENT_INVALID)
  }
  return {
    runId: measurement.runId,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    casesExpected: measurement.casesExpected,
    casesExecuted: measurement.casesExecuted,
    casesPassed: measurement.casesPassed,
    outputDigest: `sha256:${createHash('sha256').update(measurement.output).digest('hex')}`,
  }
}

/**
 * Qualifies the measured retirement gate offline.
 *
 * The order is deliberate: both measurements are validated first, so an invalid
 * measurement never leaves a half-written artifact behind; then each dimension
 * is attested and stored; then both are verified by the trusted verifier; and
 * only then is the gate evaluated with the handles and the verified facts.
 */
export async function qualifyRetirementGate(
  options: RetirementGateQualificationOptions
): Promise<RetirementGateQualification> {
  const dimensions = [
    { dimension: 'parity' as const, input: options.parity },
    { dimension: 'failure' as const, input: options.failure },
  ]
  // Both measurements are validated before anything is stored, so a refused
  // measurement leaves the object store exactly as it was.
  const executions = new Map<RetirementEvidenceDimension, ReturnType<typeof executionFacts>>(
    dimensions.map(({ dimension, input }) => [
      dimension,
      executionFacts(input.measurement, options.now),
    ])
  )

  const handles = new Map<RetirementEvidenceDimension, unknown>()
  const measuredByDimension = new Map<
    RetirementEvidenceDimension,
    { reference: string; outputDigest: string }
  >()
  for (const { dimension, input } of dimensions) {
    const execution = executions.get(dimension)!
    const content: Omit<RetirementEvidenceArtifact, 'signature'> = {
      schemaVersion: 1,
      kind: 'redundant-layer-retirement-evidence',
      layerId: options.layerId,
      dimension,
      profileId: options.targetProfileId,
      sourceRevision: options.targetSourceRevision,
      execution,
      completeness: true,
      attestedBy: options.attesterKeyId,
      attestedAt: options.now,
    }
    const bytes = signRetirementEvidenceArtifact(content, options.attesterPrivateKey)
    const descriptor = await options.objectStore.put({
      key: retirementEvidenceObjectKey(input.reference),
      body: bytes,
      contentType: 'application/json',
    })
    handles.set(dimension, {
      kind: 'test-run',
      reference: input.reference,
      digest: descriptor.sha256,
      profileId: options.targetProfileId,
      sourceRevision: options.targetSourceRevision,
      layerId: options.layerId,
      attestation: {
        attestedBy: options.attesterKeyId,
        attestedAt: options.now,
        complete: true,
      },
    })
    measuredByDimension.set(dimension, {
      reference: input.reference,
      outputDigest: execution.outputDigest,
    })
  }

  const verifier = createRetirementEvidenceVerifier({
    objectStore: options.objectStore,
    trustedAttesters: options.trustedAttesters,
    now: () => options.now,
    ...(options.maxEvidenceAgeSeconds === undefined
      ? {}
      : { maxEvidenceAgeSeconds: options.maxEvidenceAgeSeconds }),
  })
  const verify = async (dimension: RetirementEvidenceDimension) =>
    await verifier.verify({
      layerId: options.layerId,
      dimension,
      targetProfileId: options.targetProfileId,
      targetSourceRevision: options.targetSourceRevision,
      handle: handles.get(dimension),
    })
  const parityVerification = await verify('parity')
  const failureVerification = await verify('failure')

  const decision = evaluateRetirementGate({
    layerId: options.layerId,
    targetProfileId: options.targetProfileId,
    targetSourceRevision: options.targetSourceRevision,
    parityEvidence: handles.get('parity'),
    failureEvidence: handles.get('failure'),
    parityVerification: parityVerification.verified ? parityVerification.fact : undefined,
    failureVerification: failureVerification.verified ? failureVerification.fact : undefined,
    now: options.now,
    ...(options.maxEvidenceAgeSeconds === undefined
      ? {}
      : { maxEvidenceAgeSeconds: options.maxEvidenceAgeSeconds }),
  })

  return {
    decision,
    verification: { parity: parityVerification, failure: failureVerification },
    measured: {
      parity: measuredByDimension.get('parity')!,
      failure: measuredByDimension.get('failure')!,
    },
  }
}
