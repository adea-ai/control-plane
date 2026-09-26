import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { ControlApiFixtures } from '@control-plane/contracts'
import { ExecutionSchema } from '@control-plane/domain'
import { SqliteInteractionCommandRepository, SqlitePersistenceProvider } from './index.ts'

const request = {
  ...ControlApiFixtures.executionAcceptance.request,
  operation: 'interaction.respond',
  payload: {
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    interactionId: 'int_01JABCDEF0123456789ABCDEFG',
    expectedVersion: 1,
    action: 'deny',
  },
}
const acceptance = ControlApiFixtures.executionAcceptance.request
const storedId = (id) => `r-${createHash('sha256').update(id).digest('hex')}`

async function seedExecution(provider, executionId, workspaceId, projectId) {
  const acceptedAt = '2026-09-07T00:00:00.000Z'
  await provider.transaction((transaction) =>
    transaction.put({
      namespace: 'executions',
      id: storedId(executionId),
      value: ExecutionSchema.parse({
        executionId,
        state: 'accepted',
        version: 1,
        correlation: {
          workspaceId,
          projectId,
          taskId: acceptance.payload.taskId,
          agentId: acceptance.payload.agentId,
          requestId: acceptance.requestId,
        },
        executionPlan: acceptance.payload.executionPlan,
        attemptCount: 0,
        acceptedAt,
        createdAt: acceptedAt,
        updatedAt: acceptedAt,
      }),
    })
  )
}

test('SQLite command receipts retain first response identity under concurrency and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-interaction-receipts-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    let repository = new SqliteInteractionCommandRepository(provider)
    await expect(repository.reserve({ request })).rejects.toThrow(
      'SQLITE_INTERACTION_COMMAND_EXECUTION_MISSING'
    )
    await seedExecution(
      provider,
      request.payload.executionId,
      request.workspaceId,
      request.projectId
    )
    await expect(
      repository.reserve({
        request: {
          ...request,
          workspaceId: `${request.workspaceId.slice(0, -1)}H`,
          idempotencyKey: 'interaction-owner-scope-mismatch',
        },
      })
    ).rejects.toThrow('SQLITE_INTERACTION_COMMAND_SCOPE_MISMATCH')
    const reserved = await repository.reserve({ request })
    expect(reserved.inserted).toBe(true)
    const initial = reserved.receipt
    const changed = {
      ...request,
      commandId: `${request.commandId.slice(0, -1)}H`,
      payload: { ...request.payload, action: 'approve' },
    }
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repository.reserve({ request: changed }))
    )
    for (const result of results) expect(result).toEqual({ receipt: initial, inserted: false })
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    repository = new SqliteInteractionCommandRepository(provider)
    expect(await repository.get(request)).toEqual(initial)
    const accepted = await repository.markAccepted(request, '2026-09-08T01:00:00.000Z')
    expect(accepted).toEqual({ request, acceptedAt: '2026-09-08T01:00:00.000Z' })
    expect(await repository.markAccepted(request, '2026-09-08T02:00:00.000Z')).toEqual(accepted)
    await provider.transaction((transaction) =>
      transaction.delete('executions', storedId(request.payload.executionId))
    )
    expect(await repository.reserve({ request: changed })).toEqual({
      receipt: accepted,
      inserted: false,
    })
    for (const scope of [
      { ...request, caller: { servicePrincipalId: 'svc_other' } },
      { ...request, workspaceId: `${request.workspaceId.slice(0, -1)}H` },
      { ...request, projectId: `${request.projectId.slice(0, -1)}H` },
      { ...request, idempotencyKey: 'another-intent-01JABCDEF0123456789ABCDEFG' },
    ])
      expect(await repository.get(scope)).toBeUndefined()
    await expect(
      repository.reserve({ request, acceptedAt: '2026-09-08T01:00:00.000Z' })
    ).rejects.toThrow('INTERACTION_RECEIPT_ALREADY_ACCEPTED')
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
