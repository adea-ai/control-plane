import { z } from 'zod'

/**
 * Fail-closed retirement gate for a redundant-layer retirement (parent #943
 * clause: "Remove redundant layers only after profile parity and failure
 * tests").
 *
 * The gate is a pure, bounded decision over explicitly supplied evidence
 * handles: it reads nothing, fetches nothing, mutates nothing and never
 * executes a retirement. Evidence arrives as explicit handles — references to
 * executed test-run results or evidence artifacts with content digests — and
 * every handle is classified, never trusted.
 *
 * Epistemics (mirroring the retained-work vocabulary of
 * `scripts/langgraph-retirement-inventory.mjs`): missing, malformed, partial,
 * unattested, stale, unsupported-profile or superseded-source evidence is
 * NEVER counted as zero remaining work and NEVER yields a passing gate. The
 * verdict is `blocked` with typed reasons naming exactly which evidence is
 * missing or unusable. Only an explicitly attested, complete, current evidence
 * set for BOTH dimensions yields `allowed`, with the evidence digests echoed
 * for audit. Every evaluation is a deterministic function of its input: the
 * clock is a required argument, so repeated calls with the same input return
 * byte-identical decisions.
 *
 * Structure is never authority. A handle's declared reference, digest, profile,
 * revision and attestor are only claims until the trusted artifact verifier
 * (retirement-evidence-verifier.ts) has read the artifact bytes, matched the
 * declared digest, checked the signed content against the actual layer,
 * dimension, profile and source revision, and verified the attester's Ed25519
 * signature. That verifier registers a verified fact here; a structurally
 * identical object literal is not a verified fact and is never accepted.
 */

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/

/** Version of the gate decision shape. */
export const RETIREMENT_GATE_SCHEMA_VERSION = 1
/** Default maximum age of an attestation before its evidence counts as stale. */
export const DEFAULT_MAX_EVIDENCE_AGE_SECONDS = 2_592_000
export const MAX_EVIDENCE_AGE_SECONDS = 31_536_000

export const retirementEvidenceDimensionSchema = z.enum(['parity', 'failure'])
export type RetirementEvidenceDimension = z.output<typeof retirementEvidenceDimensionSchema>

export const retirementEvidenceStatusSchema = z.enum([
  /** Explicitly attested, complete, current, on-profile, on-revision. */
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
  /** Structurally complete, but not bound to its artifact by the trusted verifier. */
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
     * dimension's evidence is fully valid; blocked gates echo `null` for the
     * dimensions that did not attest, so an audit trail can never mistake
     * unusable evidence for accepted evidence.
     */
    attestedEvidenceDigests: z
      .object({ parity: z.string().nullable(), failure: z.string().nullable() })
      .strict(),
    /**
     * The zero-remaining-work claim, in the retained-work epistemics style: a
     * passing gate asserts profile parity and failure coverage were attested;
     * every other outcome is explicitly not-claimable with the reasons why.
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
  'unverified',
  'valid',
]

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
}

const verifiedFacts = new WeakSet<object>()

/**
 * Registers a fact produced by the trusted artifact verifier. Membership, not
 * shape, is the proof: a literal with the same fields is rejected.
 */
export function registerVerifiedRetirementEvidence(
  fact: VerifiedRetirementEvidence
): Readonly<VerifiedRetirementEvidence> {
  const frozen = Object.freeze({ ...fact })
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

/**
 * Classifies one evidence handle. Pure: a function of the raw handle value,
 * the gate expectations, the age bound and the evaluation clock.
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
    if (!statuses.has(status)) statuses.add(status)
  }

  if (raw === undefined || raw === null) {
    addStatus('missing')
    reasons.push(prefix(dimension, 'MISSING'))
    return {
      assessment: {
        dimension,
        status: 'missing',
        reference: null,
        declaredDigest: null,
        reasons,
      },
      validDigest: null,
    }
  }
  if (!isRecord(raw)) {
    addStatus('malformed')
    reasons.push(prefix(dimension, 'MALFORMED'))
    return {
      assessment: {
        dimension,
        status: 'malformed',
        reference: null,
        declaredDigest: null,
        reasons,
      },
      validDigest: null,
    }
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

  const attestation = isRecord(raw['attestation']) ? raw['attestation'] : undefined
  if (attestation === undefined) {
    addStatus('unattested')
    reasons.push(prefix(dimension, 'UNATTESTED'))
  } else {
    const attestedBy = optionalString(attestation['attestedBy'])
    if (attestedBy === null) {
      addStatus('partial')
      reasons.push(prefix(dimension, 'ATTESTED_BY_MISSING'))
    }
    const attestedAt = optionalString(attestation['attestedAt'])
    const attestedMs =
      attestedAt === null || Number.isNaN(Date.parse(attestedAt)) ? null : Date.parse(attestedAt)
    if (attestedAt === null || attestedMs === null) {
      addStatus('partial')
      reasons.push(prefix(dimension, 'ATTESTATION_TIMESTAMP_MISSING_OR_MALFORMED'))
    } else if (attestedMs > nowMs) {
      addStatus('malformed')
      reasons.push(prefix(dimension, 'ATTESTATION_TIMESTAMP_IN_FUTURE'))
    } else if (nowMs - attestedMs > maxAgeMs) {
      addStatus('stale')
      reasons.push(prefix(dimension, 'ATTESTATION_STALE'))
    }
    if (attestation['complete'] !== true) {
      // Completeness must be explicitly attested; an undeclared or false
      // completeness is never read as an implicit pass.
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

  // Structure alone never authorizes: without a fact bound to this exact
  // layer, dimension, profile, source revision, reference and digest, the
  // handle is unverified however complete it looks.
  if (!isVerifiedRetirementEvidence(verification)) {
    addStatus('unverified')
    reasons.push(prefix(dimension, 'NOT_VERIFIED'))
  } else if (
    verification.layerId !== expectations.layerId ||
    verification.dimension !== dimension ||
    verification.profileId !== expectations.targetProfileId ||
    verification.sourceRevision !== expectations.targetSourceRevision ||
    verification.reference !== reference ||
    verification.digest !== declaredDigest
  ) {
    addStatus('unverified')
    reasons.push(prefix(dimension, 'VERIFICATION_MISMATCH'))
  }

  const status = STATUS_PRECEDENCE.find((candidate) => statuses.has(candidate)) ?? 'valid'
  const valid = status === 'valid'
  if (valid) reasons.push(prefix(dimension, 'ATTESTED_COMPLETE_AND_CURRENT'))
  return {
    assessment: {
      dimension,
      status,
      reference,
      declaredDigest,
      reasons,
    },
    validDigest: valid && declaredDigest !== null ? declaredDigest : null,
  }
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
      reasons: [...parity.assessment.reasons, ...failure.assessment.reasons].toSorted(
        (left, right) => (left < right ? -1 : left > right ? 1 : 0)
      ),
    },
    evaluatedAt: parsed.now,
  }
  return RetirementGateDecisionSchema.parse(decision)
}
