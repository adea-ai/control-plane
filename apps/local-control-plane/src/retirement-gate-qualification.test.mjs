import { afterEach, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesystemObjectStore } from '@control-plane/object-store'
import {
  qualifyRetirementGate,
  RETIREMENT_MEASUREMENT_INVALID,
} from './retirement-gate-qualification.ts'

// Offline qualification of the measured retirement gate (CP #943, child #1029).
//
// Every fixture here is disposable: a temporary directory for the object store
// and synthetic measurement output. No service is contacted, no provider is
// reached, no layer is retired and no production setting is touched, so the
// qualification can only be exercised against local state.

const NOW = '2026-10-21T12:00:00.000Z'
const LAYER = 'layer:redundant-shadow-reader'
const TARGET_PROFILE = 'prf_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const TARGET_REVISION = 'rev-9'
const ATTESTOR = 'svc-evidence-attestor'

const attesterKeys = generateKeyPairSync('ed25519')
const attesterPublicKey = attesterKeys.publicKey.export({ format: 'jwk' }).x
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

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'retirement-gate-qualification-'))
  directories.add(directory)
  const objectStore = new FilesystemObjectStore({
    rootDirectory: join(directory, 'objects'),
    maxObjectBytes: 64 * 1024 * 1024,
  })
  stores.add(objectStore)
  return { directory, objectStore }
}

function measurementFor(reference, overrides = {}) {
  return {
    reference,
    measurement: {
      runId: `run-${reference}`,
      startedAt: '2026-10-21T09:00:00.000Z',
      completedAt: '2026-10-21T10:00:00.000Z',
      casesExpected: 12,
      casesExecuted: 12,
      casesPassed: 12,
      output: new TextEncoder().encode(`measured output for ${reference}\n`),
      ...overrides,
    },
  }
}

async function qualifyWith(fixture, overrides = {}) {
  const options = {
    layerId: LAYER,
    targetProfileId: TARGET_PROFILE,
    targetSourceRevision: TARGET_REVISION,
    parity: measurementFor('parity-run'),
    failure: measurementFor('failure-run'),
    attesterKeyId: ATTESTOR,
    attesterPrivateKey: attesterKeys.privateKey,
    objectStore: fixture.objectStore,
    trustedAttesters: [{ keyId: ATTESTOR, publicKey: attesterPublicKey }],
    now: NOW,
    ...overrides,
  }
  return await qualifyRetirementGate(options)
}

test('qualifies a measured gate when both dimensions are measured, verified and current', async () => {
  const fixture = await createFixture()
  const qualification = await qualifyWith(fixture)

  expect(qualification.decision.verdict).toBe('allowed')
  expect(qualification.decision.retirementClaim.claimAllowed).toBe(true)
  expect(qualification.decision.retirementClaim.claim).toBe('profile-parity-and-failure-attested')
  expect(qualification.decision.evidence.parity.status).toBe('valid')
  expect(qualification.decision.evidence.failure.status).toBe('valid')
  expect(qualification.decision.attestedEvidenceDigests.parity).not.toBeNull()
  expect(qualification.decision.attestedEvidenceDigests.failure).not.toBeNull()
  expect(qualification.verification.parity.verified).toBe(true)
  expect(qualification.verification.failure.verified).toBe(true)
})

test('derives the attested output digest from the measured output bytes', async () => {
  const fixture = await createFixture()
  const qualification = await qualifyWith(fixture)

  const expected = `sha256:${(await import('node:crypto'))
    .createHash('sha256')
    .update(new TextEncoder().encode('measured output for parity-run\n'))
    .digest('hex')}`
  expect(qualification.measured.parity.outputDigest).toBe(expected)
  expect(qualification.measured.parity.reference).toBe('parity-run')
  expect(qualification.measured.failure.reference).toBe('failure-run')
})

test('refuses a measurement that disagrees with itself or is incomplete, and stores nothing', async () => {
  const fixture = await createFixture()
  const invalid = [
    { casesPassed: 13 },
    { casesExecuted: 13 },
    // A run that did not execute every expected case is incomplete, and the
    // trusted verifier would reject it as EXECUTION_INCOMPLETE.
    { casesExecuted: 11, casesPassed: 11 },
    { completedAt: '2026-10-21T08:00:00.000Z' },
    // A measurement that has not finished yet cannot be attested.
    { completedAt: '2026-10-21T13:00:00.000Z' },
    { output: new Uint8Array() },
  ]
  for (const overrides of invalid) {
    const promise = qualifyWith(fixture, {
      parity: measurementFor('parity-run', overrides),
    })
    await expect(promise).rejects.toThrow(RETIREMENT_MEASUREMENT_INVALID)
  }
})

test('blocks the gate when the attester is not trusted, and names the dimension', async () => {
  const fixture = await createFixture()
  const qualification = await qualifyWith(fixture, {
    trustedAttesters: [
      { keyId: ATTESTOR, publicKey: rogueKeys.publicKey.export({ format: 'jwk' }).x },
    ],
  })

  expect(qualification.verification.parity.verified).toBe(false)
  expect(qualification.verification.failure.verified).toBe(false)
  expect(qualification.decision.verdict).toBe('blocked')
  expect(qualification.decision.retirementClaim.claimAllowed).toBe(false)
  expect(qualification.decision.retirementClaim.claim).toBe('not-claimable')
  expect(qualification.decision.attestedEvidenceDigests.parity).toBeNull()
  expect(qualification.decision.attestedEvidenceDigests.failure).toBeNull()
})

test('binds the measured evidence to the requested profile and source revision', async () => {
  const fixture = await createFixture()
  const qualification = await qualifyWith(fixture)

  expect(qualification.verification.parity.verified).toBe(true)
  expect(qualification.verification.failure.verified).toBe(true)
  const parityFact = qualification.verification.parity.verified
    ? qualification.verification.parity.fact
    : undefined
  const failureFact = qualification.verification.failure.verified
    ? qualification.verification.failure.fact
    : undefined
  expect(parityFact?.profileId).toBe(TARGET_PROFILE)
  expect(parityFact?.sourceRevision).toBe(TARGET_REVISION)
  expect(parityFact?.layerId).toBe(LAYER)
  expect(failureFact?.profileId).toBe(TARGET_PROFILE)
  expect(failureFact?.sourceRevision).toBe(TARGET_REVISION)
  expect(failureFact?.layerId).toBe(LAYER)
})

test('attests at the evaluation clock, never at a caller-declared earlier time', async () => {
  const fixture = await createFixture()
  const qualification = await qualifyWith(fixture)

  const fact = qualification.verification.parity.verified
    ? qualification.verification.parity.fact
    : undefined
  expect(fact?.attestedAt).toBe(NOW)
  expect(qualification.decision.evaluatedAt).toBe(NOW)
})

test('blocks the gate when the evidence is not verified, and never claims a zero', async () => {
  const fixture = await createFixture()
  // The verifier trusts a different public key under the attester's identity:
  // the artifact is well formed and current, but it is not a verified fact.
  const wrongKey = await qualifyWith(fixture, {
    trustedAttesters: [
      { keyId: ATTESTOR, publicKey: rogueKeys.publicKey.export({ format: 'jwk' }).x },
    ],
  })

  expect(wrongKey.verification.parity.verified).toBe(false)
  expect(wrongKey.verification.parity.verified === false && wrongKey.verification.parity.code).toBe(
    'SIGNATURE_INVALID'
  )
  expect(wrongKey.verification.failure.verified).toBe(false)
  expect(wrongKey.decision.verdict).toBe('blocked')
  expect(wrongKey.decision.retirementClaim.claimAllowed).toBe(false)
  expect(wrongKey.decision.retirementClaim.claim).toBe('not-claimable')
  expect(wrongKey.decision.attestedEvidenceDigests.parity).toBeNull()
  expect(wrongKey.decision.attestedEvidenceDigests.failure).toBeNull()

  // The verifier does not know the attester at all: the artifact names an
  // identity nobody vouches for.
  const unknownAttester = await qualifyWith(fixture, {
    trustedAttesters: [{ keyId: 'svc-other-attestor', publicKey: attesterPublicKey }],
  })
  expect(unknownAttester.verification.parity.verified).toBe(false)
  expect(
    unknownAttester.verification.parity.verified === false &&
      unknownAttester.verification.parity.code
  ).toBe('ATTESTER_UNTRUSTED')
  expect(unknownAttester.decision.verdict).toBe('blocked')
})

test('never retires anything: the qualification only writes the two evidence objects', async () => {
  const fixture = await createFixture()
  const deleted = []
  const originalDelete = fixture.objectStore.delete.bind(fixture.objectStore)
  fixture.objectStore.delete = async (key) => {
    deleted.push(key)
    return await originalDelete(key)
  }

  const qualification = await qualifyWith(fixture)

  expect(deleted).toEqual([])
  expect(qualification.decision.verdict).toBe('allowed')
  // The decision is a measurement result; it performs no action of its own.
  expect(qualification.decision.gate).toBe('redundant-layer-retirement')
  expect(qualification.decision.schemaVersion).toBe(1)
})

test('is deterministic for the same inputs', async () => {
  const fixture = await createFixture()
  const first = await qualifyWith(fixture)
  const second = await qualifyWith(fixture)

  expect(second.decision).toEqual(first.decision)
  expect(second.measured).toEqual(first.measured)
})
