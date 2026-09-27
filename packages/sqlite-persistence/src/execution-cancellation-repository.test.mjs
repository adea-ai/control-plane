import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { ControlApiFixtures } from '@control-plane/contracts'
import { ExecutionSchema } from '@control-plane/domain'
import { SqliteExecutionCancellationRepository, SqlitePersistenceProvider } from './index.ts'

const request = {
  ...ControlApiFixtures.executionAcceptance.request,
  operation: 'execution.cancel',
  payload: { executionId: 'exe_01JABCDEF0123456789ABCDEFG' },
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

test('SQLite cancellation receipts survive concurrent reservation, acknowledgement, and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-cancellation-receipts-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    let repository = new SqliteExecutionCancellationRepository(provider)
    expect(await repository.get(request)).toBeUndefined()
    await expect(repository.reserve({ request })).rejects.toThrow(
      'SQLITE_EXECUTION_CANCELLATION_EXECUTION_MISSING'
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
          workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH',
          idempotencyKey: 'mismatched-owner-scope',
        },
      })
    ).rejects.toThrow('SQLITE_EXECUTION_CANCELLATION_SCOPE_MISMATCH')
    await expect(repository.markAccepted(request, '2026-09-08T07:00:00.000Z')).rejects.toThrow(
      'EXECUTION_CANCELLATION_RECEIPT_MISSING'
    )
    await expect(
      repository.reserve({ request, acceptedAt: '2026-09-08T07:00:00.000Z' })
    ).rejects.toThrow('EXECUTION_CANCELLATION_RECEIPT_ALREADY_ACCEPTED')
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        repository.reserve({
          request: { ...request, commandId: `cmd_${String(index).padStart(26, '0')}` },
        })
      )
    )
    expect(results.filter(({ inserted }) => inserted)).toHaveLength(1)
    const first = results[0].receipt
    for (const { receipt } of results) expect(receipt).toEqual(first)
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    repository = new SqliteExecutionCancellationRepository(provider)
    expect(await repository.get(request)).toEqual(first)
    const accepted = await repository.markAccepted(request, '2026-09-08T07:00:00.000Z')
    expect(accepted).toEqual({ ...first, acceptedAt: '2026-09-08T07:00:00.000Z' })
    expect(await repository.markAccepted(request, '2026-09-08T08:00:00.000Z')).toEqual(accepted)
    await provider.transaction((transaction) =>
      transaction.delete('executions', storedId(request.payload.executionId))
    )
    expect(await repository.reserve({ request })).toEqual({ receipt: accepted, inserted: false })
    for (const scope of [
      { ...request, caller: { servicePrincipalId: 'svc_other' } },
      { ...request, workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH' },
      { ...request, projectId: 'prj_01JABCDEF0123456789ABCDEFH' },
      { ...request, idempotencyKey: 'different-cancellation-intent' },
    ])
      expect(await repository.get(scope)).toBeUndefined()
    await expect(repository.markAccepted(request, 'invalid')).rejects.toThrow()
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    expect(await new SqliteExecutionCancellationRepository(provider).get(request)).toEqual(accepted)
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
