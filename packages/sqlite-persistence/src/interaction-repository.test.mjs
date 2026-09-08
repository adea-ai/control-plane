import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { InteractionService } from '@control-plane/domain'
import { SqliteInteractionRepository, SqlitePersistenceProvider } from './index.ts'

const request = {
  interactionId: 'int_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  kind: 'approval',
  prompt: { title: 'Approve fixture action' },
  allowedActions: ['approve', 'deny'],
  allowedPrincipalIds: ['svc_agent-hq'],
  requestedAt: '2026-09-08T00:00:00.000Z',
  expiresAt: '2026-09-08T01:00:00.000Z',
}
const response = {
  interactionId: request.interactionId,
  executionId: request.executionId,
  attemptId: request.attemptId,
  responseId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  action: 'approve',
  respondingPrincipalId: 'svc_agent-hq',
  expectedVersion: 1,
  respondedAt: '2026-09-08T00:10:00.000Z',
}

test('attempt lookup backfills old rows and indexes new rows across reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-interaction-index-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    const pending = { ...request, state: 'pending', version: 1 }
    await provider.transaction((transaction) =>
      transaction.put({
        namespace: 'interaction-requests',
        id: `r-${createHash('sha256').update(request.interactionId).digest('hex')}`,
        value: pending,
      })
    )
    let repository = new SqliteInteractionRepository(provider)
    expect(await repository.listForAttempt(request.executionId, request.attemptId)).toEqual([
      pending,
    ])
    const other = {
      ...pending,
      interactionId: 'int_01ARZ3NDEKTSV4RRFFQ69G5FAW',
      attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAW',
    }
    expect(await repository.insert(other)).toBe(true)
    await new InteractionService(repository).resolveTerminal(
      request.interactionId,
      response.respondedAt
    )
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    repository = new SqliteInteractionRepository(provider)
    expect(await repository.listForAttempt(request.executionId, request.attemptId)).toMatchObject([
      { state: 'cancelled', version: 2 },
    ])
    expect(await repository.listForAttempt(other.executionId, other.attemptId)).toEqual([other])
    expect(
      await repository.listForAttempt('exe_01ARZ3NDEKTSV4RRFFQ69G5FAW', request.attemptId)
    ).toEqual([])
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('SQLite interactions preserve pending authorization and concurrent response replay across reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-interactions-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    let repository = new SqliteInteractionRepository(provider)
    const pending = await new InteractionService(repository).request(request)
    expect(await repository.insert(pending)).toBe(false)
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    repository = new SqliteInteractionRepository(provider)
    expect(await repository.get(request.interactionId)).toEqual(pending)
    const service = new InteractionService(repository)
    await expect(
      service.respond({ ...response, respondingPrincipalId: 'svc_other' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED_INTERACTION_RESPONSE' })
    await expect(service.respond({ ...response, expectedVersion: 2 })).rejects.toMatchObject({
      code: 'STALE_INTERACTION_VERSION',
    })
    const results = await Promise.all(Array.from({ length: 8 }, () => service.respond(response)))
    for (const result of results) expect(result).toEqual(results[0])
    expect(results[0]).toMatchObject({ state: 'responded', version: 2 })
    expect(await repository.compareAndSet(1, results[0])).toBe(false)
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    repository = new SqliteInteractionRepository(provider)
    expect(await new InteractionService(repository).respond(response)).toEqual(results[0])
    expect(await repository.get(request.interactionId)).toEqual(results[0])
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('SQLite interaction CAS preserves immutable request scope like PostgreSQL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-interaction-scope-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await provider.migrate()
    const repository = new SqliteInteractionRepository(provider)
    const pending = await new InteractionService(repository).request(request)
    expect(
      await repository.compareAndSet(1, {
        ...pending,
        executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAW',
        allowedPrincipalIds: ['svc_other'],
        state: 'cancelled',
        version: 2,
        resolvedAt: response.respondedAt,
      })
    ).toBe(true)
    expect(await repository.get(request.interactionId)).toMatchObject({
      executionId: request.executionId,
      allowedPrincipalIds: request.allowedPrincipalIds,
      state: 'cancelled',
      version: 2,
    })
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
