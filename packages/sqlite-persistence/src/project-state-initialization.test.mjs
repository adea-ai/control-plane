import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  InMemoryProjectStateRepository,
  ProjectStateService,
  InMemoryStatePromotionProposalRepository,
  RecordingProjectStateEventPublisher,
  initializeProjectStateOnce,
} from '@control-plane/domain'
import { SqlitePersistenceProvider, SqliteProjectStateRepository } from './index.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const projectId = 'prj_01JABCDEF0123456789ABCDEFG'
const initializedAt = '2026-10-06T12:00:00.000Z'
const command = {
  workspaceId,
  projectId,
  callerId: 'svc_adea',
  commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
  idempotencyKey: 'project-state-init:prj_01JABCDEF',
  payloadHash: 'a'.repeat(64),
  at: initializedAt,
}

describe('SQLite ProjectState initialization', () => {
  test('commits revision zero, history, receipt and initialized record together', async () => {
    await withProvider(async (provider) => {
      const repository = new SqliteProjectStateRepository(provider)
      const result = await initializeProjectStateOnce(repository, command)

      expect(result.replayed).toBe(false)
      expect(await repository.getHistory(workspaceId, projectId)).toEqual([result.state])
      const [receipts, events] = await provider.transaction(async (transaction) => [
        await transaction.list('project-state-initializations'),
        await transaction.list('project-state-initialized-events'),
      ])
      expect(receipts.map((record) => record.value)).toEqual([result.receipt])
      expect(events.map((record) => record.value)).toEqual([
        {
          eventType: 'project_state.initialized',
          workspaceId,
          projectId,
          revision: 0,
          commandId: command.commandId,
          initializedAt,
        },
      ])
      // Initialization is not a CAS mutation and records no project_state.updated entry.
      expect(
        await provider.transaction((transaction) => transaction.list('project-state-updates'))
      ).toEqual([])
    })
  })

  test('replays the original receipt across a restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'project-state-init-'))
    const path = join(directory, 'control-plane.sqlite')
    try {
      const first = new SqlitePersistenceProvider({ path })
      await first.migrate()
      const original = await initializeProjectStateOnce(
        new SqliteProjectStateRepository(first),
        command
      )
      await first.close()

      const reopened = new SqlitePersistenceProvider({ path })
      await reopened.migrate()
      const replay = await initializeProjectStateOnce(new SqliteProjectStateRepository(reopened), {
        ...command,
        commandId: 'cmd_01JBBCDEF0123456789ABCDEFG',
        at: '2026-10-06T12:10:00.000Z',
      })
      expect(replay).toEqual({ ...original, replayed: true })
      await reopened.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('admits exactly one of two concurrent initializations', async () => {
    await withProvider(async (provider) => {
      const repository = new SqliteProjectStateRepository(provider)
      const results = await Promise.allSettled([
        initializeProjectStateOnce(repository, command),
        initializeProjectStateOnce(repository, {
          ...command,
          commandId: 'cmd_01JBBCDEF0123456789ABCDEFG',
          idempotencyKey: 'project-state-init:other-key',
        }),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.find((result) => result.status === 'rejected').reason.code).toBe(
        'PROJECT_STATE_EXISTS'
      )
      expect(await repository.getHistory(workspaceId, projectId)).toHaveLength(1)
    })
  })

  test('matches the in-memory reference adapter outcome for outcome', async () => {
    await withProvider(async (provider) => {
      const sqlite = await scenario(new SqliteProjectStateRepository(provider), async () => {
        await new ProjectStateService(
          new SqliteProjectStateRepository(provider),
          new InMemoryStatePromotionProposalRepository(),
          new RecordingProjectStateEventPublisher()
        ).initialize({ workspaceId, projectId: bootstrappedProjectId, at: initializedAt })
      })
      const reference = new InMemoryProjectStateRepository()
      const memory = await scenario(reference, async () => {
        await new ProjectStateService(
          reference,
          new InMemoryStatePromotionProposalRepository(),
          new RecordingProjectStateEventPublisher()
        ).initialize({ workspaceId, projectId: bootstrappedProjectId, at: initializedAt })
      })
      expect(sqlite).toEqual(memory)
      expect(sqlite).toEqual([
        'initialized',
        'replayed',
        'INITIALIZATION_IDEMPOTENCY_CONFLICT',
        'PROJECT_STATE_EXISTS',
        'PROJECT_STATE_EXISTS',
        'PROJECT_STATE_EXISTS',
        'initialized',
      ])
    })
  })

  test('rejects integrity violations without partial writes', async () => {
    await withProvider(async (provider) => {
      const repository = new SqliteProjectStateRepository(provider)
      const state = {
        schemaVersion: 1,
        workspaceId,
        projectId,
        revision: 0,
        items: [],
        createdAt: initializedAt,
        updatedAt: initializedAt,
      }
      const { at: _at, ...receipt } = { ...command, initializedAt }
      await expect(
        repository.initializeWithReceipt(state, {
          ...receipt,
          initializedAt: '2026-10-06T12:01:00.000Z',
        })
      ).rejects.toThrow('PROJECT_STATE_INITIALIZATION_INTEGRITY_ERROR')
      expect(await repository.get(workspaceId, projectId)).toBeUndefined()
    })
  })
})

const bootstrappedProjectId = 'prj_01JCBCDEF0123456789ABCDEFG'

async function scenario(repository, bootstrap) {
  const outcomes = []
  const run = async (input) => {
    try {
      const result = await initializeProjectStateOnce(repository, input)
      outcomes.push(result.replayed ? 'replayed' : 'initialized')
    } catch (error) {
      outcomes.push(error.code)
    }
  }
  await run(command)
  await run({ ...command, commandId: 'cmd_01JBBCDEF0123456789ABCDEFG' })
  await run({ ...command, payloadHash: 'b'.repeat(64) })
  await run({ ...command, idempotencyKey: 'project-state-init:other-key' })
  await run({ ...command, callerId: 'svc_other' })
  await bootstrap()
  await run({ ...command, projectId: bootstrappedProjectId })
  await run({ ...command, projectId: 'prj_01JDBCDEF0123456789ABCDEFG' })
  return outcomes
}

async function withProvider(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'project-state-init-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'control-plane.sqlite') })
  try {
    await provider.migrate()
    await operation(provider)
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}
