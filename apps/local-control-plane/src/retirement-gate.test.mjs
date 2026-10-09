import { expect, test } from 'bun:test'
import {
  DEFAULT_MAX_EVIDENCE_AGE_SECONDS,
  evaluateRetirementGate,
  RetirementGateDecisionSchema,
} from './retirement-gate.ts'

// Deterministic clock: the valid evidence was attested nine days before the
// evaluation, well inside the default 30-day freshness bound.
const NOW = '2026-10-09T12:00:00.000Z'
const ATTESTED_AT = '2026-10-01T00:00:00.000Z'
const STALE_ATTESTED_AT = '2026-08-15T00:00:00.000Z'
const FUTURE_ATTESTED_AT = '2026-10-09T12:00:01.000Z'

const TARGET_PROFILE = 'prf_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const OTHER_PROFILE = 'prf_01BRZ3NDEKTSV4RRFFQ69G5FAW'
const TARGET_REVISION = 'rev-9'
const SUPERSEDED_REVISION = 'rev-8'
const PARITY_DIGEST = `sha256:${'a'.repeat(64)}`
const FAILURE_DIGEST = `sha256:${'b'.repeat(64)}`

const validEvidence = (overrides = {}) => ({
  kind: 'test-run',
  reference: 'test-run:redundant-layer:parity',
  digest: PARITY_DIGEST,
  profileId: TARGET_PROFILE,
  sourceRevision: TARGET_REVISION,
  attestation: {
    attestedBy: 'svc-evidence-attestor',
    attestedAt: ATTESTED_AT,
    complete: true,
  },
  ...overrides,
})

const gateInput = (overrides = {}) => ({
  layerId: 'layer:redundant-shadow-reader',
  targetProfileId: TARGET_PROFILE,
  targetSourceRevision: TARGET_REVISION,
  parityEvidence: validEvidence(),
  failureEvidence: validEvidence({
    kind: 'evidence-artifact',
    reference: 'evidence-artifact:redundant-layer:failure-tests',
    digest: FAILURE_DIGEST,
  }),
  now: NOW,
  ...overrides,
})

test('blocks when both evidence handles are missing and names both dimensions', () => {
  const decision = evaluateRetirementGate(
    gateInput({ parityEvidence: undefined, failureEvidence: null })
  )
  expect(decision.verdict).toBe('blocked')
  expect(decision.retirementClaim).toEqual({
    claimAllowed: false,
    claim: 'not-claimable',
    reasons: expect.arrayContaining(['PARITY_EVIDENCE_MISSING', 'FAILURE_EVIDENCE_MISSING']),
  })
  expect(decision.attestedEvidenceDigests).toEqual({ parity: null, failure: null })
  expect(decision.evidence.parity.status).toBe('missing')
  expect(decision.evidence.failure.status).toBe('missing')
})

test('blocks partial evidence and names exactly which fields are missing', () => {
  const decision = evaluateRetirementGate(
    gateInput({
      parityEvidence: {
        kind: 'test-run',
        reference: 'test-run:incomplete',
        // digest absent; attestation complete.
        profileId: TARGET_PROFILE,
        sourceRevision: TARGET_REVISION,
        attestation: {
          attestedBy: 'svc-evidence-attestor',
          attestedAt: ATTESTED_AT,
          complete: true,
        },
      },
      failureEvidence: undefined,
    })
  )
  expect(decision.verdict).toBe('blocked')
  expect(decision.evidence.parity.status).toBe('partial')
  expect(decision.evidence.parity.reasons).toContain('PARITY_EVIDENCE_DIGEST_MISSING_OR_MALFORMED')
  expect(decision.evidence.failure.status).toBe('missing')
  expect(decision.attestedEvidenceDigests.parity).toBe(null)
})

test('blocks evidence whose completeness is declared false or undeclared', () => {
  for (const complete of [false, undefined]) {
    const decision = evaluateRetirementGate(
      gateInput({
        parityEvidence: validEvidence({
          attestation: {
            attestedBy: 'svc-evidence-attestor',
            attestedAt: ATTESTED_AT,
            ...(complete === undefined ? {} : { complete }),
          },
        }),
      })
    )
    expect(decision.verdict).toBe('blocked')
    expect(decision.evidence.parity.status).toBe('partial')
    expect(decision.evidence.parity.reasons).toContain('PARITY_EVIDENCE_COMPLETENESS_NOT_ATTESTED')
  }
})

test('blocks unattested evidence instead of trusting its content', () => {
  const decision = evaluateRetirementGate(
    gateInput({
      parityEvidence: validEvidence({ attestation: undefined }),
      failureEvidence: validEvidence({
        attestation: { attestedAt: ATTESTED_AT, complete: true },
        digest: FAILURE_DIGEST,
        reference: 'evidence-artifact:failure-tests',
      }),
    })
  )
  expect(decision.verdict).toBe('blocked')
  expect(decision.evidence.parity.status).toBe('unattested')
  expect(decision.evidence.parity.reasons).toContain('PARITY_EVIDENCE_UNATTESTED')
  expect(decision.evidence.failure.status).toBe('partial')
  expect(decision.evidence.failure.reasons).toContain('FAILURE_EVIDENCE_ATTESTED_BY_MISSING')
})

test('blocks stale evidence past the freshness bound', () => {
  const decision = evaluateRetirementGate(
    gateInput({
      parityEvidence: validEvidence({
        attestation: {
          attestedBy: 'svc-evidence-attestor',
          attestedAt: STALE_ATTESTED_AT,
          complete: true,
        },
      }),
    })
  )
  expect(decision.verdict).toBe('blocked')
  expect(decision.evidence.parity.status).toBe('stale')
  expect(decision.evidence.parity.reasons).toContain('PARITY_EVIDENCE_ATTESTATION_STALE')
  // The same evidence passes when the operator explicitly widens the bound:
  // staleness is a configured bound, not an absolute.
  const widened = evaluateRetirementGate(
    gateInput({
      parityEvidence: validEvidence({
        attestation: {
          attestedBy: 'svc-evidence-attestor',
          attestedAt: STALE_ATTESTED_AT,
          complete: true,
        },
      }),
      maxEvidenceAgeSeconds: DEFAULT_MAX_EVIDENCE_AGE_SECONDS * 2,
    })
  )
  expect(widened.verdict).toBe('allowed')
})

test('blocks a future-dated attestation instead of accepting a pre-parity claim', () => {
  const decision = evaluateRetirementGate(
    gateInput({
      parityEvidence: validEvidence({
        attestation: {
          attestedBy: 'svc-evidence-attestor',
          attestedAt: FUTURE_ATTESTED_AT,
          complete: true,
        },
      }),
    })
  )
  expect(decision.verdict).toBe('blocked')
  expect(decision.evidence.parity.status).toBe('malformed')
  expect(decision.evidence.parity.reasons).toContain(
    'PARITY_EVIDENCE_ATTESTATION_TIMESTAMP_IN_FUTURE'
  )
})

test('blocks evidence from an unsupported profile', () => {
  const decision = evaluateRetirementGate(
    gateInput({
      parityEvidence: validEvidence({ profileId: OTHER_PROFILE }),
    })
  )
  expect(decision.verdict).toBe('blocked')
  expect(decision.evidence.parity.status).toBe('unsupported_profile')
  expect(decision.evidence.parity.reasons).toContain('PARITY_EVIDENCE_PROFILE_UNSUPPORTED')
})

test('blocks evidence from a superseded source revision', () => {
  const decision = evaluateRetirementGate(
    gateInput({
      failureEvidence: validEvidence({
        digest: FAILURE_DIGEST,
        reference: 'evidence-artifact:failure-tests',
        sourceRevision: SUPERSEDED_REVISION,
      }),
    })
  )
  expect(decision.verdict).toBe('blocked')
  expect(decision.evidence.failure.status).toBe('superseded_source')
  expect(decision.evidence.failure.reasons).toContain('FAILURE_EVIDENCE_SOURCE_SUPERSEDED')
})

test('fails closed when the gate targets themselves are unresolved', () => {
  // Even a fully attested evidence set cannot pass a gate that cannot say
  // which profile and revision the retirement targets.
  const decision = evaluateRetirementGate(
    gateInput({ targetProfileId: undefined, targetSourceRevision: undefined })
  )
  expect(decision.verdict).toBe('blocked')
  expect(decision.evidence.parity.reasons).toContain('RETIREMENT_TARGET_PROFILE_UNRESOLVED')
  expect(decision.evidence.parity.reasons).toContain('RETIREMENT_TARGET_SOURCE_REVISION_UNRESOLVED')
  expect(decision.evidence.failure.reasons).toContain('RETIREMENT_TARGET_PROFILE_UNRESOLVED')
  expect(decision.evidence.failure.reasons).toContain(
    'RETIREMENT_TARGET_SOURCE_REVISION_UNRESOLVED'
  )
  expect(decision.retirementClaim.claimAllowed).toBe(false)
})

test('blocks malformed evidence handles instead of guessing', () => {
  for (const malformed of ['test-run:parity', 42, [], true]) {
    const decision = evaluateRetirementGate(gateInput({ parityEvidence: malformed }))
    expect(decision.verdict).toBe('blocked')
    expect(decision.evidence.parity.status).toBe('malformed')
    expect(decision.evidence.parity.reasons).toContain('PARITY_EVIDENCE_MALFORMED')
  }
})

test('allows only a complete attested current evidence set and echoes digests', () => {
  const decision = evaluateRetirementGate(gateInput())
  expect(decision).toEqual({
    schemaVersion: 1,
    gate: 'redundant-layer-retirement',
    layerId: 'layer:redundant-shadow-reader',
    verdict: 'allowed',
    evidence: {
      parity: {
        dimension: 'parity',
        status: 'valid',
        reference: 'test-run:redundant-layer:parity',
        declaredDigest: PARITY_DIGEST,
        reasons: ['PARITY_EVIDENCE_ATTESTED_COMPLETE_AND_CURRENT'],
      },
      failure: {
        dimension: 'failure',
        status: 'valid',
        reference: 'evidence-artifact:redundant-layer:failure-tests',
        declaredDigest: FAILURE_DIGEST,
        reasons: ['FAILURE_EVIDENCE_ATTESTED_COMPLETE_AND_CURRENT'],
      },
    },
    attestedEvidenceDigests: { parity: PARITY_DIGEST, failure: FAILURE_DIGEST },
    retirementClaim: {
      claimAllowed: true,
      claim: 'profile-parity-and-failure-attested',
      reasons: [
        'FAILURE_EVIDENCE_ATTESTED_COMPLETE_AND_CURRENT',
        'PARITY_EVIDENCE_ATTESTED_COMPLETE_AND_CURRENT',
      ],
    },
    evaluatedAt: NOW,
  })
})

test('echoes only the valid dimension digest when the other dimension blocks', () => {
  const decision = evaluateRetirementGate(gateInput({ failureEvidence: undefined }))
  expect(decision.verdict).toBe('blocked')
  expect(decision.attestedEvidenceDigests.parity).toBe(PARITY_DIGEST)
  expect(decision.attestedEvidenceDigests.failure).toBe(null)
})

test('is deterministic across repeated calls and never reads the wall clock', () => {
  const first = evaluateRetirementGate(gateInput())
  const second = evaluateRetirementGate(gateInput())
  expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  expect(RetirementGateDecisionSchema.safeParse(first).success).toBe(true)

  // The same evidence flips to blocked exactly when the supplied clock crosses
  // the configured bound — staleness is a function of the input, not of when
  // the gate runs.
  const later = evaluateRetirementGate(gateInput({ now: '2026-11-15T00:00:00.000Z' }))
  expect(later.verdict).toBe('blocked')
  expect(later.evidence.parity.status).toBe('stale')
  expect(later.evaluatedAt).toBe('2026-11-15T00:00:00.000Z')
})

test('rejects malformed gate requests instead of deciding them', () => {
  expect(() => evaluateRetirementGate({ ...gateInput(), now: undefined })).toThrow()
  expect(() => evaluateRetirementGate({ ...gateInput(), layerId: '' })).toThrow()
  expect(() => evaluateRetirementGate(gateInput({ extra: true }))).toThrow()
})
