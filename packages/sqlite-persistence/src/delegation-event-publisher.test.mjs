import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { SqlitePersistenceProvider } from './provider.ts'
import { SqliteDelegationEventPublisher } from './delegation-event-publisher.ts'

const parentExecutionId = 'exe_01JABCDEF0123456789ABCDEFG'
const otherParent = 'exe_01JABCDEF0123456789ABCDEFH'
const event = {
  type: 'delegation.completed',
  delegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
  parentExecutionId,
  childExecutionId: 'exe_01JBBCDEF0123456789ABCDEFG',
  occurredAt: '2026-08-25T18:03:00.000Z',
  details: { state: 'completed', terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG' },
}
const key = `delegation:${event.delegationId}:terminal`

test('parent inbox survives SQLite reopen and deduplicates concurrent redelivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delegation-publications-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    const first = new SqliteDelegationEventPublisher(provider, parentExecutionId)
    await first.publish(event, key)
    // The publisher committed, but the caller died before acknowledging its delegation record.
    await provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    const restarted = new SqliteDelegationEventPublisher(provider, parentExecutionId)
    await Promise.all([restarted.publish(event, key), restarted.publish(event, key)])
    expect(await restarted.list()).toEqual([event])
    await expect(
      restarted.publish({ ...event, occurredAt: '2026-08-25T18:04:00.000Z' }, key)
    ).rejects.toThrow('DELEGATION_PUBLICATION_CONFLICT')
    expect(await new SqliteDelegationEventPublisher(provider, otherParent).list()).toEqual([])
    await expect(
      new SqliteDelegationEventPublisher(provider, otherParent).publish(event, key)
    ).rejects.toThrow('DELEGATION_PUBLICATION_SCOPE_MISMATCH')
    await expect(
      restarted.publish({ ...event, details: { ...event.details, apiKey: 'secret-canary' } }, key)
    ).rejects.toThrow()
    await expect(restarted.publish(event, 'secret-canary')).rejects.toThrow(
      'DELEGATION_PUBLICATION_SCOPE_MISMATCH'
    )
    expect(await restarted.list()).toEqual([event])
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
