import { afterEach, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesystemObjectStore } from '@control-plane/object-store'
import {
  createRetirementEvidenceVerifier,
  retirementEvidenceObjectKey,
  signRetirementEvidenceArtifact,
} from './retirement-evidence-verifier.ts'
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

const LAYER = 'layer:redundant-shadow-reader'
const TARGET_PROFILE = 'prf_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const OTHER_PROFILE = 'prf_01BRZ3NDEKTSV4RRFFQ69G5FAW'
const TARGET_REVISION = 'rev-9'
const SUPERSEDED_REVISION = 'rev-8'
const PARITY_DIGEST = `sha256:${'a'.repeat(64)}`
const FAILURE_DIGEST = `sha256:${'b'.repeat(64)}`
const ATTESTOR = 'svc-evidence-attestor'

const attestorKeys = generateKeyPairSync('ed25519')
const attestorPublicKey = attestorKeys.publicKey.export({ format: 'jwk' }).x
const rogueKeys = generateKeyPairSync('ed25519')

const directories = new Set()
const stores = new Set()
afterEach(async () => {
  for (const store of stores) store.close()
  stores.clear()
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true })
    directories.delete(directory)
  }
})

async function createFixture({ maxArtifactBytes } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'retirement-evidence-'))
  directories.add(directory)
  const objectStore = new FilesystemObjectStore({
    rootDirectory: join(directory, 'objects'),
    maxObjectBytes: 64 * 1024 * 1024,
  })
  stores.add(objectStore)
  const verifier = createRetirementEvidenceVerifier({
    objectStore,
    trustedAttesters: [{ keyId: ATTESTOR, publicKey: attestorPublicKey }],
    ...(maxArtifactBytes === undefined ? {} : { maxArtifactBytes }),
  })
  return { objectStore, verifier }
}

/** Stores one signed evidence artifact and returns the handle that declares it. */
async function storeEvidence(fixture, overrides = {}) {
  const content = {
    schemaVersion: 1,
    kind: 'redundant-layer-retirement-evidence',
    layerId: LAYER,
    dimension: 'parity',
    profileId: TARGET_PROFILE,
    sourceRevision: TARGET_REVISION,
    completeness: true,
    attestedBy: ATTESTOR,
    attestedAt: ATTESTED_AT,
    ...overrides.content,
  }
  const privateKey = overrides.privateKey ?? attestorKeys.privateKey
  const reference = overrides.reference ?? `test-run:${content.dimension}:${content.layerId}`
  const bytes = signRetirementEvidenceArtifact(content, privateKey)
  const descriptor = await fixture.objectStore.put({
    key: retirementEvidenceObjectKey(reference),
    body: overrides.body ?? bytes,
    contentType: 'application/json',
  })
  return {
    kind: 'test-run',
    reference,
    digest: overrides.digest ?? descriptor.sha256,
    profileId: content.profileId,
    sourceRevision: content.sourceRevision,
    attestation: {
      attestedBy: content.attestedBy,
      attestedAt: content.attestedAt,
      complete: true,
    },
    ...overrides.handle,
  }
}

function verifiedInput(fixture, dimension, handle, expectations = {}) {
  return fixture.verifier.verify({
    layerId: expectations.layerId ?? LAYER,
    dimension,
    targetProfileId: expectations.targetProfileId ?? TARGET_PROFILE,
    targetSourceRevision: expectations.targetSourceRevision ?? TARGET_REVISION,
    handle,
  })
}

/** Gate input with both handles verified through the real artifact verifier. */
async function verifiedGateInput(fixture, overrides = {}) {
  const parity = await storeEvidence(fixture, { content: { dimension: 'parity' } })
  const failure = await storeEvidence(fixture, {
    reference: 'evidence-artifact:redundant-layer:failure-tests',
    content: { dimension: 'failure' },
  })
  const parityResult = await verifiedInput(fixture, 'parity', parity)
  const failureResult = await verifiedInput(fixture, 'failure', failure)
  return {
    layerId: LAYER,
    targetProfileId: TARGET_PROFILE,
    targetSourceRevision: TARGET_REVISION,
    parityEvidence: parity,
    failureEvidence: failure,
    parityVerification: parityResult.verified ? parityResult.fact : undefined,
    failureVerification: failureResult.verified ? failureResult.fact : undefined,
    now: NOW,
    ...overrides,
  }
}

// Structural cases: handles are shaped as declared, with no stored object.
const validEvidence = (overrides = {}) => ({
  kind: 'test-run',
  reference: 'test-run:redundant-layer:parity',
  digest: PARITY_DIGEST,
  profileId: TARGET_PROFILE,
  sourceRevision: TARGET_REVISION,
  attestation: {
    attestedBy: ATTESTOR,
    attestedAt: ATTESTED_AT,
    complete: true,
  },
  ...overrides,
})

const gateInput = (overrides = {}) => ({
  layerId: LAYER,
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
        attestation: { attestedBy: ATTESTOR, attestedAt: ATTESTED_AT, complete: true },
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
            attestedBy: ATTESTOR,
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
        attestation: { attestedBy: ATTESTOR, attestedAt: STALE_ATTESTED_AT, complete: true },
      }),
    })
  )
  expect(decision.verdict).toBe('blocked')
  expect(decision.evidence.parity.status).toBe('stale')
  expect(decision.evidence.parity.reasons).toContain('PARITY_EVIDENCE_ATTESTATION_STALE')
})

test('blocks a future-dated attestation instead of accepting a pre-parity claim', () => {
  const decision = evaluateRetirementGate(
    gateInput({
      parityEvidence: validEvidence({
        attestation: { attestedBy: ATTESTOR, attestedAt: FUTURE_ATTESTED_AT, complete: true },
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
    gateInput({ parityEvidence: validEvidence({ profileId: OTHER_PROFILE }) })
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
  const decision = evaluateRetirementGate(
    gateInput({ targetProfileId: undefined, targetSourceRevision: undefined })
  )
  expect(decision.verdict).toBe('blocked')
  expect(decision.evidence.parity.reasons).toContain('RETIREMENT_TARGET_PROFILE_UNRESOLVED')
  expect(decision.evidence.parity.reasons).toContain('RETIREMENT_TARGET_SOURCE_REVISION_UNRESOLVED')
  expect(decision.evidence.failure.reasons).toContain('RETIREMENT_TARGET_PROFILE_UNRESOLVED')
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

test('structure alone is non-authorizing: a complete, current handle without verification is unverified', () => {
  const decision = evaluateRetirementGate(gateInput())
  expect(decision.verdict).toBe('blocked')
  expect(decision.evidence.parity.status).toBe('unverified')
  expect(decision.evidence.parity.reasons).toContain('PARITY_EVIDENCE_NOT_VERIFIED')
  expect(decision.evidence.failure.status).toBe('unverified')
  expect(decision.attestedEvidenceDigests).toEqual({ parity: null, failure: null })
  expect(decision.retirementClaim.claimAllowed).toBe(false)
})

test('a structurally identical literal is not a verified fact', () => {
  const decision = evaluateRetirementGate(
    gateInput({
      parityVerification: {
        layerId: LAYER,
        dimension: 'parity',
        profileId: TARGET_PROFILE,
        sourceRevision: TARGET_REVISION,
        reference: 'test-run:redundant-layer:parity',
        digest: PARITY_DIGEST,
        attestedBy: ATTESTOR,
        attestedAt: ATTESTED_AT,
      },
    })
  )
  expect(decision.verdict).toBe('blocked')
  expect(decision.evidence.parity.status).toBe('unverified')
})

test('allows only a verified, complete, attested, current evidence set and echoes digests', async () => {
  const fixture = await createFixture()
  const input = await verifiedGateInput(fixture)
  const decision = evaluateRetirementGate(input)
  expect(decision.verdict).toBe('allowed')
  expect(decision.evidence.parity.status).toBe('valid')
  expect(decision.evidence.parity.reasons).toEqual([
    'PARITY_EVIDENCE_ATTESTED_COMPLETE_AND_CURRENT',
  ])
  expect(decision.evidence.failure.status).toBe('valid')
  expect(decision.attestedEvidenceDigests).toEqual({
    parity: input.parityEvidence.digest,
    failure: input.failureEvidence.digest,
  })
  expect(decision.retirementClaim).toEqual({
    claimAllowed: true,
    claim: 'profile-parity-and-failure-attested',
    reasons: [
      'FAILURE_EVIDENCE_ATTESTED_COMPLETE_AND_CURRENT',
      'PARITY_EVIDENCE_ATTESTED_COMPLETE_AND_CURRENT',
    ],
  })
  expect(RetirementGateDecisionSchema.safeParse(decision).success).toBe(true)
})

test('echoes only the verified dimension digest when the other dimension blocks', async () => {
  const fixture = await createFixture()
  const input = await verifiedGateInput(fixture, { failureVerification: undefined })
  const decision = evaluateRetirementGate(input)
  expect(decision.verdict).toBe('blocked')
  expect(decision.attestedEvidenceDigests.parity).toBe(input.parityEvidence.digest)
  expect(decision.attestedEvidenceDigests.failure).toBe(null)
  expect(decision.evidence.failure.status).toBe('unverified')
})

test('forged attestation: a signature by an untrusted key is rejected', async () => {
  const fixture = await createFixture()
  const handle = await storeEvidence(fixture, { privateKey: rogueKeys.privateKey })
  expect(await verifiedInput(fixture, 'parity', handle)).toEqual({
    verified: false,
    code: 'SIGNATURE_INVALID',
  })
})

test('unknown attester is rejected even when the bytes are well-formed', async () => {
  const fixture = await createFixture()
  const handle = await storeEvidence(fixture, {
    content: { attestedBy: 'svc-unknown-attestor' },
    handle: {
      attestation: { attestedBy: 'svc-unknown-attestor', attestedAt: ATTESTED_AT, complete: true },
    },
  })
  expect(await verifiedInput(fixture, 'parity', handle)).toEqual({
    verified: false,
    code: 'ATTESTER_UNTRUSTED',
  })
})

test('wrong hash: a declared digest that does not match the stored bytes is rejected', async () => {
  const fixture = await createFixture()
  const handle = await storeEvidence(fixture, { digest: `sha256:${'c'.repeat(64)}` })
  expect(await verifiedInput(fixture, 'parity', handle)).toEqual({
    verified: false,
    code: 'DIGEST_MISMATCH',
  })
})

test('tampered content with a re-declared digest fails the signature, not the digest', async () => {
  const fixture = await createFixture()
  const handle = await storeEvidence(fixture)
  const tampered = signRetirementEvidenceArtifact(
    {
      schemaVersion: 1,
      kind: 'redundant-layer-retirement-evidence',
      layerId: LAYER,
      dimension: 'parity',
      profileId: TARGET_PROFILE,
      sourceRevision: TARGET_REVISION,
      completeness: true,
      attestedBy: ATTESTOR,
      attestedAt: ATTESTED_AT,
    },
    rogueKeys.privateKey
  )
  const stored = await fixture.objectStore.put({
    key: retirementEvidenceObjectKey(handle.reference),
    body: tampered,
    contentType: 'application/json',
  })
  expect(await verifiedInput(fixture, 'parity', { ...handle, digest: stored.sha256 })).toEqual({
    verified: false,
    code: 'SIGNATURE_INVALID',
  })
})

test('wrong layer, profile and source revision are each rejected as a binding mismatch', async () => {
  const fixture = await createFixture()
  const handle = await storeEvidence(fixture)
  for (const expectations of [
    { layerId: 'layer:other' },
    { targetProfileId: OTHER_PROFILE },
    { targetSourceRevision: SUPERSEDED_REVISION },
  ]) {
    expect(await verifiedInput(fixture, 'parity', handle, expectations)).toEqual({
      verified: false,
      code: 'BINDING_MISMATCH',
    })
  }
  expect(await verifiedInput(fixture, 'failure', handle)).toEqual({
    verified: false,
    code: 'BINDING_MISMATCH',
  })
})

test('a handle that declares a different attestor than the signed artifact is rejected', async () => {
  const fixture = await createFixture()
  const handle = await storeEvidence(fixture, {
    handle: { attestation: { attestedBy: 'svc-other', attestedAt: ATTESTED_AT, complete: true } },
  })
  expect(await verifiedInput(fixture, 'parity', handle)).toEqual({
    verified: false,
    code: 'ATTESTATION_MISMATCH',
  })
})

test('missing objects and oversized artifacts are bounded, generic failures', async () => {
  const fixture = await createFixture({ maxArtifactBytes: 64 })
  const missing = {
    kind: 'test-run',
    reference: 'test-run:never-stored',
    digest: PARITY_DIGEST,
    profileId: TARGET_PROFILE,
    sourceRevision: TARGET_REVISION,
    attestation: { attestedBy: ATTESTOR, attestedAt: ATTESTED_AT, complete: true },
  }
  expect(await verifiedInput(fixture, 'parity', missing)).toEqual({
    verified: false,
    code: 'OBJECT_UNAVAILABLE',
  })
  const oversized = await storeEvidence(fixture)
  expect(await verifiedInput(fixture, 'parity', oversized)).toEqual({
    verified: false,
    code: 'SIZE_INVALID',
  })
})

test('malformed handles and non-JSON objects are rejected without trusting structure', async () => {
  const fixture = await createFixture()
  for (const handle of [null, 'test-run', { reference: '', digest: PARITY_DIGEST }]) {
    expect(await verifiedInput(fixture, 'parity', handle)).toEqual({
      verified: false,
      code: 'HANDLE_INVALID',
    })
  }
  // Bytes that match their declared digest but are not a signed artifact.
  const handle = await storeEvidence(fixture, {
    body: new TextEncoder().encode('not json'),
  })
  expect(await verifiedInput(fixture, 'parity', handle)).toEqual({
    verified: false,
    code: 'CONTENT_INVALID',
  })
})

test('a verified fact from another layer cannot authorize this gate', async () => {
  const fixture = await createFixture()
  const input = await verifiedGateInput(fixture)
  const otherLayer = await verifiedInput(fixture, 'parity', input.parityEvidence, {
    layerId: 'layer:other',
  })
  expect(otherLayer.verified).toBe(false)
  const decision = evaluateRetirementGate({ ...input, layerId: 'layer:other' })
  expect(decision.verdict).toBe('blocked')
  expect(decision.evidence.parity.status).toBe('unverified')
  expect(decision.evidence.parity.reasons).toContain('PARITY_EVIDENCE_VERIFICATION_MISMATCH')
})

test('a verified fact cannot be reused for a handle that declares another reference', async () => {
  const fixture = await createFixture()
  const input = await verifiedGateInput(fixture)
  const decision = evaluateRetirementGate({
    ...input,
    parityEvidence: { ...input.parityEvidence, reference: 'test-run:swapped' },
  })
  expect(decision.verdict).toBe('blocked')
  expect(decision.evidence.parity.status).toBe('unverified')
  expect(decision.evidence.parity.reasons).toContain('PARITY_EVIDENCE_VERIFICATION_MISMATCH')
})

test('the verifier rejects invalid trust configuration and limits', async () => {
  const fixture = await createFixture()
  expect(() =>
    createRetirementEvidenceVerifier({ objectStore: fixture.objectStore, trustedAttesters: [] })
  ).toThrow('RETIREMENT_EVIDENCE_TRUST_INVALID')
  expect(() =>
    createRetirementEvidenceVerifier({
      objectStore: fixture.objectStore,
      trustedAttesters: [{ keyId: 'bad key', publicKey: attestorPublicKey }],
    })
  ).toThrow('RETIREMENT_EVIDENCE_TRUST_INVALID')
  expect(() =>
    createRetirementEvidenceVerifier({
      objectStore: fixture.objectStore,
      trustedAttesters: [{ keyId: ATTESTOR, publicKey: attestorPublicKey }],
      maxArtifactBytes: 0,
    })
  ).toThrow('RETIREMENT_EVIDENCE_LIMIT_INVALID')
})

test('is deterministic across repeated calls and never reads the wall clock', async () => {
  const fixture = await createFixture()
  const input = await verifiedGateInput(fixture)
  const first = evaluateRetirementGate(input)
  const second = evaluateRetirementGate(input)
  expect(JSON.stringify(second)).toBe(JSON.stringify(first))

  // The same evidence flips to blocked exactly when the supplied clock crosses
  // the configured bound — staleness is a function of the input, not of when
  // the gate runs.
  const later = evaluateRetirementGate({ ...input, now: '2026-11-15T00:00:00.000Z' })
  expect(later.verdict).toBe('blocked')
  expect(later.evidence.parity.status).toBe('stale')
  expect(later.evaluatedAt).toBe('2026-11-15T00:00:00.000Z')
})

test('the freshness bound widens only by an explicit input, never by default', async () => {
  const fixture = await createFixture()
  const parity = await storeEvidence(fixture, {
    content: { attestedAt: STALE_ATTESTED_AT },
    handle: {
      attestation: { attestedBy: ATTESTOR, attestedAt: STALE_ATTESTED_AT, complete: true },
    },
  })
  const verified = await verifiedInput(fixture, 'parity', parity)
  expect(verified.verified).toBe(true)
  const base = { ...gateInput({ parityEvidence: parity }), parityVerification: verified.fact }
  expect(evaluateRetirementGate(base).evidence.parity.status).toBe('stale')
  const widened = evaluateRetirementGate({
    ...base,
    maxEvidenceAgeSeconds: DEFAULT_MAX_EVIDENCE_AGE_SECONDS * 2,
  })
  expect(widened.evidence.parity.status).toBe('valid')
})

test('rejects malformed gate requests instead of deciding them', () => {
  expect(() => evaluateRetirementGate({ ...gateInput(), now: undefined })).toThrow()
  expect(() => evaluateRetirementGate({ ...gateInput(), layerId: '' })).toThrow()
  expect(() => evaluateRetirementGate(gateInput({ extra: true }))).toThrow()
})
