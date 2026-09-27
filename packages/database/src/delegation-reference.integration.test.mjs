import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { sql, eq } from 'drizzle-orm'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import { contextPackageSerializationFixtures, deriveContextPackage } from '@control-plane/context'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { assertExecutionPlanIntegrity, deriveExecutionPlan } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { createIsolatedTestDatabase } from './testing.ts'
import { PostgresDelegationRepository } from './delegation-repository.ts'
import { PostgresContextPackageRepository } from './context-package-repository.ts'
import { PostgresExecutionPlanRepository } from './execution-plan-repository.ts'
import { contextPackages } from './schema/context-packages.ts'
import { executionPlans } from './schema/execution-plans.ts'
import { executions } from './schema/executions.ts'

const integrationEnabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const referenceIntegrityError = 'DELEGATION_REFERENCE_INTEGRITY_ERROR'

describe.skipIf(!integrationEnabled)('PostgreSQL delegation reference safety', () => {
  let isolated
  let nextFixture = 1

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    await isolated.migrate()
  }, 60_000)

  afterAll(async () => {
    await isolated?.dispose()
  })

  test('persists a delegation only when all five durable references match', async () => {
    const fixture = await createFixture()
    const repository = new PostgresDelegationRepository(isolated.application)

    expect(await repository.insert(fixture.record)).toBe(true)
    expect(await repository.get(fixture.record.delegationId)).toEqual(fixture.record)
  })

  test('accepts a child context package derived from the parent plan context', async () => {
    const fixture = await createFixture('derived')
    expect(
      await new PostgresDelegationRepository(isolated.application).insert(fixture.record)
    ).toBe(true)
  })

  for (const [mode, label] of [
    ['unrelated', 'an unrelated parent context edge'],
    ['missing-edge', 'a missing parent context edge'],
  ]) {
    test(`rejects ${label}`, async () => {
      const fixture = await createFixture(mode)
      expect(() => assertExecutionPlanIntegrity(fixture.childPlan)).not.toThrow()
      await expect(
        new PostgresDelegationRepository(isolated.application).insert(fixture.record)
      ).rejects.toThrow(referenceIntegrityError)
    })
  }

  test('fails closed when the parent plan context row is missing or mismatched', async () => {
    const missingFixture = await createFixture('derived')
    await isolated.application
      .delete(contextPackages)
      .where(
        eq(contextPackages.contextPackageId, missingFixture.ancestorContextPackage.contextPackageId)
      )
    await expect(
      new PostgresDelegationRepository(isolated.application).insert(missingFixture.record)
    ).rejects.toThrow(referenceIntegrityError)

    const mismatchedFixture = await createFixture('derived')
    await isolated.application
      .update(contextPackages)
      .set({ contentDigest: digest('f') })
      .where(
        eq(
          contextPackages.contextPackageId,
          mismatchedFixture.ancestorContextPackage.contextPackageId
        )
      )
    await expect(
      new PostgresDelegationRepository(isolated.application).insert(mismatchedFixture.record)
    ).rejects.toThrow(referenceIntegrityError)
  })

  const missingAndDigestCases = [
    [
      'missing parent execution',
      (record) => ({ ...record, parentExecutionId: opaque('exe', 9001) }),
    ],
    ['missing child execution', (record) => ({ ...record, childExecutionId: opaque('exe', 9002) })],
    [
      'missing parent plan',
      (record) => ({ ...record, parentExecutionPlanId: opaque('pln', 9001) }),
    ],
    ['missing child plan', (record) => ({ ...record, childExecutionPlanId: opaque('pln', 9002) })],
    ['missing context package', (record) => ({ ...record, contextPackageId: opaque('ctx', 9001) })],
    [
      'parent plan digest mismatch',
      (record) => ({ ...record, parentExecutionPlanDigest: digest('f') }),
    ],
    [
      'child plan digest mismatch',
      (record) => ({ ...record, childExecutionPlanDigest: digest('e') }),
    ],
    ['context digest mismatch', (record) => ({ ...record, contextPackageDigest: digest('d') })],
  ]
  for (const [label, change] of missingAndDigestCases) {
    test(`fails closed for ${label}`, async () => {
      const fixture = await createFixture()
      await expect(
        new PostgresDelegationRepository(isolated.application).insert(change(fixture.record))
      ).rejects.toThrow(referenceIntegrityError)
    })
  }

  const ownershipScenarios = [
    [
      'cross-scope child execution',
      async (fixture) => {
        await isolated.application
          .update(executions)
          .set({ projectId: opaque('prj', 9101) })
          .where(eq(executions.executionId, fixture.record.childExecutionId))
      },
    ],
    [
      'child detached from its parent',
      async (fixture) => {
        await isolated.application
          .update(executions)
          .set({ parentExecutionId: null })
          .where(eq(executions.executionId, fixture.record.childExecutionId))
      },
    ],
    [
      'execution bound to another plan',
      async (fixture) => {
        await isolated.application
          .update(executions)
          .set({ executionPlanId: opaque('pln', 9101) })
          .where(eq(executions.executionId, fixture.record.parentExecutionId))
      },
    ],
  ]
  for (const [label, corrupt] of ownershipScenarios) {
    test(`rejects ${label}`, async () => {
      const fixture = await createFixture()
      await corrupt(fixture)
      await expect(
        new PostgresDelegationRepository(isolated.application).insert(fixture.record)
      ).rejects.toThrow(referenceIntegrityError)
    })
  }

  test('rejects tampered plan and context payloads even when indexed digests still match', async () => {
    const planFixture = await createFixture()
    await isolated.application
      .update(executionPlans)
      .set({ plan: { ...planFixture.childPlan, compiledAt: '2026-09-26T12:05:00.000Z' } })
      .where(eq(executionPlans.executionPlanId, planFixture.childPlan.executionPlanId))
    await expect(
      new PostgresDelegationRepository(isolated.application).insert(planFixture.record)
    ).rejects.toThrow(referenceIntegrityError)

    const contextFixture = await createFixture()
    await isolated.application
      .update(contextPackages)
      .set({ contextPackage: { ...contextFixture.contextPackage, objective: 'tampered' } })
      .where(eq(contextPackages.contextPackageId, contextFixture.contextPackage.contextPackageId))
    await expect(
      new PostgresDelegationRepository(isolated.application).insert(contextFixture.record)
    ).rejects.toThrow(referenceIntegrityError)
  })

  test('returns false for delegation and child replays before requiring historical targets', async () => {
    const fixture = await createFixture()
    const repository = new PostgresDelegationRepository(isolated.application)
    expect(await repository.insert(fixture.record)).toBe(true)

    await isolated.application
      .delete(executions)
      .where(eq(executions.executionId, fixture.record.childExecutionId))
    await isolated.application
      .delete(executions)
      .where(eq(executions.executionId, fixture.record.parentExecutionId))
    await isolated.application
      .delete(executionPlans)
      .where(eq(executionPlans.executionPlanId, fixture.parentPlan.executionPlanId))
    await isolated.application
      .delete(executionPlans)
      .where(eq(executionPlans.executionPlanId, fixture.childPlan.executionPlanId))
    await isolated.application
      .delete(contextPackages)
      .where(eq(contextPackages.contextPackageId, fixture.contextPackage.contextPackageId))

    expect(await repository.insert(fixture.record)).toBe(false)
    expect(await repository.insert({ ...fixture.record, delegationId: opaque('dlg', 9201) })).toBe(
      false
    )

    const lifecycleUpdate = {
      ...fixture.record,
      state: 'running',
      revision: 2,
      updatedAt: '2026-09-26T12:01:00.000Z',
    }
    expect(await repository.compareAndSet(1, lifecycleUpdate)).toBe(true)
    expect(await repository.get(fixture.record.delegationId)).toEqual(lifecycleUpdate)
  })

  test('refuses CAS retargeting and accepts lifecycle updates with unchanged references', async () => {
    const fixture = await createFixture()
    const repository = new PostgresDelegationRepository(isolated.application)
    expect(await repository.insert(fixture.record)).toBe(true)

    const retargeted = [
      { parentExecutionId: opaque('exe', 9301) },
      { childExecutionId: opaque('exe', 9302) },
      { parentExecutionPlanId: opaque('pln', 9301) },
      { parentExecutionPlanDigest: digest('f') },
      { childExecutionPlanId: opaque('pln', 9302) },
      { childExecutionPlanDigest: digest('e') },
      { contextPackageId: opaque('ctx', 9301) },
      { contextPackageDigest: digest('d') },
      { inputDigest: digest('c') },
      { acceptedAt: '2026-09-26T11:59:00.000Z' },
    ]
    for (const changes of retargeted) {
      expect(
        await repository.compareAndSet(1, {
          ...fixture.record,
          ...changes,
          state: 'running',
          revision: 2,
          updatedAt: '2026-09-26T12:01:00.000Z',
        })
      ).toBe(false)
    }

    expect(await repository.get(fixture.record.delegationId)).toEqual(fixture.record)
    const lifecycleUpdate = {
      ...fixture.record,
      state: 'running',
      revision: 2,
      updatedAt: '2026-09-26T12:01:00.000Z',
    }
    expect(await repository.compareAndSet(1, lifecycleUpdate)).toBe(true)
    expect(await repository.compareAndSet(1, { ...lifecycleUpdate, revision: 3 })).toBe(false)
  })

  test('a deletion claim that locks first makes a concurrent new delegation fail closed', async () => {
    const fixture = await createFixture()
    const repository = new PostgresDelegationRepository(isolated.application)
    let unlockDeletion
    let notifyLocked
    const deletionBarrier = new Promise((resolve) => {
      unlockDeletion = resolve
    })
    const rowLocked = new Promise((resolve) => {
      notifyLocked = resolve
    })

    const deletion = isolated.application.transaction(async (transaction) => {
      const [parent] = await transaction
        .select()
        .from(executions)
        .where(eq(executions.executionId, fixture.record.parentExecutionId))
        .for('update')
      if (!parent) throw new Error('TEST_PARENT_EXECUTION_MISSING')
      notifyLocked()
      await deletionBarrier
      await transaction
        .delete(executions)
        .where(eq(executions.executionId, fixture.record.childExecutionId))
      await transaction
        .delete(executions)
        .where(eq(executions.executionId, fixture.record.parentExecutionId))
    })

    await rowLocked
    const insertion = repository.insert(fixture.record)
    let waitingForRowLock = false
    try {
      waitingForRowLock = await waitForExecutionRowLockWait()
    } finally {
      unlockDeletion()
    }

    await deletion
    expect(waitingForRowLock).toBe(true)
    await expect(insertion).rejects.toThrow(referenceIntegrityError)
  })

  async function createFixture(contextMode = 'same') {
    const ordinal = nextFixture++
    const ancestorContextPackage = deriveContextPackage(
      contextPackageSerializationFixtures.futurePi,
      {
        objective: `Delegation ancestor context ${ordinal}`,
        allowedStateItemIds: [],
        allowedArtifactIds: [],
        budgets: { maximumBytes: 768, maximumTokens: 192 },
        successCriteria: ['Return a verified result'],
        returnContract: { contractRef: 'contract://execution-result/v1' },
        compiledAt: '2026-09-26T12:00:00.000Z',
      }
    )
    const childContextPackage =
      contextMode === 'same'
        ? ancestorContextPackage
        : contextMode === 'derived'
          ? deriveContextPackage(ancestorContextPackage, {
              objective: `Delegation child context ${ordinal}`,
              allowedStateItemIds: [],
              allowedArtifactIds: [],
              budgets: { maximumBytes: 512, maximumTokens: 128 },
              successCriteria: ['Return a verified result'],
              returnContract: { contractRef: 'contract://execution-result/v1' },
              compiledAt: '2026-09-26T12:00:00.000Z',
            })
          : contextMode === 'unrelated'
            ? deriveContextPackage(contextPackageSerializationFixtures.futurePi, {
                objective: `Unrelated child context ${ordinal}`,
                allowedStateItemIds: [],
                allowedArtifactIds: [],
                budgets: { maximumBytes: 512, maximumTokens: 128 },
                successCriteria: ['Return a verified result'],
                returnContract: { contractRef: 'contract://execution-result/v1' },
                compiledAt: '2026-09-26T12:00:00.000Z',
              })
            : contextMode === 'missing-edge'
              ? contextPackageSerializationFixtures.futurePi
              : undefined
    if (!childContextPackage) throw new Error('INVALID_TEST_CONTEXT_MODE')

    const parentPlan = createExecutionPlanTestFixture({ contextPackage: ancestorContextPackage })
    const childPlanInput = deriveExecutionPlan(parentPlan, {
      correlation: {
        ...parentPlan.correlation,
        taskId: opaque('tsk', 1000 + ordinal),
        requestId: opaque('req', 1000 + ordinal),
      },
      contextPackage: ancestorContextPackage,
      constraints: structuredClone(parentPlan.constraints),
      runtimeRequirements: parentPlan.runtimeRequirements,
      outputContract: parentPlan.outputContract,
      compiledAt: '2026-09-26T12:00:00.000Z',
    })
    const childPlan =
      contextMode === 'same' || contextMode === 'derived'
        ? deriveExecutionPlan(parentPlan, {
            correlation: {
              ...parentPlan.correlation,
              taskId: opaque('tsk', 1000 + ordinal),
              requestId: opaque('req', 1000 + ordinal),
            },
            contextPackage: childContextPackage,
            constraints: structuredClone(parentPlan.constraints),
            runtimeRequirements: parentPlan.runtimeRequirements,
            outputContract: parentPlan.outputContract,
            compiledAt: '2026-09-26T12:00:00.000Z',
          })
        : planWithContext(childPlanInput, childContextPackage)
    const contextPackage = childContextPackage
    const parentExecutionId = opaque('exe', 1000 + ordinal * 2)
    const childExecutionId = opaque('exe', 1001 + ordinal * 2)
    const acceptedAt = '2026-09-26T12:00:00.000Z'

    const contextRepository = new PostgresContextPackageRepository(isolated.application)
    await contextRepository.put(contextPackageSerializationFixtures.futurePi)
    await contextRepository.put(ancestorContextPackage)
    if (contextPackage.contextPackageId !== ancestorContextPackage.contextPackageId) {
      await contextRepository.put(contextPackage)
    }
    const planRepository = new PostgresExecutionPlanRepository(isolated.application)
    await planRepository.put(parentPlan)
    await planRepository.put(childPlan)
    await isolated.application.insert(executions).values({
      executionId: parentExecutionId,
      state: 'accepted',
      version: 1,
      workspaceId: parentPlan.correlation.workspaceId,
      projectId: parentPlan.correlation.projectId,
      taskId: parentPlan.correlation.taskId,
      agentId: parentPlan.correlation.agentId,
      requestId: parentPlan.correlation.requestId,
      executionPlanId: parentPlan.executionPlanId,
      executionPlanDigest: parentPlan.contentDigest,
      executionPlanSchemaVersion: parentPlan.schemaVersion,
      parentExecutionId: null,
      attemptCount: 0,
      acceptedAt: new Date(acceptedAt),
      createdAt: new Date(acceptedAt),
      updatedAt: new Date(acceptedAt),
    })
    await isolated.application.insert(executions).values({
      executionId: childExecutionId,
      state: 'accepted',
      version: 1,
      workspaceId: childPlan.correlation.workspaceId,
      projectId: childPlan.correlation.projectId,
      taskId: childPlan.correlation.taskId,
      agentId: childPlan.correlation.agentId,
      requestId: childPlan.correlation.requestId,
      executionPlanId: childPlan.executionPlanId,
      executionPlanDigest: childPlan.contentDigest,
      executionPlanSchemaVersion: childPlan.schemaVersion,
      parentExecutionId,
      attemptCount: 0,
      acceptedAt: new Date(acceptedAt),
      createdAt: new Date(acceptedAt),
      updatedAt: new Date(acceptedAt),
    })

    const record = {
      delegationId: opaque('dlg', 1000 + ordinal),
      parentExecutionId,
      childExecutionId,
      parentExecutionPlanId: parentPlan.executionPlanId,
      parentExecutionPlanDigest: parentPlan.contentDigest,
      childExecutionPlanId: childPlan.executionPlanId,
      childExecutionPlanDigest: childPlan.contentDigest,
      contextPackageId: contextPackage.contextPackageId,
      contextPackageDigest: contextPackage.contentDigest,
      role: 'researcher',
      profileVersionId: parentPlan.profile.profileVersionId,
      objective: 'Research the bounded question',
      policy: {
        cancellation: 'cascade',
        deadline: 'bounded_by_parent',
        failure: 'retry',
        maximumRetries: 2,
      },
      state: 'requested',
      retryCount: 0,
      inputDigest: digest('a'),
      revision: 1,
      acceptedAt,
      updatedAt: acceptedAt,
    }
    return { ancestorContextPackage, contextPackage, parentPlan, childPlan, record }
  }

  async function waitForExecutionRowLockWait() {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const activity = await isolated.application.execute(sql`
        select exists (
          select 1
          from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and state = 'active'
            and query ilike '%from "executions"%'
        ) as waiting
      `)
      if (activity[0]?.waiting) return true
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return false
  }
})

function opaque(prefix, value) {
  return `${prefix}_${String(value).padStart(26, '0')}`
}

function digest(character) {
  return `sha256:${character.repeat(64)}`
}

function planWithContext(plan, contextPackage) {
  const content = {
    ...plan,
    executionPlanId: undefined,
    contentDigest: undefined,
    contextPackage: {
      contextPackageId: contextPackage.contextPackageId,
      contentDigest: contextPackage.contentDigest,
      schemaVersion: contextPackage.schemaVersion,
      compilerVersion: contextPackage.compiler.version,
    },
  }
  const contentDigest = `sha256:${createHash('sha256')
    .update(canonicalJsonStringify(content))
    .digest('hex')}`
  return {
    ...content,
    executionPlanId: planIdentifier(contentDigest),
    contentDigest,
  }
}

function planIdentifier(contentDigest) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const bytes = Buffer.from(contentDigest.slice(7, 39), 'hex')
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31]
  return `pln_${output.slice(0, 26)}`
}
