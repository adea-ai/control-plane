import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  InMemoryStatePromotionProposalRepository,
  ProjectStateService,
  RecordingProjectStateEventPublisher,
} from '@control-plane/domain'
import { SqlitePersistenceProvider, SqliteProjectStateRepository } from './index.ts'
import { recordId } from './record-storage.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const projectId = 'prj_01JABCDEF0123456789ABCDEFG'
const now = '2026-08-23T12:00:00.000Z'
const later = '2026-08-23T13:00:00.000Z'

describe('SQLite ProjectState digest reopen and race', () => {
  test('a versioned mutation survives a reopen without duplicating state, event or revision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'project-state-digest-'))
    const path = join(directory, 'control-plane.sqlite')
    try {
      const first = new SqlitePersistenceProvider({ path })
      await first.migrate()
      const repository = new SqliteProjectStateRepository(first)
      const service = serviceFor(repository)
      await service.initialize({ workspaceId, projectId, at: now })
      const input = mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
        appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', { 'a-b': 1, a_b: 2 }),
      ])
      const written = await service.applyMutation(input, { digestVersion: 2 })
      expect(written.applied).toBe(true)
      await first.close()

      // Reopening reads the persisted record, not an in-memory cache.
      const reopened = new SqlitePersistenceProvider({ path })
      await reopened.migrate()
      const reopenedRepository = new SqliteProjectStateRepository(reopened)
      const reopenedService = serviceFor(reopenedRepository)
      const stored = await reopenedRepository.getMutation(workspaceId, projectId, input.mutationId)
      expect(stored.inputDigestVersion).toBe(2)

      // The replay resolves through the record's own version, and adds nothing.
      const replay = await reopenedService.applyMutation(input)
      expect(replay.applied).toBe(false)
      expect(replay.state.revision).toBe(1)
      expect(await reopenedRepository.getHistory(workspaceId, projectId)).toHaveLength(2)
      expect((await reopenedRepository.get(workspaceId, projectId)).revision).toBe(1)

      const counts = await reopened.transaction(async (transaction) => ({
        states: (await transaction.list('project-states')).length,
        history: (await transaction.list('project-state-history')).length,
        mutations: (await transaction.list('project-state-mutations')).length,
        updates: (await transaction.list('project-state-updates')).length,
      }))
      expect(counts).toEqual({ states: 1, history: 2, mutations: 1, updates: 1 })
      const updates = await reopened.transaction(async (transaction) =>
        transaction.list('project-state-updates')
      )
      expect(updates.map((record) => record.value)).toEqual([
        expect.objectContaining({
          revision: 1,
          mutationId: input.mutationId,
          inputDigestVersion: 2,
        }),
      ])
      await reopened.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('an untagged mutation keeps the record and the event payload it always wrote', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'project-state-digest-'))
    const path = join(directory, 'control-plane.sqlite')
    try {
      const provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      const repository = new SqliteProjectStateRepository(provider)
      const service = serviceFor(repository)
      await service.initialize({ workspaceId, projectId, at: now })
      const input = mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
        appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
      ])
      await service.applyMutation(input)
      const stored = await repository.getMutation(workspaceId, projectId, input.mutationId)
      expect(stored.inputDigestVersion).toBeUndefined()
      const updates = await provider.transaction(async (transaction) =>
        transaction.list('project-state-updates')
      )
      expect(updates.map((record) => record.value)).toEqual([
        {
          workspaceId,
          projectId,
          previousRevision: 0,
          revision: 1,
          mutationId: input.mutationId,
          inputDigest: stored.inputDigest,
          touchedItemIds: ['psi_01JABCDEF0123456789ABCDEFG'],
        },
      ])
      await provider.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('a compare-and-set loser resolves the winner record exactly like an ordinary replay', async () => {
    await withProvider(async (provider) => {
      const repository = new SqliteProjectStateRepository(provider)
      const service = serviceFor(repository)
      await service.initialize({ workspaceId, projectId, at: now })
      const input = mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
        appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
      ])

      // The first attempt loses the revision race to a writer that used the same mutation
      // id, so the service has to resolve the winner's record instead of writing one.
      const originalCompareAndSet = repository.compareAndSet.bind(repository)
      let lost = false
      repository.compareAndSet = async (expectedRevision, state, record) => {
        if (!lost) {
          lost = true
          await originalCompareAndSet(expectedRevision, state, record)
          return false
        }
        return originalCompareAndSet(expectedRevision, state, record)
      }

      const loser = await service.applyMutation(input, { digestVersion: 2 })
      expect(loser.applied).toBe(false)
      expect(loser.state.revision).toBe(1)

      // The ordinary replay of the same record agrees with the loser.
      const replay = await service.applyMutation(input)
      expect(replay.applied).toBe(false)
      expect(replay.state.revision).toBe(1)

      const counts = await provider.transaction(async (transaction) => ({
        history: (await transaction.list('project-state-history')).length,
        mutations: (await transaction.list('project-state-mutations')).length,
        updates: (await transaction.list('project-state-updates')).length,
      }))
      expect(counts).toEqual({ history: 2, mutations: 1, updates: 1 })
    })
  })

  test('concurrent writers of one mutation id produce one revision and one event', async () => {
    await withProvider(async (provider) => {
      const repository = new SqliteProjectStateRepository(provider)
      const service = serviceFor(repository)
      await service.initialize({ workspaceId, projectId, at: now })
      const input = mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
        appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
      ])
      const attempts = await Promise.all([
        service.applyMutation(input, { digestVersion: 2 }),
        service.applyMutation(input, { digestVersion: 2 }),
      ])
      expect(attempts.map((attempt) => attempt.applied).toSorted()).toEqual([false, true])
      expect(attempts.map((attempt) => attempt.state.revision)).toEqual([1, 1])
      const counts = await provider.transaction(async (transaction) => ({
        history: (await transaction.list('project-state-history')).length,
        mutations: (await transaction.list('project-state-mutations')).length,
        updates: (await transaction.list('project-state-updates')).length,
      }))
      expect(counts).toEqual({ history: 2, mutations: 1, updates: 1 })
    })
  })

  test('a record carrying an unsupported version is refused instead of replayed', async () => {
    await withProvider(async (provider) => {
      const repository = new SqliteProjectStateRepository(provider)
      const service = serviceFor(repository)
      await service.initialize({ workspaceId, projectId, at: now })
      const input = mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
        appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
      ])
      const originalCompareAndSet = repository.compareAndSet.bind(repository)
      repository.compareAndSet = async (expectedRevision, state, record) =>
        originalCompareAndSet(expectedRevision, state, { ...record, inputDigestVersion: 3 })
      await service.applyMutation(input)
      await expect(service.applyMutation(input)).rejects.toMatchObject({
        code: 'MUTATION_DIGEST_VERSION_UNSUPPORTED',
      })
    })
  })

  test('a record carrying a malformed version is refused at the read boundary', async () => {
    await withProvider(async (provider) => {
      const repository = new SqliteProjectStateRepository(provider)
      const service = serviceFor(repository)
      await service.initialize({ workspaceId, projectId, at: now })
      const input = mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
        appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
      ])
      await service.applyMutation(input)
      const stored = await repository.getMutation(workspaceId, projectId, input.mutationId)

      // A record whose version is not an integer is malformed. The reader refuses it
      // instead of guessing a canonicalization for it.
      const malformedId = 'stm_01JBBCDEF0123456789ABCDEFG'
      await provider.transaction((transaction) =>
        transaction.put({
          namespace: 'project-state-mutations',
          id: recordId(`${workspaceId}\u001f${projectId}\u001f${malformedId}`),
          value: { ...stored, mutationId: malformedId, inputDigestVersion: '2' },
        })
      )
      await expect(repository.getMutation(workspaceId, projectId, malformedId)).rejects.toThrow()
      await expect(
        service.applyMutation(
          mutation(malformedId, 0, [
            appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
          ])
        )
      ).rejects.toThrow()
    })
  })

  test('an altered input is refused for a versioned record', async () => {
    await withProvider(async (provider) => {
      const repository = new SqliteProjectStateRepository(provider)
      const service = serviceFor(repository)
      await service.initialize({ workspaceId, projectId, at: now })
      const input = mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
        appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
      ])
      await service.applyMutation(input, { digestVersion: 2 })
      const altered = mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
        appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M3'),
      ])
      await expect(service.applyMutation(altered)).rejects.toMatchObject({
        code: 'MUTATION_ID_REUSED',
      })
      const counts = await provider.transaction(async (transaction) => ({
        history: (await transaction.list('project-state-history')).length,
        mutations: (await transaction.list('project-state-mutations')).length,
        updates: (await transaction.list('project-state-updates')).length,
      }))
      expect(counts).toEqual({ history: 2, mutations: 1, updates: 1 })
    })
  })
})

async function withProvider(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'project-state-digest-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'control-plane.sqlite') })
  try {
    await provider.migrate()
    await callback(provider)
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

function serviceFor(repository) {
  return new ProjectStateService(
    repository,
    new InMemoryStatePromotionProposalRepository(),
    new RecordingProjectStateEventPublisher()
  )
}

function mutation(mutationId, expectedRevision, operations) {
  return {
    mutationId,
    workspaceId,
    projectId,
    expectedRevision,
    actorPrincipalRef: 'principal://agent-hq/user/42',
    operations,
    at: later,
  }
}

function appendItem(itemId, key, value) {
  return {
    kind: 'append',
    item: {
      itemId,
      key,
      value,
      sensitivity: 'internal',
      freshness: { observedAt: now },
      provenance: {
        sourceKind: 'principal',
        sourcePrincipalRef: 'principal://agent-hq/user/42',
        artifactRefs: [],
        capturedAt: now,
      },
    },
  }
}
