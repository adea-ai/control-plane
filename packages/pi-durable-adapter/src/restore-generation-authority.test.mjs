import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import {
  PiRestoreGenerationEvidenceReader,
  PiRestoreGenerationSnapshotSchema,
  UnavailablePiRestoreGenerationAuthority,
} from './restore-generation-authority.ts'

const expected = () => ({ lineageId: 'lineage-1', restoreGeneration: 'generation-2', revision: 2 })
const snapshot = () => ({ ...expected(), state: 'open' })
const reader = (value) => new PiRestoreGenerationEvidenceReader({ readCurrent: async () => value })

test('missing independent authority defaults unavailable, even with matching caller pins', async () => {
  await expect(new PiRestoreGenerationEvidenceReader().readCurrent(expected())).rejects.toThrow(
    'PI_RESTORE_GENERATION_AUTHORITY_UNAVAILABLE'
  )
  await expect(
    new UnavailablePiRestoreGenerationAuthority().readCurrent('lineage-1')
  ).rejects.toThrow('PI_RESTORE_GENERATION_AUTHORITY_UNAVAILABLE')
})

test('an independent open snapshot is cloned and read for exactly the expected lineage', async () => {
  const current = snapshot()
  const calls = []
  const evidence = new PiRestoreGenerationEvidenceReader({
    readCurrent: async (lineageId) => {
      calls.push(lineageId)
      return current
    },
  })
  const result = await evidence.readCurrent(expected())
  expect(calls).toEqual(['lineage-1'])
  expect(result).toEqual(current)
  expect(result).not.toBe(current)
  current.restoreGeneration = 'generation-3'
  expect(result.restoreGeneration).toBe('generation-2')
  result.revision = 999
  expect(current.revision).toBe(2)
})

for (const [name, change] of [
  ['lineage', { lineageId: 'another-lineage' }],
  ['generation', { restoreGeneration: 'generation-3' }],
  ['revision', { revision: 3 }],
  ['stale revision', { revision: 1 }],
  ['stale generation', { restoreGeneration: 'generation-1' }],
  ['closing', { state: 'closing' }],
]) {
  test(`independent ${name} mismatch fails closed`, async () => {
    await expect(reader({ ...snapshot(), ...change }).readCurrent(expected())).rejects.toThrow(
      'PI_RESTORE_GENERATION_EVIDENCE_CONFLICT'
    )
  })
}

for (const [name, value] of [
  ['missing', undefined],
  ['null', null],
  ['ambiguous', [snapshot(), snapshot()]],
  ['unknown field', { ...snapshot(), authority: true }],
  ['unknown state', { ...snapshot(), state: 'unknown' }],
  ['unsafe revision', { ...snapshot(), revision: Number.MAX_SAFE_INTEGER + 1 }],
  ['negative revision', { ...snapshot(), revision: -1 }],
  ['fractional revision', { ...snapshot(), revision: 1.5 }],
  ['blank lineage', { ...snapshot(), lineageId: ' ' }],
]) {
  test(`malformed ${name} authority response fails closed`, async () => {
    await expect(reader(value).readCurrent(expected())).rejects.toThrow(
      'PI_RESTORE_GENERATION_AUTHORITY_INVALID'
    )
  })
}

test('unavailable independent authority never falls back to caller state', async () => {
  const failure = new Error('independent authority offline')
  const evidence = new PiRestoreGenerationEvidenceReader({
    readCurrent: async () => {
      throw failure
    },
  })
  await expect(evidence.readCurrent(expected())).rejects.toBe(failure)
})

test('unknown or malformed expected pins are rejected before authority access', async () => {
  let calls = 0
  const evidence = new PiRestoreGenerationEvidenceReader({
    readCurrent: async () => {
      calls++
      return snapshot()
    },
  })
  for (const pins of [
    { ...expected(), state: 'open' },
    { ...expected(), revision: -1 },
  ]) {
    await expect(evidence.readCurrent(pins)).rejects.toThrow()
  }
  expect(calls).toBe(0)
})

test('whole rollback with a recomputed matching local digest cannot establish current generation', async () => {
  // Controlled independent fake: unlike restored local records, it retains generation 2.
  const restored = { lineageId: 'lineage-1', restoreGeneration: 'generation-1', revision: 1 }
  const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const restoredRecord = { pins: restored, digest: digest(restored) }
  expect(digest(restoredRecord.pins)).toBe(restoredRecord.digest)
  expect(PiRestoreGenerationSnapshotSchema.safeParse({ ...restored, state: 'open' }).success).toBe(
    true
  )
  await expect(reader(snapshot()).readCurrent(restoredRecord.pins)).rejects.toThrow(
    'PI_RESTORE_GENERATION_EVIDENCE_CONFLICT'
  )
})

test('evidence is only a read snapshot: a later authority change is detected on another read', async () => {
  const current = snapshot()
  const evidence = reader(current)
  await evidence.readCurrent(expected())
  current.state = 'closing'
  await expect(evidence.readCurrent(expected())).rejects.toThrow(
    'PI_RESTORE_GENERATION_EVIDENCE_CONFLICT'
  )
})

test('caller mutation during an independent read cannot replace the original expected pins', async () => {
  let resolve
  const pending = new Promise((done) => {
    resolve = done
  })
  const pins = expected()
  const evidence = new PiRestoreGenerationEvidenceReader({ readCurrent: async () => pending })
  const result = evidence.readCurrent(pins)
  pins.restoreGeneration = 'generation-3'
  pins.revision = 3
  resolve({ ...snapshot(), restoreGeneration: 'generation-3', revision: 3 })
  await expect(result).rejects.toThrow('PI_RESTORE_GENERATION_EVIDENCE_CONFLICT')
})
