import { z } from 'zod'

/**
 * Fail-closed decision for a redundant-layer retirement (parent #943 clause:
 * "Remove redundant layers only after profile parity and failure tests";
 * child #1029).
 *
 * The gate is a pure, deterministic function of explicitly supplied evidence
 * handles and of the verified facts produced by the trusted artifact verifier
 * (`retirement-evidence-verifier.ts`). It reads nothing, fetches nothing,
 * mutates nothing and never executes a retirement.
 *
 * Authority is never structural. A handle's declared reference, digest, profile,
 * revision, layer and attestation are claims until a verified fact exists for
 * the same artifact. The verdict is `allowed` only when BOTH dimensions carry a
 * verified fact whose signed layer, dimension, profile, source revision,
 * reference, digest, attestor and attestation time agree with the handle and the
 * gate expectations, and whose signed attestation is current. Freshness and
 * attestor identity are read from the VERIFIED fact, never from the handle's
 * declared attestation block; a handle that disagrees with its fact is
 * `unverified`, however complete it looks.
 *
 * Epistemics (mirroring the retained-work vocabulary of
 * `scripts/langgraph-retirement-inventory.mjs`): missing, malformed, partial,
 * unattested, stale, unsupported-profile, superseded-source, wrong-layer or
 * unverified evidence is never counted as zero remaining work and never yields
 * an `allowed` verdict.
 *
 * Trust-boundary note: the `now` input is caller-supplied. The gate is
 * deterministic in its input, so any composition that exposes it must supply
 * server time. The signature-time freshness bound that cannot be spoofed by the
 * caller is enforced by the verifier's own clock at verification time.
 */

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/

/** Version of the gate decision shape. */
export const RETIREMENT_GATE_SCHEMA_VERSION = 1
/** Default maximum age of an attestation before its evidence counts as stale. */
export const DEFAULT_MAX_EVIDENCE_AGE_SECONDS = 2_592_000
export const MAX_EVIDENCE_AGE_SECONDS = 31_536_000

/** Reason carried by every decision whose evidence lacks a verified fact. */
export const RETIREMENT_EVIDENCE_NOT_AUTHENTICATED = 'RETIREMENT_EVIDENCE_NOT_AUTHENTICATED'

export const retirementEvidenceDimensionSchema = z.enum(['parity', 'failure'])
export type RetirementEvidenceDimension = z.output<typeof retirementEvidenceDimensionSchema>

export const retirementEvidenceStatusSchema = z.enum([
  /** Verified, complete, current, on-profile, on-revision and on-layer. */
  'valid',
  /** The handle is absent. */
  'missing',
  /** The handle is not an evidence object at all. */
  'malformed',
  /** The handle is structurally present but incomplete or badly typed. */
  'partial',
  /** No attestation block: nobody vouches for the evidence. */
  'unattested',
  /** Attested, but older than the configured freshness bound. */
  'stale',
  /** Attested for a profile the retirement does not target. */
  'unsupported_profile',
  /** Attested for a source revision that has been superseded. */
  'superseded_source',
  /** Declares a layer other than the one whose retirement is being decided. */
  'wrong_layer',
  /** Structurally complete, but not bound to its signed artifact by the trusted verifier. */
  'unverified',
])
export type RetirementEvidenceStatus = z.output<typeof retirementEvidenceStatusSchema>

export const RetirementGateInputSchema = z
  .object({
    /** Identifier of the redundant layer whose retirement is being decided. */
    layerId: z.string().min(1).max(128),
    /** The profile the retirement targets; evidence must attest this profile. */
    targetProfileId: z.string().min(1).max(128).optional(),
    /** The source revision the retirement targets; evidence must attest it. */
    targetSourceRevision: z.string().min(1).max(128).optional(),
    /** Explicit parity-evidence handle (test-run result or artifact reference). */
    parityEvidence: z.unknown().optional(),
    /** Explicit failure-evidence handle (test-run result or artifact reference). */
    failureEvidence: z.unknown().optional(),
    /** Verified fact for the parity handle; only the trusted artifact verifier produces one. */
    parityVerification: z.unknown().optional(),
    /** Verified fact for the failure handle; only the trusted artifact verifier produces one. */
    failureVerification: z.unknown().optional(),
    /** Attestation age beyond which evidence counts as stale. */
    maxEvidenceAgeSeconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_EVIDENCE_AGE_SECONDS)
      .default(DEFAULT_MAX_EVIDENCE_AGE_SECONDS),
    /**
     * Deterministic evaluation clock. Required: the gate never reads the wall
     * clock, so the same input always yields the same decision.
     */
    now: z.iso.datetime(),
  })
  .strict()

export type RetirementGateInput = z.input<typeof RetirementGateInputSchema>

export const RetirementEvidenceAssessmentSchema = z
  .object({
    dimension: retirementEvidenceDimensionSchema,
    status: retirementEvidenceStatusSchema,
    /** The evidence reference when structurally readable; `null` otherwise. */
    reference: z.string().nullable(),
    /** The declared content digest when structurally readable; `null` otherwise. */
    declaredDigest: z.string().nullable(),
    /** Typed reasons, including exactly which fields are missing or unusable. */
    reasons: z.array(z.string()).max(32),
  })
  .strict()
export type RetirementEvidenceAssessment = z.output<typeof RetirementEvidenceAssessmentSchema>

export const RetirementGateDecisionSchema = z
  .object({
    schemaVersion: z.literal(RETIREMENT_GATE_SCHEMA_VERSION),
    gate: z.literal('redundant-layer-retirement'),
    layerId: z.string(),
    verdict: z.enum(['allowed', 'blocked']),
    evidence: z
      .object({
        parity: RetirementEvidenceAssessmentSchema,
        failure: RetirementEvidenceAssessmentSchema,
      })
      .strict(),
    /**
     * Content digests echoed for audit. A digest appears only when that
     * dimension's evidence is fully verified and valid; blocked gates echo `null`
     * for the dimensions that did not attest, so an audit trail can never mistake
     * unusable evidence for accepted evidence.
     */
    attestedEvidenceDigests: z
      .object({ parity: z.string().nullable(), failure: z.string().nullable() })
      .strict(),
    /**
     * The zero-remaining-work claim, in the retained-work epistemics style: a
     * passing gate asserts profile parity and failure coverage were verified and
     * attested; every other outcome is explicitly not-claimable with the reasons.
     */
    retirementClaim: z
      .object({
        claimAllowed: z.boolean(),
        claim: z.enum(['profile-parity-and-failure-attested', 'not-claimable']),
        reasons: z.array(z.string()).max(64),
      })
      .strict(),
    evaluatedAt: z.iso.datetime(),
  })
  .strict()

export type RetirementGateDecision = z.output<typeof RetirementGateDecisionSchema>

/** Bucket order decides the single reported status; every reason is kept. */
const STATUS_PRECEDENCE: readonly RetirementEvidenceStatus[] = [
  'missing',
  'malformed',
  'partial',
  'unattested',
  'stale',
  'unsupported_profile',
  'superseded_source',
  'wrong_layer',
  'unverified',
  'valid',
]

/** The execution facts the attester signed for one evidence artifact. */
export interface VerifiedRetirementExecution {
  readonly runId: string
  readonly startedAt: string
  readonly completedAt: string
  readonly casesExpected: number
  readonly casesExecuted: number
  readonly casesPassed: number
  readonly outputDigest: string
}

/** The facts a trusted verifier binds to one evidence artifact. */
export interface VerifiedRetirementEvidence {
  readonly layerId: string
  readonly dimension: RetirementEvidenceDimension
  readonly profileId: string
  readonly sourceRevision: string
  readonly reference: string
  readonly digest: string
  readonly attestedBy: string
  readonly attestedAt: string
  /** Signed completeness: always `true` for a fact the verifier produced. */
  readonly complete: true
  readonly execution: VerifiedRetirementExecution
}

const verifiedFacts = new WeakSet<object>()

/**
 * Registers a fact produced by the trusted artifact verifier. Membership, not
 * shape, is the proof: a literal with the same fields is rejected.
 */
export function registerVerifiedRetirementEvidence(
  fact: VerifiedRetirementEvidence
): Readonly<VerifiedRetirementEvidence> {
  const frozen = Object.freeze({ ...fact, execution: Object.freeze({ ...fact.execution }) })
  verifiedFacts.add(frozen)
  return frozen
}

export function isVerifiedRetirementEvidence(
  value: unknown
): value is Readonly<VerifiedRetirementEvidence> {
  return typeof value === 'object' && value !== null && verifiedFacts.has(value)
}

const prefix = (dimension: RetirementEvidenceDimension, code: string): string =>
  `${dimension.toUpperCase()}_EVIDENCE_${code}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const optionalString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

interface EvidenceExpectations {
  readonly layerId: string
  readonly targetProfileId: string | undefined
  readonly targetSourceRevision: string | undefined
}

type Freshness = 'current' | 'stale' | 'future' | 'invalid'

/** Judges one attestation timestamp against the evaluation clock and age bound. */
function freshness(attestedAt: string, nowMs: number, maxAgeMs: number): Freshness {
  const attestedMs = Date.parse(attestedAt)
  if (Number.isNaN(attestedMs)) return 'invalid'
  if (attestedMs > nowMs) return 'future'
  if (nowMs - attestedMs > maxAgeMs) return 'stale'
  return 'current'
}

/**
 * Classifies one evidence handle against the gate expectations and its verified
 * fact. Pure. `validDigest` is non-null only when the handle is fully verified.
 */
function assessEvidence(
  dimension: RetirementEvidenceDimension,
  raw: unknown,
  verification: unknown,
  expectations: EvidenceExpectations,
  maxAgeMs: number,
  nowMs: number
): { assessment: RetirementEvidenceAssessment; validDigest: string | null } {
  const reasons: string[] = []
  const statuses = new Set<RetirementEvidenceStatus>()
  const addStatus = (status: RetirementEvidenceStatus) => {
    statuses.add(status)
  }
  const finish = (
    reference: string | null,
    declaredDigest: string | null
  ): { assessment: RetirementEvidenceAssessment; validDigest: string | null } => {
    const status = STATUS_PRECEDENCE.find((candidate) => statuses.has(candidate)) ?? 'valid'
    if (status === 'valid') reasons.push(prefix(dimension, 'ATTESTED_COMPLETE_AND_CURRENT'))
    return {
      assessment: { dimension, status, reference, declaredDigest, reasons },
      validDigest: status === 'valid' && declaredDigest !== null ? declaredDigest : null,
    }
  }

  if (raw === undefined || raw === null) {
    addStatus('missing')
    reasons.push(prefix(dimension, 'MISSING'))
    return finish(null, null)
  }
  if (!isRecord(raw)) {
    addStatus('malformed')
    reasons.push(prefix(dimension, 'MALFORMED'))
    return finish(null, null)
  }

  const reference = optionalString(raw['reference'])
  if (reference === null) {
    addStatus('partial')
    reasons.push(prefix(dimension, 'REFERENCE_MISSING'))
  }
  const declaredDigest = optionalString(raw['digest'])
  if (declaredDigest === null || !DIGEST_PATTERN.test(declaredDigest)) {
    addStatus('partial')
    reasons.push(prefix(dimension, 'DIGEST_MISSING_OR_MALFORMED'))
  }
  const profileId = optionalString(raw['profileId'])
  if (profileId === null) {
    addStatus('partial')
    reasons.push(prefix(dimension, 'PROFILE_MISSING'))
  }
  const sourceRevision = optionalString(raw['sourceRevision'])
  if (sourceRevision === null) {
    addStatus('partial')
    reasons.push(prefix(dimension, 'SOURCE_REVISION_MISSING'))
  }
  // The layer is authoritative only through the verified fact; a declared layer is
  // checked when present, and a different declared layer is `wrong_layer`.
  const layerId = optionalString(raw['layerId'])

  const attestation = isRecord(raw['attestation']) ? raw['attestation'] : undefined
  const declaredAttestedBy =
    attestation === undefined ? null : optionalString(attestation['attestedBy'])
  const declaredAttestedAt =
    attestation === undefined ? null : optionalString(attestation['attestedAt'])
  if (attestation === undefined) {
    addStatus('unattested')
    reasons.push(prefix(dimension, 'UNATTESTED'))
  } else {
    if (declaredAttestedBy === null) {
      addStatus('partial')
      reasons.push(prefix(dimension, 'ATTESTED_BY_MISSING'))
    }
    if (declaredAttestedAt === null || Number.isNaN(Date.parse(declaredAttestedAt))) {
      addStatus('partial')
      reasons.push(prefix(dimension, 'ATTESTATION_TIMESTAMP_MISSING_OR_MALFORMED'))
    } else {
      const declaredFreshness = freshness(declaredAttestedAt, nowMs, maxAgeMs)
      if (declaredFreshness === 'future') {
        addStatus('malformed')
        reasons.push(prefix(dimension, 'ATTESTATION_TIMESTAMP_IN_FUTURE'))
      } else if (declaredFreshness === 'stale') {
        addStatus('stale')
        reasons.push(prefix(dimension, 'ATTESTATION_STALE'))
      }
    }
    if (attestation['complete'] !== true) {
      // Completeness must be explicitly declared; an undeclared or false value is never a pass.
      addStatus('partial')
      reasons.push(prefix(dimension, 'COMPLETENESS_NOT_ATTESTED'))
    }
  }

  if (expectations.targetProfileId === undefined) {
    addStatus('unsupported_profile')
    reasons.push('RETIREMENT_TARGET_PROFILE_UNRESOLVED')
  } else if (profileId !== null && profileId !== expectations.targetProfileId) {
    addStatus('unsupported_profile')
    reasons.push(prefix(dimension, 'PROFILE_UNSUPPORTED'))
  }
  if (expectations.targetSourceRevision === undefined) {
    addStatus('superseded_source')
    reasons.push('RETIREMENT_TARGET_SOURCE_REVISION_UNRESOLVED')
  } else if (sourceRevision !== null && sourceRevision !== expectations.targetSourceRevision) {
    addStatus('superseded_source')
    reasons.push(prefix(dimension, 'SOURCE_SUPERSEDED'))
  }
  if (layerId !== null && layerId !== expectations.layerId) {
    addStatus('wrong_layer')
    reasons.push(prefix(dimension, 'LAYER_MISMATCH'))
  }

  // Structure alone never authorizes. Without a verified fact the handle is
  // unverified however complete it looks.
  if (!isVerifiedRetirementEvidence(verification)) {
    addStatus('unverified')
    reasons.push(prefix(dimension, 'NOT_VERIFIED'))
    return finish(reference, declaredDigest)
  }

  // The fact is the authority. The handle must agree with every field it declares,
  // including the attestor and time it claims, which the fact carries as signed.
  if (
    verification.layerId !== expectations.layerId ||
    verification.dimension !== dimension ||
    verification.profileId !== expectations.targetProfileId ||
    verification.sourceRevision !== expectations.targetSourceRevision ||
    verification.reference !== reference ||
    verification.digest !== declaredDigest ||
    declaredAttestedBy !== verification.attestedBy ||
    declaredAttestedAt !== verification.attestedAt
  ) {
    addStatus('unverified')
    reasons.push(prefix(dimension, 'VERIFICATION_MISMATCH'))
    return finish(reference, declaredDigest)
  }

  // Freshness is judged on the SIGNED attestation time, not the handle's copy.
  const signedFreshness = freshness(verification.attestedAt, nowMs, maxAgeMs)
  if (signedFreshness === 'future') {
    addStatus('malformed')
    reasons.push(prefix(dimension, 'SIGNED_ATTESTATION_IN_FUTURE'))
  } else if (signedFreshness === 'stale') {
    addStatus('stale')
    reasons.push(prefix(dimension, 'SIGNED_ATTESTATION_STALE'))
  }
  if (verification.complete !== true) {
    addStatus('partial')
    reasons.push(prefix(dimension, 'SIGNED_COMPLETENESS_NOT_ATTESTED'))
  }
  return finish(reference, declaredDigest)
}

/**
 * Decides whether a redundant-layer retirement may proceed. Pure and
 * deterministic: no I/O, no wall-clock reads, no state; the same input always
 * returns the same decision.
 */
export function evaluateRetirementGate(input: RetirementGateInput): RetirementGateDecision {
  const parsed = RetirementGateInputSchema.parse(input)
  const nowMs = Date.parse(parsed.now)
  const maxAgeMs = parsed.maxEvidenceAgeSeconds * 1000
  const expectations: EvidenceExpectations = {
    layerId: parsed.layerId,
    targetProfileId: parsed.targetProfileId,
    targetSourceRevision: parsed.targetSourceRevision,
  }
  const parity = assessEvidence(
    'parity',
    parsed.parityEvidence,
    parsed.parityVerification,
    expectations,
    maxAgeMs,
    nowMs
  )
  const failure = assessEvidence(
    'failure',
    parsed.failureEvidence,
    parsed.failureVerification,
    expectations,
    maxAgeMs,
    nowMs
  )
  const allowed = parity.validDigest !== null && failure.validDigest !== null
  const unauthenticated =
    parity.assessment.status === 'unverified' || failure.assessment.status === 'unverified'
  const decision: RetirementGateDecision = {
    schemaVersion: RETIREMENT_GATE_SCHEMA_VERSION,
    gate: 'redundant-layer-retirement',
    layerId: parsed.layerId,
    verdict: allowed ? 'allowed' : 'blocked',
    evidence: { parity: parity.assessment, failure: failure.assessment },
    attestedEvidenceDigests: { parity: parity.validDigest, failure: failure.validDigest },
    retirementClaim: {
      claimAllowed: allowed,
      claim: allowed ? 'profile-parity-and-failure-attested' : 'not-claimable',
      reasons: [
        ...(unauthenticated ? [RETIREMENT_EVIDENCE_NOT_AUTHENTICATED] : []),
        ...[...parity.assessment.reasons, ...failure.assessment.reasons].toSorted((left, right) =>
          left < right ? -1 : left > right ? 1 : 0
        ),
      ],
    },
    evaluatedAt: parsed.now,
  }
  return RetirementGateDecisionSchema.parse(decision)
}
