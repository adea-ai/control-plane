import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'
import { PostgresLegacyDrainFenceRepository } from './legacy-drain-fence-repository.ts'

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
})
