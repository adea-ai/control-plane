import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChildUsageLedger } from '@control-plane/orchestration'
import { SqliteChildUsageOutcomeRepository } from './child-usage-outcome-repository.ts'
import { SqlitePersistenceProvider } from './provider.ts'

const identity = {
  parentExecutionId: 'exe_01JABCDEF0123456789ABCDEFG',
  delegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
  childExecutionId: 'exe_01JBBCDEF0123456789ABCDEFG',
  childAttemptId: 'att_01JBBCDEF0123456789ABCDEFG',
}

async function withRepository(use) {
  const directory = await mkdtemp(join(tmpdir(), 'child-usage-outcomes-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  await provider.migrate()
  try {
    await use(new SqliteChildUsageOutcomeRepository(provider, identity.delegationId))
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('later revisions replace the stored projection and stay forward-only', async () => {
  await withRepository(async (repository) => {
    const usage = new ChildUsageLedger()
    usage.recordEstimate(identity, { currency: 'USD', maximumMicrounits: 1000, source: 'plan' })
    const first = usage.snapshot()
    expect(await repository.save({ revision: 1, snapshot: first })).toEqual({ revision: 1 })

    usage.recordEstimate(identity, { currency: 'USD', maximumMicrounits: 2000, source: 'plan' })
    const second = usage.snapshot()
    expect(await repository.save({ revision: 2, snapshot: second })).toEqual({ revision: 2 })
    expect(await repository.load()).toEqual({ revision: 2, snapshot: second })

    // A stale owner cannot step back, and an unchanged snapshot is not a new revision.
    await expect(repository.save({ revision: 2, snapshot: first })).rejects.toMatchObject({
      code: 'CHILD_USAGE_OUTCOME_STALE_REVISION',
    })
    await expect(repository.save({ revision: 3, snapshot: second })).rejects.toMatchObject({
      code: 'CHILD_USAGE_OUTCOME_CONFLICT',
    })
    expect(await repository.load()).toEqual({ revision: 2, snapshot: second })
  })
})
