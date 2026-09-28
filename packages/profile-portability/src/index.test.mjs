import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TextEncoder } from 'node:util'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { canonicalJsonStringify } from '@control-plane/domain'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import {
  assertExecutionPlanIntegrity,
  deriveExecutionPlan,
  executionValidationCommandKey,
} from '@control-plane/execution-plan'
import {
  assertContextPackageIntegrity,
  contextPackageSerializationFixtures,
  contextAuthoringCommandKey,
  deriveContextPackage,
} from '@control-plane/context'
import {
  REFERENCE_RETENTION_NAMESPACES,
  SqliteContextPackageRepository,
  SqliteExecutionPlanRepository,
  SqlitePersistenceProvider,
  SqliteProjectStateRepository,
  SqliteVersionedCatalogRepository,
} from '@control-plane/sqlite-persistence'
import {
  PersistencePortableStateDestination,
  PersistencePortableStateSource,
  PortableMigrationError,
  applyPortableImport,
  assertPortableManifest,
  exportPortableState,
  finalizePortableManifest,
  planPortableImport,
  runProfileConformance,
} from './index.ts'

const createdAt = '2026-08-30T12:00:00.000Z'
const secretCanary = 'portable-secret-canary-7834'
const temporaryDirectories = []
const temporaryProviders = []

afterEach(async () => {
  const cleanupResults = await Promise.all([
    Promise.allSettled(temporaryProviders.splice(0).map((provider) => provider.close())),
    Promise.allSettled(
      temporaryDirectories
        .splice(0)
        .map(async (directory) => rm(directory, { recursive: true, force: true }))
    ),
  ])
  const cleanupErrors = cleanupResults
    .flat()
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'portable test resource cleanup failed')
  }
})

function source(overrides = {}) {
  return {
    profile: 'local',
    persistence: 'sqlite',
    objectStore: 'filesystem',
    componentVersions: { workflow: 'execution-lifecycle-v1', contracts: '1.0.0' },
    snapshot: async () => ({
      records: [
        {
          category: 'project-state',
          logicalId: 'prj_01JABCDEF0123456789ABCDEFG',
          revision: 2,
          value: { objective: 'ship-portability', provenance: 'principal://operator' },
        },
        {
          category: 'agent-profile',
          logicalId: 'apv_01JABCDEF0123456789ABCDEFG',
          revision: 1,
          value: { semanticVersion: '1.0.0', lifecycle: 'published' },
        },
        {
          category: 'selected-history',
          logicalId: 'exe_01JABCDEF0123456789ABCDEFG',
          revision: 1,
          value: { state: 'completed' },
        },
      ],
      artifacts: [artifact('artifacts/result.json', 'portable-artifact')],
      secretReferences: [{ provider: 'host-secure', key: 'model-key', purpose: 'model' }],
      ...overrides,
    }),
  }
}

class MemoryDestination {
  constructor(profile = 'hosted-server', options = {}) {
    this.profile = profile
    this.capabilities = new Set(options.capabilities ?? ['execution', 'artifacts'])
    this.secretProviders = new Set(options.secretProviders ?? ['host-secure'])
    this.records = new Map(options.records ?? [])
    this.provenance = []
    this.rollbacks = 0
    this.failAfter = options.failAfter
  }

  async inspect(records) {
    return records.map((record) => {
      const existing = this.records.get(recordKey(record))
      return {
        record,
        state:
          existing === undefined
            ? 'missing'
            : existing.contentDigest === record.contentDigest
              ? 'equivalent'
              : 'conflict',
      }
    })
  }

  async begin() {
    const staged = new Map()
    let stagedProvenance
    return {
      put: async (record) => {
        if (this.failAfter !== undefined && staged.size >= this.failAfter) {
          throw new Error('SIMULATED_IMPORT_INTERRUPTION')
        }
        staged.set(recordKey(record), clone(record))
      },
      recordProvenance: async (value) => {
        stagedProvenance = clone(value)
      },
      commit: async () => {
        for (const [key, value] of staged) this.records.set(key, value)
        if (stagedProvenance !== undefined) this.provenance.push(stagedProvenance)
      },
      rollback: async () => {
        this.rollbacks += 1
        staged.clear()
      },
    }
  }
}

class MemoryObjectStore {
  constructor(entries = []) {
    this.objects = new Map(entries.map(([key, value]) => [key, new Uint8Array(value)]))
  }

  async put(input) {
    this.objects.set(input.key, new Uint8Array(input.body))
    return descriptor(input.key, input.body, input.contentType, input.metadata)
  }

  async get(key) {
    const body = this.objects.get(key)
    if (body === undefined) throw objectNotFound()
    return { ...descriptor(key, body), body: new Uint8Array(body) }
  }

  async head(key) {
    const body = this.objects.get(key)
    if (body === undefined) throw objectNotFound()
    return descriptor(key, body)
  }

  async delete(key) {
    this.objects.delete(key)
  }

  close() {}
}

describe('portable profile export and import', () => {
  test('resets only clocks for references created by a new portable import and preserves clocks on replay', async () => {
    const provider = await sqliteProvider('local')
    const { records, contextPackages, executionPlans } = portableReferenceRecords()
    const manifest = await exportPortableState(
      source({ records, artifacts: [], secretReferences: [] }),
      {
        exportId: 'reference-clock-import',
        createdAt,
      }
    )
    const destination = new PersistencePortableStateDestination({
      persistence: provider,
      capabilities: new Set(),
      secretProviders: new Set(),
    })

    await seedReferenceWindows(provider, contextPackages, executionPlans)
    const plan = await planPortableImport(manifest, destination)
    expect(
      await applyPortableImport(manifest, plan, destination, {}, () => createdAt)
    ).toMatchObject({ outcome: 'applied' })
    expect(await referenceWindows(provider, contextPackages, executionPlans)).toEqual({
      contextPackages: [undefined, undefined],
      executionPlans: [undefined, undefined],
    })

    await seedReferenceWindows(
      provider,
      contextPackages,
      executionPlans,
      '2025-02-03T04:05:06.000Z'
    )
    const replayPlan = await planPortableImport(manifest, destination)
    await expect(
      applyPortableImport(manifest, replayPlan, destination, {}, () => createdAt)
    ).resolves.toMatchObject({ outcome: 'replayed' })
    expect(await referenceWindows(provider, contextPackages, executionPlans)).toEqual({
      contextPackages: ['2025-02-03T04:05:06.000Z', '2025-02-03T04:05:06.000Z'],
      executionPlans: ['2025-02-03T04:05:06.000Z', '2025-02-03T04:05:06.000Z'],
    })
  })

  test('rolls back a newly imported child package when its exact parent is missing', async () => {
    const provider = await sqliteProvider('local')
    const parent = contextPackageSerializationFixtures.futureLangGraph
    const child = derivePortableChildContext(parent)
    const record = {
      category: 'context-package',
      logicalId: `context-packages/${child.contextPackageId}`,
      revision: 0,
      value: child,
    }
    const manifest = await exportPortableState(
      source({ records: [record], artifacts: [], secretReferences: [] }),
      {
        exportId: 'missing-parent-import',
        createdAt,
      }
    )
    const destination = new PersistencePortableStateDestination({
      persistence: provider,
      capabilities: new Set(),
      secretProviders: new Set(),
    })
    await seedReferenceWindows(provider, [child.contextPackageId], [])
    const plan = await planPortableImport(manifest, destination)

    await expect(
      applyPortableImport(manifest, plan, destination, {}, () => createdAt)
    ).rejects.toThrow()
    await provider.transaction(async (transaction) => {
      expect(
        await transaction.get('context-packages', sqliteRecordId(child.contextPackageId))
      ).toBeUndefined()
      expect(
        (
          await transaction.get(
            REFERENCE_RETENTION_NAMESPACES.contextPackages,
            sqliteRecordId(child.contextPackageId)
          )
        )?.value
      ).toEqual({ unreferencedSince: '2025-01-02T03:04:05.000Z' })
      expect(await transaction.get('profile-migrations', 'missing-parent-import')).toBeUndefined()
    })
  })

  test('resets an existing parent clock for a new reference but leaves unrelated and replay clocks unchanged', async () => {
    const provider = await sqliteProvider('local')
    const fixture = portableReferenceRecords()
    const parentContext = fixture.parentContext
    const childContext = fixture.childContext
    const parentPlan = fixture.parentPlan
    const childPlan = fixture.childPlan
    const unrelatedContext = contextPackageSerializationFixtures.futureLangGraph
    const contextRepository = new SqliteContextPackageRepository(provider)
    const planRepository = new SqliteExecutionPlanRepository(provider)
    await contextRepository.put(parentContext)
    await contextRepository.put(unrelatedContext)
    await planRepository.put(parentPlan)

    const manifest = await exportPortableState(
      source({ records: fixture.records, artifacts: [], secretReferences: [] }),
      { exportId: 'mixed-reference-import', createdAt }
    )
    const destination = new PersistencePortableStateDestination({
      persistence: provider,
      capabilities: new Set(),
      secretProviders: new Set(),
    })
    const unrelatedClock = '2025-03-04T05:06:07.000Z'
    await seedReferenceWindows(
      provider,
      [
        parentContext.contextPackageId,
        childContext.contextPackageId,
        unrelatedContext.contextPackageId,
      ],
      [parentPlan.executionPlanId, childPlan.executionPlanId]
    )

    const plan = await planPortableImport(manifest, destination)
    expect(plan.records.filter(({ state }) => state === 'equivalent')).toHaveLength(2)
    expect(plan.records.filter(({ state }) => state === 'missing')).toHaveLength(4)
    expect(
      await applyPortableImport(manifest, plan, destination, {}, () => createdAt)
    ).toMatchObject({ outcome: 'applied' })
    expect(
      await referenceWindows(
        provider,
        [
          parentContext.contextPackageId,
          childContext.contextPackageId,
          unrelatedContext.contextPackageId,
        ],
        [parentPlan.executionPlanId, childPlan.executionPlanId]
      )
    ).toEqual({
      contextPackages: [undefined, undefined, '2025-01-02T03:04:05.000Z'],
      executionPlans: [undefined, undefined],
    })

    await seedReferenceWindows(
      provider,
      [
        parentContext.contextPackageId,
        childContext.contextPackageId,
        unrelatedContext.contextPackageId,
      ],
      [parentPlan.executionPlanId, childPlan.executionPlanId],
      unrelatedClock
    )
    const replayPlan = await planPortableImport(manifest, destination)
    await expect(
      applyPortableImport(manifest, replayPlan, destination, {}, () => createdAt)
    ).resolves.toMatchObject({ outcome: 'replayed' })
    expect(
      await referenceWindows(
        provider,
        [
          parentContext.contextPackageId,
          childContext.contextPackageId,
          unrelatedContext.contextPackageId,
        ],
        [parentPlan.executionPlanId, childPlan.executionPlanId]
      )
    ).toEqual({
      contextPackages: [unrelatedClock, unrelatedClock, unrelatedClock],
      executionPlans: [unrelatedClock, unrelatedClock],
    })
  })

  test('rolls back when an existing parent target is present but its canonical digest is tampered', async () => {
    const provider = await sqliteProvider('local')
    const parent = contextPackageSerializationFixtures.futureLangGraph
    const child = derivePortableChildContext(parent)
    const parentTargetId = sqliteRecordId(parent.contextPackageId)
    const parentClock = '2025-04-05T06:07:08.000Z'
    await new SqliteContextPackageRepository(provider).put(parent)
    await provider.transaction(async (transaction) => {
      const stored = await transaction.get('context-packages', parentTargetId)
      await transaction.put({
        namespace: 'context-packages',
        id: parentTargetId,
        expectedRevision: stored.revision,
        value: { ...stored.value, contentDigest: `sha256:${'0'.repeat(64)}` },
      })
    })
    const record = {
      category: 'context-package',
      logicalId: `context-packages/${child.contextPackageId}`,
      revision: 0,
      value: child,
    }
    const manifest = await exportPortableState(
      source({ records: [record], artifacts: [], secretReferences: [] }),
      { exportId: 'tampered-parent-import', createdAt }
    )
    const destination = new PersistencePortableStateDestination({
      persistence: provider,
      capabilities: new Set(),
      secretProviders: new Set(),
    })
    await seedReferenceWindows(
      provider,
      [parent.contextPackageId, child.contextPackageId],
      [],
      parentClock
    )
    const plan = await planPortableImport(manifest, destination)
    await expect(
      applyPortableImport(manifest, plan, destination, {}, () => createdAt)
    ).rejects.toMatchObject({ code: 'PORTABLE_PLAN_STALE' })
    await provider.transaction(async (transaction) => {
      expect(
        await transaction.get('context-packages', sqliteRecordId(child.contextPackageId))
      ).toBeUndefined()
      expect(
        (
          await transaction.get(
            REFERENCE_RETENTION_NAMESPACES.contextPackages,
            sqliteRecordId(child.contextPackageId)
          )
        )?.value
      ).toEqual({ unreferencedSince: parentClock })
      expect(
        (await transaction.get(REFERENCE_RETENTION_NAMESPACES.contextPackages, parentTargetId))
          ?.value
      ).toEqual({ unreferencedSince: parentClock })
      expect(await transaction.get('profile-migrations', 'tampered-parent-import')).toBeUndefined()
    })
  })

  test('resets an existing parent clock for an only-child import and preserves an unrelated plan sentinel', async () => {
    const provider = await sqliteProvider('local')
    const parent = contextPackageSerializationFixtures.futurePi
    const child = derivePortableChildContext(parent)
    const unrelatedContext = contextPackageSerializationFixtures.futureLangGraph
    const unrelatedPlan = createExecutionPlanTestFixture({ contextPackage: unrelatedContext })
    await new SqliteContextPackageRepository(provider).put(parent)
    await new SqliteContextPackageRepository(provider).put(unrelatedContext)
    await seedReferenceWindows(
      provider,
      [parent.contextPackageId, child.contextPackageId, unrelatedContext.contextPackageId],
      [unrelatedPlan.executionPlanId]
    )
    const record = portableRecord('context-package', child.contextPackageId, child)
    const manifest = await exportPortableState(
      source({ records: [record], artifacts: [], secretReferences: [] }),
      { exportId: 'only-child-reference-import', createdAt }
    )
    const destination = new PersistencePortableStateDestination({
      persistence: provider,
      capabilities: new Set(),
      secretProviders: new Set(),
    })
    const plan = await planPortableImport(manifest, destination)

    expect(
      await applyPortableImport(manifest, plan, destination, {}, () => createdAt)
    ).toMatchObject({ outcome: 'applied' })
    expect(
      await referenceWindows(
        provider,
        [parent.contextPackageId, child.contextPackageId, unrelatedContext.contextPackageId],
        [unrelatedPlan.executionPlanId]
      )
    ).toEqual({
      contextPackages: [undefined, undefined, '2025-01-02T03:04:05.000Z'],
      executionPlans: ['2025-01-02T03:04:05.000Z'],
    })
  })

  test('rejects correctly rehashed context children that widen authority or budget transactionally', async () => {
    const fixture = portableReferenceRecords()
    const widenedScope = rehashPortableRecordValue(
      {
        ...fixture.childContext,
        constraints: {
          ...fixture.childContext.constraints,
          allowedStateItemIds: ['psi_01JBBCDEF0123456789ABCDEFG'],
        },
      },
      'contextPackageId',
      'ctx'
    )
    const widenedBudget = rehashPortableRecordValue(
      {
        ...fixture.childContext,
        budgets: {
          ...fixture.childContext.budgets,
          maximumBytes: fixture.parentContext.budgets.maximumBytes + 1,
        },
      },
      'contextPackageId',
      'ctx'
    )

    expect(assertContextPackageIntegrity(widenedScope)).toEqual(widenedScope)
    expect(assertContextPackageIntegrity(widenedBudget)).toEqual(widenedBudget)
    for (const [index, child] of [widenedScope, widenedBudget].entries()) {
      await assertPortableImportRollback({
        record: portableRecord('context-package', child.contextPackageId, child),
        exportId: `invalid-context-child-${index}`,
        storedContexts: [fixture.parentContext],
        contextWindowIds: [fixture.parentContext.contextPackageId, child.contextPackageId],
        missingContextIds: [child.contextPackageId],
        expectedCode: 'PORTABLE_PLAN_STALE',
      })
    }
  })

  test('rejects correctly rehashed child plans that widen authority or change inherited pins transactionally', async () => {
    const fixture = portableReferenceRecords()
    const requiredCapability = fixture.parentPlan.runtimeRequirements.find(
      ({ necessity }) => necessity === 'required'
    )?.capability
    expect(requiredCapability).toBeDefined()
    const invalidPlans = [
      {
        ...fixture.childPlan,
        constraints: {
          ...fixture.childPlan.constraints,
          tools: {
            ...fixture.childPlan.constraints.tools,
            grants: fixture.childPlan.constraints.tools.grants.map((grant, index) =>
              index === 0 ? { ...grant, operations: [...grant.operations, 'admin'] } : grant
            ),
          },
        },
      },
      {
        ...fixture.childPlan,
        runtimeRequirements: fixture.childPlan.runtimeRequirements.filter(
          ({ capability }) => capability !== requiredCapability
        ),
      },
      {
        ...fixture.childPlan,
        profile: { ...fixture.childPlan.profile, contentDigest: `sha256:${'f'.repeat(64)}` },
      },
      {
        ...fixture.childPlan,
        skills: fixture.childPlan.skills.map((skill, index) =>
          index === 0 ? { ...skill, contentDigest: `sha256:${'f'.repeat(64)}` } : skill
        ),
      },
    ].map((plan) => rehashPortableRecordValue(plan, 'executionPlanId', 'pln'))

    for (const [index, plan] of invalidPlans.entries()) {
      expect(assertExecutionPlanIntegrity(plan)).toEqual(plan)
      await assertPortableImportRollback({
        record: portableRecord('execution-plan', plan.executionPlanId, plan),
        exportId: `invalid-child-plan-${index}`,
        storedContexts: [fixture.parentContext, fixture.childContext],
        storedPlans: [fixture.parentPlan],
        contextWindowIds: [
          fixture.parentContext.contextPackageId,
          fixture.childContext.contextPackageId,
        ],
        planWindowIds: [fixture.parentPlan.executionPlanId, plan.executionPlanId],
        missingPlanIds: [plan.executionPlanId],
        expectedCode: 'PORTABLE_PLAN_STALE',
      })
    }
  })

  test('rejects false resolved context pins on root plans and child plans transactionally', async () => {
    const fixture = portableReferenceRecords()
    const rootPlan = createExecutionPlanTestFixture({ contextPackage: fixture.parentContext })
    const rootPinMismatches = [
      {
        ...rootPlan,
        contextPackage: {
          ...rootPlan.contextPackage,
          schemaVersion: rootPlan.contextPackage.schemaVersion + 1,
        },
      },
      {
        ...rootPlan,
        contextPackage: { ...rootPlan.contextPackage, compilerVersion: '2.0.0' },
      },
    ].map((plan) => rehashPortableRecordValue(plan, 'executionPlanId', 'pln'))

    for (const [index, plan] of rootPinMismatches.entries()) {
      expect(assertExecutionPlanIntegrity(plan)).toEqual(plan)
      await assertPortableImportRollback({
        record: portableRecord('execution-plan', plan.executionPlanId, plan),
        exportId: `invalid-root-pin-${index}`,
        storedContexts: [fixture.parentContext],
        contextWindowIds: [fixture.parentContext.contextPackageId],
        planWindowIds: [plan.executionPlanId],
        missingPlanIds: [plan.executionPlanId],
        expectedCode: 'PORTABLE_PLAN_STALE',
      })
    }

    const childPinMismatches = [
      {
        ...fixture.childPlan,
        contextPackage: {
          ...fixture.childPlan.contextPackage,
          schemaVersion: fixture.childPlan.contextPackage.schemaVersion + 1,
        },
      },
      {
        ...fixture.childPlan,
        contextPackage: { ...fixture.childPlan.contextPackage, compilerVersion: '2.0.0' },
      },
    ].map((plan) => rehashPortableRecordValue(plan, 'executionPlanId', 'pln'))

    for (const [index, plan] of childPinMismatches.entries()) {
      expect(assertExecutionPlanIntegrity(plan)).toEqual(plan)
      await assertPortableImportRollback({
        record: portableRecord('execution-plan', plan.executionPlanId, plan),
        exportId: `invalid-child-pin-${index}`,
        storedContexts: [fixture.parentContext, fixture.childContext],
        storedPlans: [fixture.parentPlan],
        contextWindowIds: [
          fixture.parentContext.contextPackageId,
          fixture.childContext.contextPackageId,
        ],
        planWindowIds: [fixture.parentPlan.executionPlanId, plan.executionPlanId],
        missingPlanIds: [plan.executionPlanId],
        expectedCode: 'PORTABLE_PLAN_STALE',
      })
    }
  })

  test('rejects self-referential context and plan payloads before importing any rows', async () => {
    const fixture = portableReferenceRecords()
    const contextId = 'ctx_01JBBCDEF0123456789ABCDEFG'
    const selfContext = {
      ...fixture.childContext,
      contextPackageId: contextId,
      parentContextPackage: {
        contextPackageId: contextId,
        contentDigest: `sha256:${'a'.repeat(64)}`,
      },
    }
    const planId = 'pln_01JBBCDEF0123456789ABCDEFG'
    const selfPlan = {
      ...fixture.childPlan,
      executionPlanId: planId,
      parentExecutionPlan: {
        executionPlanId: planId,
        contentDigest: `sha256:${'b'.repeat(64)}`,
      },
    }

    await assertPortableImportRollback({
      record: portableRecord('context-package', contextId, selfContext),
      exportId: 'self-context-reference',
      contextWindowIds: [contextId],
      missingContextIds: [contextId],
      expectedCode: 'PORTABLE_SCHEMA_INCOMPATIBLE',
    })
    await assertPortableImportRollback({
      record: portableRecord('execution-plan', planId, selfPlan),
      exportId: 'self-plan-reference',
      planWindowIds: [planId],
      missingPlanIds: [planId],
      expectedCode: 'PORTABLE_SCHEMA_INCOMPATIBLE',
    })
  })

  test('requires validation replay records to retain exact scoped plans and logical identities', async () => {
    const plan = createExecutionPlanTestFixture()
    const command = {
      scope: {
        callerPrincipalId: 'svc_portable',
        workspaceId: plan.correlation.workspaceId,
        projectId: plan.correlation.projectId,
        operation: 'execution.validate',
        idempotencyKey: 'portable-validation-0001',
      },
      commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
      requestId: plan.correlation.requestId,
      recordedAt: createdAt,
      payloadHash: `sha256:${'a'.repeat(64)}`,
      executionPlan: { executionPlanId: plan.executionPlanId, contentDigest: plan.contentDigest },
    }
    const planRecord = {
      category: 'execution-plan',
      logicalId: `execution-plans/${plan.executionPlanId}`,
      revision: 0,
      value: plan,
    }
    const commandRecord = {
      category: 'execution-validation-command',
      logicalId: `execution-validation-commands/${executionValidationCommandKey(command.scope)}`,
      revision: 0,
      value: command,
    }
    const manifestFor = async (records) =>
      assertPortableManifest(
        await exportPortableState(source({ records }), {
          exportId: 'validation-fixture',
          createdAt,
        })
      )
    expect(
      assertPortableManifest(await manifestFor([planRecord, commandRecord])).records
    ).toHaveLength(2)
    const otherScope = { ...command.scope, workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG' }
    const aliasId = 'pln_01JBBCDEF0123456789ABCDEFG'
    for (const records of [
      [commandRecord],
      [
        planRecord,
        { ...commandRecord, logicalId: `execution-validation-commands/${'0'.repeat(64)}` },
      ],
      [
        planRecord,
        {
          ...commandRecord,
          logicalId: `execution-validation-commands/${executionValidationCommandKey(otherScope)}`,
          value: { ...command, scope: otherScope },
        },
      ],
      [
        planRecord,
        {
          ...commandRecord,
          value: {
            ...command,
            executionPlan: { ...command.executionPlan, contentDigest: `sha256:${'0'.repeat(64)}` },
          },
        },
      ],
      [
        planRecord,
        { ...commandRecord, value: { ...command, requestId: 'req_01JBBCDEF0123456789ABCDEFG' } },
      ],
      [
        { ...planRecord, logicalId: `execution-plans/${aliasId}` },
        {
          ...commandRecord,
          value: {
            ...command,
            executionPlan: { ...command.executionPlan, executionPlanId: aliasId },
          },
        },
      ],
    ])
      await expect(manifestFor(records)).rejects.toThrow()
  })

  test('requires authoring replay identities to retain their exact scoped package', async () => {
    const package_ = contextPackageSerializationFixtures.futurePi
    const command = {
      scope: {
        principalRef: 'service:portable',
        workspaceId: package_.projectState.workspaceId,
        projectId: package_.projectState.projectId,
        operation: 'context.author',
        idempotencyKey: 'portable-authoring-0001',
      },
      payloadHash: `sha256:${'a'.repeat(64)}`,
      contextPackage: {
        contextPackageId: package_.contextPackageId,
        contentDigest: package_.contentDigest,
      },
    }
    const packageRecord = {
      category: 'context-package',
      logicalId: `context-packages/${package_.contextPackageId}`,
      revision: 0,
      value: package_,
    }
    const commandRecord = {
      category: 'context-authoring-command',
      logicalId: `context-authoring-commands/${contextAuthoringCommandKey(command.scope)}`,
      revision: 0,
      value: command,
    }
    const manifestFor = (records) =>
      exportPortableState(source({ records }), { exportId: 'authoring-fixture', createdAt })
    expect(
      assertPortableManifest(await manifestFor([packageRecord, commandRecord])).records
    ).toHaveLength(2)
    const otherScope = { ...command.scope, workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG' }
    const aliasId = 'ctx_01JBBCDEF0123456789ABCDEFG'
    for (const records of [
      [commandRecord],
      [
        packageRecord,
        {
          ...commandRecord,
          logicalId: `context-authoring-commands/${contextAuthoringCommandKey(otherScope)}`,
          value: { ...command, scope: otherScope },
        },
      ],
      [
        { ...packageRecord, logicalId: `context-packages/${aliasId}` },
        {
          ...commandRecord,
          value: {
            ...command,
            contextPackage: { ...command.contextPackage, contextPackageId: aliasId },
          },
        },
      ],
      [
        packageRecord,
        { ...commandRecord, logicalId: `context-authoring-commands/${'0'.repeat(64)}` },
      ],
      [
        packageRecord,
        {
          ...commandRecord,
          value: {
            ...command,
            contextPackage: {
              ...command.contextPackage,
              contentDigest: `sha256:${'0'.repeat(64)}`,
            },
          },
        },
      ],
    ]) {
      await expect(
        (async () => assertPortableManifest(await manifestFor(records)))()
      ).rejects.toThrow()
    }
  })
  test('creates a deterministic, versioned, digest-verified manifest without history by default', async () => {
    const first = await exportPortableState(source(), {
      exportId: 'export-1',
      createdAt,
      requiredCapabilities: ['artifacts', 'execution', 'execution'],
      sensitiveValues: [secretCanary],
    })
    const second = await exportPortableState(source(), {
      exportId: 'export-1',
      createdAt,
      requiredCapabilities: ['execution', 'artifacts'],
      sensitiveValues: [secretCanary],
    })

    expect(first).toEqual(second)
    expect(first.records.map(({ category }) => category)).toEqual([
      'agent-profile',
      'project-state',
    ])
    expect(first.compatibility.requiredCapabilities).toEqual(['artifacts', 'execution'])
    expect(JSON.stringify(first)).not.toContain(secretCanary)
    expect(assertPortableManifest(first)).toEqual(first)
    expect(() =>
      assertPortableManifest({
        ...first,
        records: [{ ...first.records[0], revision: 99 }, ...first.records.slice(1)],
      })
    ).toThrow()
  })

  test('blocks active work, secret canaries, credential fields, and private absolute paths', async () => {
    await expect(
      exportPortableState(source({ activeWorkIds: ['exe_active'] }), {
        exportId: 'export-active',
        createdAt,
      })
    ).rejects.toMatchObject({ code: 'PORTABLE_ACTIVE_WORK', details: ['exe_active'] })
    await expect(
      exportPortableState(
        source({
          records: [
            {
              category: 'policy-configuration',
              logicalId: 'policy-1',
              revision: 1,
              value: { note: secretCanary },
            },
          ],
        }),
        { exportId: 'export-secret', createdAt, sensitiveValues: [secretCanary] }
      )
    ).rejects.toMatchObject({ code: 'PORTABLE_SENSITIVE_VALUE' })
    for (const value of [{ accessToken: 'opaque' }, { repositoryPath: '/Users/operator/code' }]) {
      await expect(
        exportPortableState(
          source({
            records: [
              {
                category: 'runtime-configuration',
                logicalId: 'runtime-1',
                revision: 1,
                value,
              },
            ],
          }),
          { exportId: 'export-unsafe', createdAt }
        )
      ).rejects.toBeInstanceOf(PortableMigrationError)
    }
  })

  test('inspects the complete manifest payload before export and import planning', async () => {
    const unsafeArtifact = artifact('artifacts/unsafe.json', 'unsafe')
    await expect(
      exportPortableState(
        source({ artifacts: [{ ...unsafeArtifact, metadata: { accessToken: 'opaque' } }] }),
        { exportId: 'export-artifact-token', createdAt }
      )
    ).rejects.toMatchObject({ code: 'PORTABLE_SENSITIVE_VALUE', details: ['accessToken'] })
    await expect(
      exportPortableState(
        source({
          artifacts: [
            { ...unsafeArtifact, metadata: { sourceLocation: '/Users/operator/private.json' } },
          ],
        }),
        { exportId: 'export-artifact-path', createdAt }
      )
    ).rejects.toMatchObject({ code: 'PORTABLE_PRIVATE_PATH' })
    await expect(
      exportPortableState(
        source({
          secretReferences: [
            { provider: 'host-secure', key: '/Users/operator/.secrets/model', purpose: 'model' },
          ],
        }),
        { exportId: 'export-secret-path', createdAt }
      )
    ).rejects.toMatchObject({ code: 'PORTABLE_PRIVATE_PATH' })
    for (const metadata of [
      { clientSecret: 'opaque' },
      { apiKey: 'opaque' },
      { credentials: 'opaque' },
      { sourceLocation: '/etc/shadow' },
      { sourceLocation: 'C:/Users/operator/secret.json' },
      { sourceLocation: '\\\\server\\share\\secret.json' },
    ]) {
      await expect(
        exportPortableState(source({ artifacts: [{ ...unsafeArtifact, metadata }] }), {
          exportId: 'export-artifact-unsafe',
          createdAt,
        })
      ).rejects.toBeInstanceOf(PortableMigrationError)
    }
    await expect(
      exportPortableState(source({ unsupportedReferences: [secretCanary] }), {
        exportId: 'export-unsupported-canary',
        createdAt,
        sensitiveValues: [secretCanary],
      })
    ).rejects.toMatchObject({ code: 'PORTABLE_SENSITIVE_VALUE' })
    await expect(
      exportPortableState(source({ unsupportedReferences: ['/Users/operator/private.json'] }), {
        exportId: 'export-unsupported-path',
        createdAt,
      })
    ).rejects.toMatchObject({ code: 'PORTABLE_PRIVATE_PATH' })

    const safeManifest = await exportPortableState(source(), {
      exportId: 'export-import-safety',
      createdAt,
    })
    const unsigned = { ...safeManifest }
    Reflect.deleteProperty(unsigned, 'contentDigest')
    const unsafeManifest = finalizePortableManifest({
      ...unsigned,
      artifacts: [{ ...unsafeArtifact, metadata: { clientSecret: secretCanary } }],
    })
    await expect(planPortableImport(unsafeManifest, new MemoryDestination())).rejects.toMatchObject(
      { code: 'PORTABLE_SENSITIVE_VALUE' }
    )
  })

  test('plans, applies, and idempotently replays Local to Hosted and Hosted to Local', async () => {
    const manifest = await exportPortableState(source(), {
      exportId: 'export-roundtrip',
      createdAt,
      requiredCapabilities: ['execution'],
    })
    const hosted = new MemoryDestination('hosted-server')
    const plan = await planPortableImport(manifest, hosted)
    expect(plan).toMatchObject({ applicable: true, conflicts: [] })
    expect(plan.artifactActions[0].action).toBe('preserve-reference')
    const applied = await applyPortableImport(manifest, plan, hosted, {}, () => createdAt)
    expect(applied).toMatchObject({ outcome: 'applied', provenance: { recordCount: 2 } })

    const replayPlan = await planPortableImport(manifest, hosted)
    const replay = await applyPortableImport(manifest, replayPlan, hosted, {}, () => createdAt)
    expect(replay.outcome).toBe('replayed')
    expect(hosted.records.size).toBe(2)

    const hostedSource = source()
    hostedSource.profile = 'hosted-server'
    hostedSource.persistence = 'postgresql'
    hostedSource.objectStore = 's3-compatible'
    const reverseManifest = await exportPortableState(hostedSource, {
      exportId: 'export-reverse',
      createdAt,
    })
    const local = new MemoryDestination('local')
    const reversePlan = await planPortableImport(reverseManifest, local)
    await expect(applyPortableImport(reverseManifest, reversePlan, local)).resolves.toMatchObject({
      outcome: 'applied',
    })
  })

  test('reports destination conflicts and unresolved capability or secret references before mutation', async () => {
    const manifest = await exportPortableState(source(), {
      exportId: 'export-conflict',
      createdAt,
      requiredCapabilities: ['execution'],
    })
    const conflictRecord = { ...manifest.records[0], contentDigest: `sha256:${'f'.repeat(64)}` }
    const conflict = new MemoryDestination('hosted-server', {
      records: [[recordKey(conflictRecord), conflictRecord]],
    })
    const conflictPlan = await planPortableImport(manifest, conflict)
    expect(conflictPlan.applicable).toBe(false)
    await expect(applyPortableImport(manifest, conflictPlan, conflict)).rejects.toMatchObject({
      code: 'PORTABLE_DESTINATION_CONFLICT',
    })
    expect(conflict.records.size).toBe(1)

    await expect(
      planPortableImport(
        manifest,
        new MemoryDestination('hosted-server', { capabilities: ['artifacts'] })
      )
    ).rejects.toMatchObject({ code: 'PORTABLE_CAPABILITY_MISSING' })
    const unresolved = await planPortableImport(
      manifest,
      new MemoryDestination('hosted-server', { secretProviders: ['env'] })
    )
    expect(unresolved).toMatchObject({ applicable: false })
    expect(unresolved.unresolvedSecretReferences).toEqual(manifest.secretReferences)
  })

  test('copies Artifact bytes only when explicit and rolls back state plus copied bytes on interruption', async () => {
    const body = new TextEncoder().encode('portable-artifact')
    const manifest = await exportPortableState(source(), {
      exportId: 'export-artifact',
      createdAt,
    })
    const sourceStore = new MemoryObjectStore([['artifacts/result.json', body]])
    const destinationStore = new MemoryObjectStore()
    const destination = new MemoryDestination('hosted-server', { failAfter: 1 })
    const options = {
      copyArtifacts: true,
      sourceObjectStore: sourceStore,
      destinationObjectStore: destinationStore,
    }
    const plan = await planPortableImport(manifest, destination, options)
    expect(plan.artifactActions[0].action).toBe('copy')
    await expect(applyPortableImport(manifest, plan, destination, options)).rejects.toThrow(
      'SIMULATED_IMPORT_INTERRUPTION'
    )
    expect(destination.records.size).toBe(0)
    expect(destination.rollbacks).toBe(1)
    expect(destinationStore.objects.size).toBe(0)
  })

  test('moves the supported record subset through real Local and Hosted Simple persistence ports', async () => {
    const sourceProvider = await sqliteProvider('local')
    await sourceProvider.transaction((transaction) =>
      transaction.put({
        namespace: 'agent-profiles',
        id: 'r-b202a70b1574c2ed7a487e52d4a554504890da05469df5542ff883893bce1caf',
        value: {
          profileId: 'prf_01JABCDEF0123456789ABCDEFG',
          displayName: 'Portable profile',
          ownership: { scope: 'system' },
          createdAt,
        },
      })
    )
    const projectState = {
      schemaVersion: 1,
      workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
      projectId: 'prj_01JABCDEF0123456789ABCDEFG',
      revision: 0,
      items: [],
      createdAt,
      updatedAt: createdAt,
    }
    await new SqliteProjectStateRepository(sourceProvider).create(projectState)
    const manifest = await exportPortableState(
      new PersistencePortableStateSource({
        persistence: sourceProvider,
        componentVersions: { contracts: '1.0.0' },
      }),
      { exportId: 'export-provider-ports', createdAt }
    )

    const destinationProvider = await sqliteProvider('hosted-simple')
    const destination = new PersistencePortableStateDestination({
      persistence: destinationProvider,
      capabilities: new Set(),
      secretProviders: new Set(),
    })
    const plan = await planPortableImport(manifest, destination)
    await expect(
      applyPortableImport(manifest, plan, destination, {}, () => createdAt)
    ).resolves.toMatchObject({ outcome: 'applied' })
    expect(
      await new SqliteVersionedCatalogRepository(destinationProvider).getAgentProfile(
        'prf_01JABCDEF0123456789ABCDEFG'
      )
    ).toMatchObject({
      profileId: 'prf_01JABCDEF0123456789ABCDEFG',
      displayName: 'Portable profile',
    })
    expect(
      await new SqliteProjectStateRepository(destinationProvider).getAtRevision(
        projectState.workspaceId,
        projectState.projectId,
        0
      )
    ).toEqual(projectState)
    await expect(planPortableImport(manifest, destination)).resolves.toMatchObject({
      applicable: true,
      records: [{ state: 'equivalent' }, { state: 'equivalent' }],
    })
    const replayPlan = await planPortableImport(manifest, destination)
    await expect(
      applyPortableImport(manifest, replayPlan, destination, {}, () => createdAt)
    ).resolves.toMatchObject({ outcome: 'replayed' })
  })
})

describe('deployment profile conformance reporting', () => {
  const ports = (persistence, objectStore, runtimeTransport) => ({
    persistence,
    'workflow-runtime': 'execution-lifecycle-v1',
    'object-store': objectStore,
    secrets: 'SecretsProvider-v1',
    'runtime-transport': runtimeTransport,
    'domain-contract': 'control-plane-v1',
    telemetry: 'content-redacted-v1',
  })

  test.each([false, true])(
    'drains started adapters before reporting failure (multiple=%s)',
    async (multiple) => {
      const gate = Promise.withResolvers()
      const entered = Promise.withResolvers()
      const firstFailure = new Error('LOCAL_FAILED')
      const siblingFailure = new Error('HOSTED_FAILED')
      let finished = false
      let siblingFinished = false
      const adapters = ['cloud', 'local', 'hosted-simple', 'hosted-server'].map((profile) => ({
        profile,
        ports: ports('fixture', 'fixture', 'fixture'),
        run: async () => {
          if (profile === 'local') throw firstFailure
          if (profile === 'hosted-simple') {
            entered.resolve()
            await gate.promise
            siblingFinished = true
            if (multiple) throw siblingFailure
          }
          return { logicalState: 'completed' }
        },
      }))
      const observed = runProfileConformance(adapters, [
        { caseId: 'failure-drain-v1', owner: 'persistence', input: {} },
      ])
        .then(
          (result) => ({ result }),
          (error) => ({ error })
        )
        .finally(() => {
          finished = true
        })
      try {
        await entered.promise
        await nextTurn()
        expect(finished).toBe(false)
        expect(siblingFinished).toBe(false)
      } finally {
        gate.resolve()
        await observed
      }
      const { error } = await observed
      expect(siblingFinished).toBe(true)
      if (multiple) {
        expect(error).toBeInstanceOf(AggregateError)
        expect(error.errors).toEqual([firstFailure, siblingFailure])
      } else {
        expect(error).toBe(firstFailure)
      }
    }
  )

  test('compares every required profile and attributes divergence to the exact port', async () => {
    const output = { logicalState: 'completed', executionId: 'exe_1' }
    const adapters = [
      ['cloud', ports('postgresql-neon', 'r2', 'remote-gateway')],
      ['local', ports('sqlite', 'filesystem', 'direct-local')],
      ['hosted-simple', ports('sqlite', 'filesystem', 'direct-local')],
      ['hosted-server', ports('postgresql', 's3-compatible', 'remote-gateway')],
    ].map(([profile, adapterPorts]) => ({
      profile,
      ports: adapterPorts,
      run: async () => output,
    }))
    const report = await runProfileConformance(adapters, [
      { caseId: 'command-idempotency-v1', owner: 'persistence', input: { commandId: 'cmd_1' } },
      { caseId: 'runtime-normalization-v1', owner: 'runtime-transport', input: {} },
    ])
    expect(report.conforms).toBe(true)
    expect(report.cases[0].profiles.map(({ adapter }) => adapter)).toEqual([
      'postgresql-neon',
      'sqlite',
      'sqlite',
      'postgresql',
    ])

    adapters[3].run = async () => ({ ...output, logicalState: 'failed' })
    const divergence = await runProfileConformance(adapters, [
      { caseId: 'runtime-normalization-v1', owner: 'runtime-transport', input: {} },
    ])
    expect(divergence).toMatchObject({ conforms: false })
    expect(divergence.cases[0].profiles[3]).toMatchObject({
      profile: 'hosted-server',
      adapter: 'remote-gateway',
      conforms: false,
    })
  })
})

function recordKey(record) {
  return `${record.category}:${record.logicalId}:${record.revision}`
}

function artifact(key, text) {
  const body = new TextEncoder().encode(text)
  return descriptor(key, body)
}

function descriptor(key, body, contentType, metadata = {}) {
  return {
    key,
    size: body.byteLength,
    sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    ...(contentType === undefined ? {} : { contentType }),
    metadata,
  }
}

function objectNotFound() {
  return Object.assign(new Error('not found'), { code: 'OBJECT_STORE_NOT_FOUND' })
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

async function sqliteProvider(profile) {
  const directory = await mkdtemp(join(tmpdir(), `profile-portability-${profile}-`))
  temporaryDirectories.push(directory)
  const provider = new SqlitePersistenceProvider({
    path: join(directory, 'state.sqlite'),
    profile,
  })
  temporaryProviders.push(provider)
  await provider.migrate()
  return provider
}

function portableReferenceRecords() {
  const parentContext = contextPackageSerializationFixtures.futurePi
  const childContext = derivePortableChildContext(parentContext)
  const parentPlan = createExecutionPlanTestFixture({ contextPackage: parentContext })
  const childPlan = deriveExecutionPlan(parentPlan, {
    correlation: parentPlan.correlation,
    contextPackage: childContext,
    constraints: parentPlan.constraints,
    runtimeRequirements: parentPlan.runtimeRequirements,
    outputContract: parentPlan.outputContract,
    compiledAt: '2026-08-30T13:00:00.000Z',
  })
  const authoring = {
    scope: {
      principalRef: 'service:portable-reference-test',
      workspaceId: childContext.projectState.workspaceId,
      projectId: childContext.projectState.projectId,
      operation: 'context.author',
      idempotencyKey: 'portable-authoring-edge-0001',
    },
    payloadHash: `sha256:${'d'.repeat(64)}`,
    contextPackage: {
      contextPackageId: childContext.contextPackageId,
      contentDigest: childContext.contentDigest,
    },
  }
  const validation = {
    scope: {
      callerPrincipalId: 'svc_portablereferencetest',
      workspaceId: childPlan.correlation.workspaceId,
      projectId: childPlan.correlation.projectId,
      operation: 'execution.validate',
      idempotencyKey: 'portable-validation-edge-0001',
    },
    commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
    requestId: childPlan.correlation.requestId,
    payloadHash: `sha256:${'e'.repeat(64)}`,
    executionPlan: {
      executionPlanId: childPlan.executionPlanId,
      contentDigest: childPlan.contentDigest,
    },
    recordedAt: createdAt,
  }
  return {
    parentContext,
    childContext,
    parentPlan,
    childPlan,
    contextPackages: [parentContext.contextPackageId, childContext.contextPackageId],
    executionPlans: [parentPlan.executionPlanId, childPlan.executionPlanId],
    records: [
      {
        category: 'context-package',
        logicalId: `context-packages/${parentContext.contextPackageId}`,
        revision: 0,
        value: parentContext,
      },
      {
        category: 'context-package',
        logicalId: `context-packages/${childContext.contextPackageId}`,
        revision: 0,
        value: childContext,
      },
      {
        category: 'context-authoring-command',
        logicalId: `context-authoring-commands/${contextAuthoringCommandKey(authoring.scope)}`,
        revision: 0,
        value: authoring,
      },
      {
        category: 'execution-plan',
        logicalId: `execution-plans/${parentPlan.executionPlanId}`,
        revision: 0,
        value: parentPlan,
      },
      {
        category: 'execution-plan',
        logicalId: `execution-plans/${childPlan.executionPlanId}`,
        revision: 0,
        value: childPlan,
      },
      {
        category: 'execution-validation-command',
        logicalId: `execution-validation-commands/${executionValidationCommandKey(validation.scope)}`,
        revision: 0,
        value: validation,
      },
    ],
  }
}

function derivePortableChildContext(parent) {
  return deriveContextPackage(parent, {
    objective: 'Portable child context',
    allowedStateItemIds: [],
    allowedArtifactIds: [],
    budgets: { maximumBytes: 512, maximumTokens: 128 },
    successCriteria: ['Preserve durable parent references'],
    returnContract: parent.returnContract,
    compiledAt: '2026-08-30T13:00:00.000Z',
  })
}

async function seedReferenceWindows(provider, contextPackageIds, executionPlanIds, instant) {
  const unreferencedSince = instant ?? '2025-01-02T03:04:05.000Z'
  await provider.transaction(async (transaction) => {
    for (const id of contextPackageIds) {
      const namespace = REFERENCE_RETENTION_NAMESPACES.contextPackages
      const recordId = sqliteRecordId(id)
      const existing = await transaction.get(namespace, recordId)
      await transaction.put({
        namespace,
        id: recordId,
        ...(existing === undefined ? {} : { expectedRevision: existing.revision }),
        value: { unreferencedSince },
      })
    }
    for (const id of executionPlanIds) {
      const namespace = REFERENCE_RETENTION_NAMESPACES.executionPlans
      const recordId = sqliteRecordId(id)
      const existing = await transaction.get(namespace, recordId)
      await transaction.put({
        namespace,
        id: recordId,
        ...(existing === undefined ? {} : { expectedRevision: existing.revision }),
        value: { unreferencedSince },
      })
    }
  })
}

async function referenceWindows(provider, contextPackageIds, executionPlanIds) {
  return provider.transaction(async (transaction) => ({
    contextPackages: await Promise.all(
      contextPackageIds.map(async (id) => {
        const record = await transaction.get(
          REFERENCE_RETENTION_NAMESPACES.contextPackages,
          sqliteRecordId(id)
        )
        return record?.value.unreferencedSince
      })
    ),
    executionPlans: await Promise.all(
      executionPlanIds.map(async (id) => {
        const record = await transaction.get(
          REFERENCE_RETENTION_NAMESPACES.executionPlans,
          sqliteRecordId(id)
        )
        return record?.value.unreferencedSince
      })
    ),
  }))
}

function sqliteRecordId(value) {
  return `r-${createHash('sha256').update(value).digest('hex')}`
}

function portableRecord(category, id, value) {
  const namespace = category === 'context-package' ? 'context-packages' : 'execution-plans'
  const identityField = category === 'context-package' ? 'contextPackageId' : 'executionPlanId'
  if (value[identityField] !== id) throw new Error('portable fixture identity mismatch')
  return { category, logicalId: `${namespace}/${id}`, revision: 0, value }
}

function rehashPortableRecordValue(value, idField, prefix) {
  const { [idField]: _id, contentDigest: _digest, ...content } = value
  const contentDigest = `sha256:${createHash('sha256')
    .update(canonicalJsonStringify(content))
    .digest('hex')}`
  const bytes = Buffer.from(contentDigest.slice(7, 39), 'hex')
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let bits = 0
  let accumulator = 0
  let identifier = ''
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      identifier += alphabet[(accumulator >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) identifier += alphabet[(accumulator << (5 - bits)) & 31]
  return {
    ...content,
    [idField]: `${prefix}_${identifier.slice(0, 26)}`,
    contentDigest,
  }
}

async function assertPortableImportRollback({
  record,
  exportId,
  storedContexts = [],
  storedPlans = [],
  contextWindowIds = [],
  planWindowIds = [],
  missingContextIds = [],
  missingPlanIds = [],
  expectedCode,
}) {
  const provider = await sqliteProvider('local')
  const contextRepository = new SqliteContextPackageRepository(provider)
  const planRepository = new SqliteExecutionPlanRepository(provider)
  for (const package_ of storedContexts) await contextRepository.put(package_)
  for (const plan of storedPlans) await planRepository.put(plan)
  const clock = '2025-04-05T06:07:08.000Z'
  await seedReferenceWindows(provider, contextWindowIds, planWindowIds, clock)

  const manifest = await exportPortableState(
    source({ records: [record], artifacts: [], secretReferences: [] }),
    { exportId, createdAt }
  )
  const destination = new PersistencePortableStateDestination({
    persistence: provider,
    capabilities: new Set(),
    secretProviders: new Set(),
  })
  const plan = await planPortableImport(manifest, destination)
  expect(plan.records).toHaveLength(1)
  expect(plan.records[0].state).toBe('missing')
  await expect(
    applyPortableImport(manifest, plan, destination, {}, () => createdAt)
  ).rejects.toMatchObject({ code: expectedCode })

  await provider.transaction(async (transaction) => {
    for (const id of missingContextIds) {
      expect(await transaction.get('context-packages', sqliteRecordId(id))).toBeUndefined()
    }
    for (const id of missingPlanIds) {
      expect(await transaction.get('execution-plans', sqliteRecordId(id))).toBeUndefined()
    }
    expect(await transaction.get('profile-migrations', exportId)).toBeUndefined()
    for (const id of contextWindowIds) {
      expect(
        (await transaction.get(REFERENCE_RETENTION_NAMESPACES.contextPackages, sqliteRecordId(id)))
          ?.value
      ).toEqual({ unreferencedSince: clock })
    }
    for (const id of planWindowIds) {
      expect(
        (await transaction.get(REFERENCE_RETENTION_NAMESPACES.executionPlans, sqliteRecordId(id)))
          ?.value
      ).toEqual({ unreferencedSince: clock })
    }
  })
}
