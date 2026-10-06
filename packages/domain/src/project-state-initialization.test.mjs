import { describe, expect, test } from 'bun:test'
import {
  InMemoryProjectStateRepository,
  InMemoryStatePromotionProposalRepository,
  ProjectStateError,
  ProjectStateService,
  RecordingProjectStateEventPublisher,
  initialProjectState,
  initializeProjectStateOnce,
  parseInitialization,
} from './index.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const projectId = 'prj_01JABCDEF0123456789ABCDEFG'
const now = '2026-10-06T12:00:00.000Z'
const later = '2026-10-06T12:05:00.000Z'
const command = {
  workspaceId,
  projectId,
  callerId: 'svc_adea',
  commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
  idempotencyKey: 'project-state-init:prj_01JABCDEF',
  payloadHash: 'a'.repeat(64),
  at: now,
}

describe('command-driven ProjectState initialization', () => {
  test('creates the canonical empty revision zero with a receipt', async () => {
    const repository = new InMemoryProjectStateRepository()
    const result = await initializeProjectStateOnce(repository, command)

    expect(result.replayed).toBe(false)
    expect(result.state).toEqual({
      schemaVersion: 1,
      workspaceId,
      projectId,
      revision: 0,
      items: [],
      createdAt: now,
      updatedAt: now,
    })
    expect(result.receipt).toMatchObject({ commandId: command.commandId, initializedAt: now })
    expect(await repository.getHistory(workspaceId, projectId)).toEqual([result.state])
  })

  test('an exact retry returns the original state and receipt', async () => {
    const repository = new InMemoryProjectStateRepository()
    const first = await initializeProjectStateOnce(repository, command)
    const retry = await initializeProjectStateOnce(repository, {
      ...command,
      commandId: 'cmd_01JBBCDEF0123456789ABCDEFG',
      at: later,
    })

    expect(retry.replayed).toBe(true)
    expect(retry.state).toEqual(first.state)
    expect(retry.receipt).toEqual(first.receipt)
    expect(await repository.getHistory(workspaceId, projectId)).toHaveLength(1)
  })

  test('the same idempotency key with another payload is a typed conflict', async () => {
    const repository = new InMemoryProjectStateRepository()
    await initializeProjectStateOnce(repository, command)
    await expectCode(
      initializeProjectStateOnce(repository, { ...command, payloadHash: 'b'.repeat(64) }),
      'INITIALIZATION_IDEMPOTENCY_CONFLICT'
    )
  })

  test('another command or caller against an existing scope is PROJECT_STATE_EXISTS', async () => {
    const repository = new InMemoryProjectStateRepository()
    await initializeProjectStateOnce(repository, command)
    await expectCode(
      initializeProjectStateOnce(repository, {
        ...command,
        idempotencyKey: 'project-state-init:other-key',
      }),
      'PROJECT_STATE_EXISTS'
    )
    await expectCode(
      initializeProjectStateOnce(repository, { ...command, callerId: 'svc_other' }),
      'PROJECT_STATE_EXISTS'
    )
  })

  test('a scope created without a receipt is never claimed by a command', async () => {
    const repository = new InMemoryProjectStateRepository()
    await new ProjectStateService(
      repository,
      new InMemoryStatePromotionProposalRepository(),
      new RecordingProjectStateEventPublisher()
    ).initialize({ workspaceId, projectId, at: now })

    await expectCode(initializeProjectStateOnce(repository, command), 'PROJECT_STATE_EXISTS')
  })

  test('scopes are isolated', async () => {
    const repository = new InMemoryProjectStateRepository()
    await initializeProjectStateOnce(repository, command)
    const other = await initializeProjectStateOnce(repository, {
      ...command,
      projectId: 'prj_01JBBCDEF0123456789ABCDEFG',
    })
    expect(other.replayed).toBe(false)
    expect(other.state.projectId).toBe('prj_01JBBCDEF0123456789ABCDEFG')
  })

  test('adapters reject a receipt that does not describe an empty revision zero', () => {
    const state = initialProjectState({ workspaceId, projectId, at: now })
    const receipt = { ...command, initializedAt: now }
    delete receipt.at
    expect(parseInitialization(state, receipt).state).toEqual(state)
    expect(() => parseInitialization({ ...state, revision: 1 }, receipt)).toThrow(
      'PROJECT_STATE_INITIALIZATION_INTEGRITY_ERROR'
    )
    expect(() =>
      parseInitialization(state, { ...receipt, projectId: 'prj_01JBBCDEF0123456789ABCDEFG' })
    ).toThrow('PROJECT_STATE_INITIALIZATION_INTEGRITY_ERROR')
    expect(() => parseInitialization(state, { ...receipt, initializedAt: later })).toThrow(
      'PROJECT_STATE_INITIALIZATION_INTEGRITY_ERROR'
    )
  })

  test('rejects malformed commands before persistence', async () => {
    const repository = new InMemoryProjectStateRepository()
    await expect(
      initializeProjectStateOnce(repository, { ...command, projectId: 'project-1' })
    ).rejects.toThrow()
    expect(await repository.get(workspaceId, projectId)).toBeUndefined()
  })
})

async function expectCode(promise, code) {
  const error = await promise.then(
    () => undefined,
    (reason) => reason
  )
  expect(error).toBeInstanceOf(ProjectStateError)
  expect(error.code).toBe(code)
}
