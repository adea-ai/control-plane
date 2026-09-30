import { expect, test } from 'bun:test'
import {
  GraphDefinitionCatalog,
  InMemoryGraphDefinitionRepository,
  PublishedGraphDefinitionSchema,
} from './graph-catalog.ts'
import * as graphCatalog from './graph-catalog.ts'
const { graphDefinitionUpdateIsValid } = graphCatalog

async function published() {
  return new GraphDefinitionCatalog(new InMemoryGraphDefinitionRepository()).publish({
    publishedAt: '2026-09-30T00:00:00.000Z',
    definition: {
      graphDefinitionId: 'graph:catalog',
      graphVersion: '1.0.0',
      schemaVersion: 1,
      nodes: [{ node: 'run', operation: { kind: 'runtime', name: 'execute' } }],
      edges: [
        { from: '__start__', to: 'run' },
        { from: 'run', to: '__end__' },
      ],
      schemas: { input: 'input:v1', state: 'state:v1', output: 'output:v1' },
      requiredCapabilities: [],
      compatibility: {
        contractMajorVersions: [1],
        compilerVersions: ['1.0.0'],
        adapterVersions: ['1.4.12'],
      },
    },
  })
}

test('graph catalog repositories permit only monotonic immutable lifecycle updates', async () => {
  const current = await published()
  const next = {
    ...current,
    revision: 2,
    lifecycle: 'deprecated',
    changedAt: '2026-09-30T01:00:00.000Z',
    reason: 'replacement',
  }
  expect(graphDefinitionUpdateIsValid(current, next, 1)).toBe(true)
  for (const invalid of [
    { ...next, revision: 1 },
    { ...next, revision: 3 },
    { ...next, lifecycle: 'published' },
    { ...next, changedAt: '2026-09-29T00:00:00.000Z' },
    { ...next, publishedAt: '2026-09-29T00:00:00.000Z' },
    { ...next, reference: { ...next.reference, contentDigest: `sha256:${'a'.repeat(64)}` } },
    { ...next, content: { ...next.content, requiredCapabilities: ['runtime.invoke'] } },
  ]) {
    expect(graphDefinitionUpdateIsValid(current, invalid, 1)).toBe(false)
  }
  expect(graphDefinitionUpdateIsValid(current, next, 0)).toBe(false)
  expect(graphDefinitionUpdateIsValid(current, next, 2)).toBe(false)
  const revoked = { ...next, revision: 3, lifecycle: 'revoked', reason: 'unsafe' }
  expect(graphDefinitionUpdateIsValid(next, revoked, 2)).toBe(true)
  expect(graphDefinitionUpdateIsValid(revoked, { ...next, revision: 4 }, 3)).toBe(false)
})

test('in-memory graph repository rejects invalid direct CAS writes without changing pinned content', async () => {
  const repository = new InMemoryGraphDefinitionRepository()
  const current = await published()
  await repository.insert(current)
  const skipped = { ...current, revision: 3, lifecycle: 'revoked', reason: 'unsafe' }
  expect(await repository.compareAndSet(1, skipped)).toBe(false)
  expect(await repository.get(current.reference.graphDefinitionId, '1.0.0')).toEqual(current)
})

test('rejects definitions whose change timestamp predates publication before insertion', async () => {
  const repository = new InMemoryGraphDefinitionRepository()
  const current = await published()
  const invalid = { ...current, changedAt: '2026-09-29T00:00:00.000Z' }
  expect(PublishedGraphDefinitionSchema.safeParse(invalid).success).toBe(false)
  await expect(repository.insert(invalid)).rejects.toThrow()
  expect(await repository.get(current.reference.graphDefinitionId, '1.0.0')).toBeUndefined()
})

test('rejects unsafe revisions at insertion and prevents lifecycle revision overflow', async () => {
  const repository = new InMemoryGraphDefinitionRepository()
  const current = await published()
  const unsafe = { ...current, revision: Number.MAX_SAFE_INTEGER + 1 }
  expect(PublishedGraphDefinitionSchema.safeParse(unsafe).success).toBe(false)
  await expect(repository.insert(unsafe)).rejects.toThrow()
  expect(await repository.get(current.reference.graphDefinitionId, '1.0.0')).toBeUndefined()
  const lastSafe = { ...current, revision: Number.MAX_SAFE_INTEGER }
  const overflow = { ...unsafe, lifecycle: 'revoked', reason: 'unsafe' }
  expect(graphDefinitionUpdateIsValid(lastSafe, overflow, Number.MAX_SAFE_INTEGER)).toBe(false)
})
