import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { ControlApiFixtures } from '@control-plane/contracts'
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

test('SQLite command receipts retain first response identity under concurrency and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-interaction-receipts-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    let repository = new SqliteInteractionCommandRepository(provider)
    const initial = await repository.reserve({ request })
    const changed = {
      ...request,
      commandId: `${request.commandId.slice(0, -1)}H`,
      payload: { ...request.payload, action: 'approve' },
    }
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repository.reserve({ request: changed }))
    )
    for (const result of results) expect(result).toEqual(initial)
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    repository = new SqliteInteractionCommandRepository(provider)
    expect(await repository.get(request)).toEqual(initial)
    const accepted = await repository.markAccepted(request, '2026-09-08T01:00:00.000Z')
    expect(accepted).toEqual({ request, acceptedAt: '2026-09-08T01:00:00.000Z' })
    expect(await repository.markAccepted(request, '2026-09-08T02:00:00.000Z')).toEqual(accepted)
    expect(await repository.reserve({ request: changed })).toEqual(accepted)
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
