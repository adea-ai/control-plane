import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { ControlApiFixtures } from '@control-plane/contracts'
import { SqliteExecutionCancellationRepository, SqlitePersistenceProvider } from './index.ts'

const request = {
  ...ControlApiFixtures.executionAcceptance.request,
  operation: 'execution.cancel',
  payload: { executionId: 'exe_01JABCDEF0123456789ABCDEFG' },
}
test('SQLite cancellation receipts survive concurrent reservation, acknowledgement, and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-cancellation-receipts-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    let repository = new SqliteExecutionCancellationRepository(provider)
    expect(await repository.get(request)).toBeUndefined()
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
