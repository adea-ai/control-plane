import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { ControlApiFixtures } from '@control-plane/contracts'
import { executionValidationPayloadHash } from '@control-plane/execution-plan'
import {
  SqlitePersistenceProvider,
  SqliteExecutionValidationCommandRepository,
  SqliteExecutionPlanRepository,
} from './index.ts'

test('retains one atomic validation result across concurrency and file reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'validation-replay-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  const plan = createExecutionPlanTestFixture()
  const alternate = createExecutionPlanTestFixture({
    profileCapabilityRequirements: ['model.select'],
  })
  const scope = {
    callerPrincipalId: 'svc_agent-hq',
    workspaceId: plan.correlation.workspaceId,
    projectId: plan.correlation.projectId,
    operation: 'execution.validate',
    idempotencyKey: 'validation-replay-0001',
  }
  const recordFor = (value) => ({
    scope,
    commandId: ControlApiFixtures.executionValidation.request.commandId,
    requestId: value.correlation.requestId,
    payloadHash: executionValidationPayloadHash(ControlApiFixtures.executionValidation.request),
    executionPlan: { executionPlanId: value.executionPlanId, contentDigest: value.contentDigest },
    recordedAt: '2026-09-07T12:00:00.000Z',
  })
  try {
    await provider.migrate()
    const repository = new SqliteExecutionValidationCommandRepository(provider)
    const failing = new SqliteExecutionValidationCommandRepository({
      transaction: (operation) =>
        provider.transaction((transaction) =>
          operation({
            get: transaction.get.bind(transaction),
            put: async (write) => {
              if (write.namespace === 'execution-validation-commands')
                throw new Error('INJECTED_VALIDATION_WRITE_FAILURE')
              return transaction.put(write)
            },
          })
        ),
    })
    await expect(failing.commit(recordFor(plan), plan)).rejects.toThrow(
      'INJECTED_VALIDATION_WRITE_FAILURE'
    )
    await provider.transaction(async (transaction) => {
      expect(await transaction.list('execution-plans')).toEqual([])
      expect(await transaction.list('execution-validation-commands')).toEqual([])
    })
    expect(() =>
      repository.commit(
        { ...recordFor(plan), scope: { ...scope, projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV' } },
        plan
      )
    ).toThrow('EXECUTION_VALIDATION_COMMAND_PLAN_MISMATCH')
    expect(alternate.executionPlanId).not.toBe(plan.executionPlanId)
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => {
        const candidate = index % 2 ? alternate : plan
        return repository.commit(recordFor(candidate), candidate)
      })
    )
    for (const result of results) expect(result).toEqual(results[0])
    expect(
      await new SqliteExecutionPlanRepository(provider).get(recordFor(alternate).executionPlan)
    ).toBeUndefined()
    await provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    const reopened = new SqliteExecutionValidationCommandRepository(provider)
    expect(await reopened.get(scope)).toEqual(results[0])
    await provider.transaction(async (transaction) => {
      const [stored] = await transaction.list('execution-validation-commands')
      await transaction.put({
        namespace: stored.namespace,
        id: stored.id,
        expectedRevision: stored.revision,
        value: { ...stored.value, scope: { ...scope, callerPrincipalId: 'svc_other' } },
      })
    })
    await expect(reopened.get(scope)).rejects.toThrow('EXECUTION_VALIDATION_COMMAND_SCOPE_MISMATCH')
    await provider.transaction(async (transaction) => {
      const [stored] = await transaction.list('execution-validation-commands')
      await transaction.put({
        namespace: stored.namespace,
        id: stored.id,
        expectedRevision: stored.revision,
        value: results[0],
      })
    })
    await expect(
      reopened.commit({ ...recordFor(plan), payloadHash: `sha256:${'0'.repeat(64)}` }, plan)
    ).rejects.toThrow('EXECUTION_VALIDATION_COMMAND_CONFLICT')
    expect(await reopened.get({ ...scope, callerPrincipalId: 'svc_other' })).toBeUndefined()
    const loaded = await reopened.get(scope)
    loaded.executionPlan.contentDigest = `sha256:${'0'.repeat(64)}`
    expect(await reopened.get(scope)).toEqual(results[0])
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
