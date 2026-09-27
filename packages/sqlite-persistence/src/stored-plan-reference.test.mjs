import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import {
  SqlitePersistenceProvider,
  SqliteContextPackageRepository,
  SqliteExecutionPlanRepository,
  assertSqliteStoredPlanReference,
} from './index.ts'

test('stored plan reference validates schema version and payload/storage identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-plan-identity-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await provider.migrate()
    const package_ = contextPackageSerializationFixtures.futurePi
    const plan = createExecutionPlanTestFixture({ contextPackage: package_ })
    await new SqliteContextPackageRepository(provider).put(package_)
    const reference = await new SqliteExecutionPlanRepository(provider).put(plan)
    expect(
      await provider.transaction((transaction) =>
        assertSqliteStoredPlanReference(transaction, { ...reference, schemaVersion: 1 })
      )
    ).toEqual(plan)
    await expect(
      provider.transaction((transaction) =>
        assertSqliteStoredPlanReference(transaction, { ...reference, schemaVersion: 2 })
      )
    ).rejects.toMatchObject({ code: 'INVALID_EXECUTION_PLAN_REFERENCE' })
    const wrongId = 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV'
    await provider.transaction((transaction) =>
      transaction.put({
        namespace: 'execution-plans',
        id: `r-${createHash('sha256').update(wrongId).digest('hex')}`,
        value: plan,
      })
    )
    await expect(
      provider.transaction((transaction) =>
        assertSqliteStoredPlanReference(transaction, { ...reference, executionPlanId: wrongId })
      )
    ).rejects.toMatchObject({ code: 'INVALID_EXECUTION_PLAN_REFERENCE' })
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
