import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import process from 'node:process'
import { eq } from 'drizzle-orm'
import { loadDatabaseCredentials } from '@control-plane/config'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'
import { PostgresLegacyDrainFenceRepository } from './legacy-drain-fence-repository.ts'
import { langgraphLegacyDrainFences } from './schema/langgraph-legacy-drain-fences.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
const threadOne = `${workspaceId}:${executionId}:thread-legacy-1`
const threadTwo = `${workspaceId}:${executionId}:thread-legacy-2`
const threadThree = `${workspaceId}:${executionId}:thread-legacy-3`

async function isolatedDatabase() {
  const isolated = await createIsolatedTestDatabase({
    administration: loadDatabaseCredentials(process.env, 'administration'),
    application: loadDatabaseCredentials(process.env, 'application'),
    migration: loadDatabaseCredentials(process.env, 'migration'),
  })
  await isolated.migrate()
  return isolated
}

describe.skipIf(!enabled)('hosted legacy drain fence in PostgreSQL', () => {
  let isolated
  let fences

  beforeAll(async () => {
    isolated = await isolatedDatabase()
    fences = new PostgresLegacyDrainFenceRepository(isolated.application)
  }, integrationTestTimeout(60_000))

  afterAll(async () => {
    await isolated?.dispose()
  })

  test('two owners cannot both hold a thread, and only the exact holder releases it', async () => {
    const a = await fences.claim({ storageThreadId: threadOne, owner: 'owner-a' })
    expect(a).toEqual({ storageThreadId: threadOne, owner: 'owner-a', generation: 1, revision: 1 })
    await expect(
      fences.claim({ storageThreadId: threadOne, owner: 'owner-b' })
    ).rejects.toMatchObject({
      code: 'LEGACY_DRAIN_FENCE_HELD',
    })
    await expect(fences.assertResumeAllowed(threadOne)).rejects.toMatchObject({
      code: 'LEGACY_DRAIN_FENCE_HELD',
    })
    await expect(fences.release({ ...a, owner: 'owner-b' })).rejects.toMatchObject({
      code: 'LEGACY_DRAIN_FENCE_NOT_OWNED',
    })
    // The refused release by the other owner changed nothing: the fence still refuses resume.
    await expect(fences.assertResumeAllowed(threadOne)).rejects.toMatchObject({
      code: 'LEGACY_DRAIN_FENCE_HELD',
    })
    // Same-owner re-claim while held is idempotent: the held handle comes back.
    expect(await fences.claim({ storageThreadId: threadOne, owner: 'owner-a' })).toEqual(a)
    expect(await fences.release(a)).toBe(true)
    expect(await fences.release(a)).toBe(false)
    await expect(fences.assertResumeAllowed(threadOne)).resolves.toBeUndefined()

    const b = await fences.claim({ storageThreadId: threadOne, owner: 'owner-b' })
    expect(b).toEqual({ storageThreadId: threadOne, owner: 'owner-b', generation: 2, revision: 3 })
    // A's released handle is refused while B holds the thread, and B's fence stays in place.
    await expect(fences.release(a)).rejects.toMatchObject({ code: 'LEGACY_DRAIN_FENCE_NOT_OWNED' })
    await expect(fences.assertResumeAllowed(threadOne)).rejects.toMatchObject({
      code: 'LEGACY_DRAIN_FENCE_HELD',
    })
    expect(await fences.release(b)).toBe(true)
  })

  test('a stale handle from an earlier claim cannot release a later claim by the same owner', async () => {
    const first = await fences.claim({ storageThreadId: threadTwo, owner: 'owner-a' })
    expect(await fences.release(first)).toBe(true)
    const second = await fences.claim({ storageThreadId: threadTwo, owner: 'owner-a' })
    expect(second.generation).toBe(first.generation + 1)
    await expect(fences.release(first)).rejects.toMatchObject({ code: 'LEGACY_DRAIN_FENCE_STALE' })
    await expect(fences.assertResumeAllowed(threadTwo)).rejects.toMatchObject({
      code: 'LEGACY_DRAIN_FENCE_HELD',
    })
    expect(await fences.release(second)).toBe(true)
  })

  test('concurrent claims for one thread admit exactly one owner', async () => {
    const results = await Promise.allSettled([
      fences.claim({ storageThreadId: threadThree, owner: 'owner-a' }),
      fences.claim({ storageThreadId: threadThree, owner: 'owner-b' }),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason.code).toBe('LEGACY_DRAIN_FENCE_HELD')
  })

  test(
    'a fence store that cannot be read refuses resume',
    async () => {
      const unavailable = await isolatedDatabase()
      const repository = new PostgresLegacyDrainFenceRepository(unavailable.application)
      await unavailable.dispose()
      await expect(repository.assertResumeAllowed(threadOne)).rejects.toBeInstanceOf(Error)
    },
    integrationTestTimeout(60_000)
  )

  describe('counter exhaustion refuses before any write', () => {
    const maximum = Number.MAX_SAFE_INTEGER
    const boundaryThread = (name) => `${workspaceId}:${executionId}:boundary-${name}`
    const seed = (storageThreadId, generation, revision) =>
      isolated.application.insert(langgraphLegacyDrainFences).values({
        storageThreadId,
        owner: null,
        generation,
        revision,
        updatedAt: new Date('2026-10-10T00:00:00.000Z'),
      })
    const rowOf = async (storageThreadId) => {
      const [row] = await isolated.application
        .select()
        .from(langgraphLegacyDrainFences)
        .where(eq(langgraphLegacyDrainFences.storageThreadId, storageThreadId))
      return row
    }

    test('the last generation a release can hand back is released, and the claim after it is refused before any write', async () => {
      const thread = boundaryThread('generation')
      await seed(thread, maximum - 2, 1)
      const issued = await fences.claim({ storageThreadId: thread, owner: 'owner-a' })
      expect(issued).toEqual({
        storageThreadId: thread,
        owner: 'owner-a',
        generation: maximum - 1,
        revision: 2,
      })
      expect(await fences.release(issued)).toBe(true)
      const stored = await rowOf(thread)
      expect(stored).toMatchObject({ owner: null, generation: maximum - 1, revision: 3 })
      await expect(
        fences.claim({ storageThreadId: thread, owner: 'owner-b' })
      ).rejects.toMatchObject({ code: 'LEGACY_DRAIN_FENCE_STATE_INVALID' })
      expect(await rowOf(thread)).toEqual(stored)
    })

    test('a revision at the last issuable value releases to the stored maximum, and the claim after it is refused before any write', async () => {
      const thread = boundaryThread('revision')
      await seed(thread, 1, maximum - 2)
      const issued = await fences.claim({ storageThreadId: thread, owner: 'owner-a' })
      expect(issued).toEqual({
        storageThreadId: thread,
        owner: 'owner-a',
        generation: 2,
        revision: maximum - 1,
      })
      expect(await fences.release(issued)).toBe(true)
      const stored = await rowOf(thread)
      expect(stored).toMatchObject({ owner: null, generation: 2, revision: maximum })
      await expect(
        fences.claim({ storageThreadId: thread, owner: 'owner-b' })
      ).rejects.toMatchObject({ code: 'LEGACY_DRAIN_FENCE_STATE_INVALID' })
      expect(await rowOf(thread)).toEqual(stored)
    })

    test('a claim whose generation or revision would reach the safe-integer maximum is refused before any write', async () => {
      const generationThread = boundaryThread('generation-at-maximum')
      await seed(generationThread, maximum - 1, 1)
      const beforeGeneration = await rowOf(generationThread)
      await expect(
        fences.claim({ storageThreadId: generationThread, owner: 'owner-a' })
      ).rejects.toMatchObject({ code: 'LEGACY_DRAIN_FENCE_STATE_INVALID' })
      expect(await rowOf(generationThread)).toEqual(beforeGeneration)

      const revisionThread = boundaryThread('revision-at-maximum')
      await seed(revisionThread, 1, maximum - 1)
      const beforeRevision = await rowOf(revisionThread)
      await expect(
        fences.claim({ storageThreadId: revisionThread, owner: 'owner-a' })
      ).rejects.toMatchObject({ code: 'LEGACY_DRAIN_FENCE_STATE_INVALID' })
      expect(await rowOf(revisionThread)).toEqual(beforeRevision)
    })

    test('a release refuses a handle outside the counter domain and leaves the held claim in place', async () => {
      const thread = boundaryThread('handle-domain')
      const held = await fences.claim({ storageThreadId: thread, owner: 'owner-a' })
      const before = await rowOf(thread)
      await expect(fences.release({ ...held, generation: maximum })).rejects.toMatchObject({
        code: 'LEGACY_FENCE_INVALID',
      })
      await expect(fences.release({ ...held, revision: maximum })).rejects.toMatchObject({
        code: 'LEGACY_FENCE_INVALID',
      })
      expect(await rowOf(thread)).toEqual(before)
      expect(await fences.release(held)).toBe(true)
    })
  })
})
