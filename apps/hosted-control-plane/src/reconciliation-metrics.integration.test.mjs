import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import { ContextPackageCompiler, contextPackageSerializationFixtures } from '@control-plane/context'
import {
  ExecutionPlanAcceptanceValidator,
  ExecutionPlanCompiler,
} from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import {
  PostgresCatalogRepository,
  PostgresCommandAcceptanceRepository,
  PostgresContextPackageRepository,
  PostgresExecutionPlanRepository,
  PostgresReconciliationCheckpointRepository,
  reconciliationCheckpoints,
} from '@control-plane/database'
import { createIsolatedTestDatabase } from '@control-plane/database/testing'
import {
  CommandInboxService,
  ExecutionReconciliationService,
  VersionedCatalog,
} from '@control-plane/domain'
import { createConsistencyMetricEmitter } from '@control-plane/telemetry'
import { ReconciliationScheduler } from '@control-plane/deployment'
import { integrationTestTimeout } from '@control-plane/database/testing'

const integrationEnabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const checkedAt = '2026-08-24T15:00:00.000Z'
const suffixes = ['V', 'W', 'X']
const correlation = {
  workspaceId: 'wsp_01DRZ3NDEKTSV4RRFFQ69G5FAV',
  projectId: 'prj_01DRZ3NDEKTSV4RRFFQ69G5FAV',
  taskId: 'tsk_01DRZ3NDEKTSV4RRFFQ69G5FAV',
  agentId: 'agt_01DRZ3NDEKTSV4RRFFQ69G5FAV',
}

async function seedAcceptancePlans(isolated, requestIds) {
  const base = contextPackageSerializationFixtures.futurePi
  const contextPackage = new ContextPackageCompiler(base.compiler.version).compile({
    objective: base.objective,
    projectState: {
      schemaVersion: 1,
      workspaceId: correlation.workspaceId,
      projectId: correlation.projectId,
      revision: base.projectState.revision,
      items: [],
      createdAt: checkedAt,
      updatedAt: checkedAt,
    },
    expectedProjectStateRevision: base.projectState.revision,
    candidates: [],
    artifacts: [],
    constraints: base.constraints,
    permissions: base.permissions,
    successCriteria: base.successCriteria,
    returnContract: base.returnContract,
    budgets: base.budgets,
    compiledAt: checkedAt,
  })
  const catalogInputs = createExecutionPlanTestFixtureInputs({ contextPackage })
  const catalogRepository = new PostgresCatalogRepository(isolated.application)
  const catalog = new VersionedCatalog(catalogRepository, catalogRepository)
  const { contentDigest: _contentDigest, ...skillManifest } = catalogInputs.skills[0].manifest
  await new PostgresContextPackageRepository(isolated.application).put(contextPackage)
  await catalog.createSkill({
    skillId: catalogInputs.skills[0].skillId,
    displayName: 'Hosted reconciliation metrics fixture',
    ownership: { scope: 'system' },
    provenance: { source: 'system-curated', ownerRef: 'system', trust: 'trusted' },
    createdAt: catalogInputs.skills[0].createdAt,
  })
  const skillDraft = await catalog.createSkillDraft({
    skillId: catalogInputs.skills[0].skillId,
    skillVersionId: catalogInputs.skills[0].skillVersionId,
    manifest: skillManifest,
    content: catalogInputs.skills[0].content,
    createdAt: catalogInputs.skills[0].createdAt,
  })
  const publishedSkill = await catalog.publishSkillVersion({
    skillVersionId: skillDraft.skillVersionId,
    expectedRevision: skillDraft.revision,
    publishedAt: checkedAt,
  })
  await catalog.createAgentProfile({
    profileId: catalogInputs.profile.profileId,
    displayName: 'Hosted reconciliation metrics fixture',
    ownership: { scope: 'system' },
    createdAt: catalogInputs.profile.createdAt,
  })
  const profileDraft = await catalog.createAgentProfileDraft({
    profileId: catalogInputs.profile.profileId,
    profileVersionId: catalogInputs.profile.profileVersionId,
    version: catalogInputs.profile.version,
    definition: {
      ...catalogInputs.profile.definition,
      skills: [
        {
          skillId: publishedSkill.skillId,
          skillVersionId: publishedSkill.skillVersionId,
          contentDigest: publishedSkill.manifest.contentDigest,
        },
      ],
    },
    createdAt: catalogInputs.profile.createdAt,
  })
  const publishedProfile = await catalog.publishAgentProfileVersion({
    profileVersionId: profileDraft.profileVersionId,
    expectedRevision: profileDraft.revision,
    publishedAt: checkedAt,
  })
  const plans = new PostgresExecutionPlanRepository(isolated.application)
  const compiledPlans = requestIds.map((requestId) => {
    const inputs = createExecutionPlanTestFixtureInputs({ contextPackage })
    inputs.correlation = { ...correlation, requestId }
    inputs.profile = publishedProfile
    inputs.skills = [publishedSkill]
    return new ExecutionPlanCompiler('1.0.0').compile(inputs)
  })
  for (const plan of compiledPlans) await plans.put(plan)
  return {
    plans: compiledPlans,
    validator: new ExecutionPlanAcceptanceValidator(plans, {
      catalog: { profiles: catalogRepository, skills: catalogRepository },
    }),
  }
}

describe.skipIf(!integrationEnabled)('reconciliation metrics against PostgreSQL rows', () => {
  let isolated

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    await isolated.migrate()
  }, integrationTestTimeout(60_000))

  afterAll(async () => {
    await isolated?.dispose()
  })

  test('scheduler-driven reconciliation emissions reflect the durable checkpoints written', async () => {
    // Seed real command-inbox and execution rows: checkpoint foreign keys require them.
    const identifiers = suffixes.map((suffix) => ({
      executionId: `exe_01DRZ3NDEKTSV4RRFFQ69G5FA${suffix}`,
      commandId: `cmd_01DRZ3NDEKTSV4RRFFQ69G5FA${suffix}`,
      requestId: `req_01DRZ3NDEKTSV4RRFFQ69G5FA${suffix}`,
    }))
    const { plans, validator } = await seedAcceptancePlans(
      isolated,
      identifiers.map(({ requestId }) => requestId)
    )
    let accepted = 0
    const inbox = new CommandInboxService({
      repository: new PostgresCommandAcceptanceRepository(isolated.application),
      executionIdFactory: () => identifiers[accepted].executionId,
      executionPlanValidator: validator,
    })
    const acceptedExecutions = []
    for (const [index, identifier] of identifiers.entries()) {
      const plan = plans[index]
      const { execution } = await inbox.acceptExecution({
        callerPrincipalId: 'svc_agent-hq',
        operation: 'execution.accept',
        commandId: identifier.commandId,
        requestId: identifier.requestId,
        idempotencyKey: `reconciliation-metrics-${identifier.executionId.slice(-1)}`,
        payloadHash: '8'.repeat(64),
        correlation,
        executionPlan: {
          executionPlanId: plan.executionPlanId,
          contentDigest: plan.contentDigest,
          schemaVersion: plan.schemaVersion,
        },
        receivedAt: '2026-08-24T14:00:00.000Z',
        retentionExpiresAt: '2099-01-01T00:00:00.000Z',
      })
      acceptedExecutions.push(execution)
      accepted += 1
    }

    const added = []
    const emitter = createConsistencyMetricEmitter(
      {
        add: (name, value, attributes) => added.push({ name, value, attributes }),
        record: () => undefined,
      },
      'hosted-control-plane'
    )
    const service = new ExecutionReconciliationService({
      repository: new PostgresReconciliationCheckpointRepository(isolated.application),
      source: {
        load: (executionId) => observation(executionId, acceptedExecutions),
        listCandidates: async () => identifiers.map(({ executionId }) => executionId),
      },
      effects: {
        markReconciliationRequired: async () => undefined,
        resumeWorkflow: async () => undefined,
        applyRuntimeTerminal: async () => undefined,
        replayEvents: async () => undefined,
      },
      policy: { staleAfterMs: 60_000 },
      metrics: emitter,
    })

    // The first pass runs through the composition scheduler shape: one emission per
    // durable checkpoint, never overlapping.
    const scheduler = new ReconciliationScheduler({
      service,
      intervalMs: 10,
      batchLimit: 10,
      onBatchError: () => {
        throw new Error('UNEXPECTED_RECONCILIATION_BATCH_FAILURE')
      },
    })
    scheduler.start()
    await waitFor(
      () => countOf(added, 'execution.reconciliation.count') === 3 || undefined,
      'FIRST_PASS'
    )
    await scheduler.close()

    const firstPassReasons = added
      .filter(({ name }) => name === 'execution.reconciliation.count')
      .map(({ attributes }) => attributes.reason)
      .toSorted()
    expect(firstPassReasons).toEqual(['accepted_unstarted', 'healthy', 'runtime_disconnected'])
    expect(added.filter(({ name }) => name === 'execution.manual_intervention.count')).toEqual([
      {
        name: 'execution.manual_intervention.count',
        value: 1,
        attributes: { 'service.name': 'hosted-control-plane', reason: 'runtime_disconnected' },
      },
    ])

    const rows = await isolated.application.select().from(reconciliationCheckpoints)
    expect(rows).toHaveLength(3)
    expect(rows.map(({ reason }) => reason).toSorted()).toEqual([
      'accepted_unstarted',
      'healthy',
      'runtime_disconnected',
    ])

    // A second pass over identical durable facts re-observes the same rows: no new
    // rows and the emitted outcome label flips from created to observed.
    added.length = 0
    expect(await service.runBatch({ limit: 10 })).toMatchObject({ examined: 3, reconciled: 0 })
    expect(countOf(added, 'execution.reconciliation.count')).toBe(3)
    expect(
      added
        .filter(({ name }) => name === 'execution.reconciliation.count')
        .every(({ attributes }) => attributes.outcome === 'observed')
    ).toBe(true)
    expect(countOf(added, 'execution.manual_intervention.count')).toBe(1)
    expect(await isolated.application.select().from(reconciliationCheckpoints)).toHaveLength(3)
  })
})

function observation(executionId, acceptedExecutions) {
  const execution = acceptedExecutions.find((candidate) => candidate.executionId === executionId)
  const commandId = executionId.replace('exe_', 'cmd_')
  const lastSuffix = executionId.slice(-1)
  const base = {
    executionId,
    checkedAt,
    command: { status: 'accepted', commandId },
    execution: { state: 'accepted', updatedAt: execution.updatedAt },
    workflow: { status: 'missing' },
    runtime: { status: 'unknown', observedAt: checkedAt },
    delivery: { pendingCount: 0 },
  }
  if (lastSuffix === 'W') {
    base.execution = { state: 'running', updatedAt: execution.updatedAt }
    base.runtime = { status: 'disconnected', observedAt: checkedAt }
  }
  if (lastSuffix === 'X') {
    base.execution = { state: 'running', updatedAt: checkedAt }
    base.command = { status: 'processing', commandId }
  }
  return base
}

function countOf(emissions, name) {
  return emissions.filter((emission) => emission.name === name).length
}

async function waitFor(predicate, label) {
  const started = Date.now()
  while (Date.now() - started < 10_000) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`RECONCILIATION_METRICS_INTEGRATION_TIMEOUT_${label}`)
}
