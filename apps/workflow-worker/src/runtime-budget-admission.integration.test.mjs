import { afterAll, afterEach, beforeAll, beforeEach, expect, test as runTest } from 'bun:test'
import process from 'node:process'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { loadDatabaseCredentials } from '@control-plane/config'
import {
  CommandInboxService,
  ExecutionLifecycleService,
  VersionedCatalog,
} from '@control-plane/domain'
import {
  ExecutionPlanAcceptanceValidator,
  ExecutionPlanCompiler,
} from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import {
  PostgresCatalogRepository,
  PostgresContextPackageRepository,
  PostgresDurableUsageStore,
  PostgresExecutionPlanRepository,
  PostgresExecutionRepository,
  PostgresGraphDefinitionRepository,
} from '@control-plane/database'
import { createIsolatedTestDatabase } from '@control-plane/database/testing'
import {
  GraphDefinitionCatalog,
  GraphDefinitionExecutionAuthority,
} from '@control-plane/orchestration'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { createManagedCloudWorkflowWorkerComposition } from './cloud-composition.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const acceptedAt = '2026-09-20T10:00:00.000Z'
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
let fixtureSequence = 0
let isolated
let fixtureCatalogRepository
let fixturePlans
let fixtureBasePlan
let fixtureGraphSelection
let fixtureGraphAuthority
let fixturePlanInputs
let workerConfiguration
let testFailure
let currentFixture
let fixturePlanSequence = 0

function nextId(prefix) {
  fixtureSequence += 1
  const tail =
    alphabet[Math.floor(fixtureSequence / alphabet.length)] +
    alphabet[fixtureSequence % alphabet.length]
  return `${prefix}_01ARZ3NDEKTSV4RRFFQ69G5F${tail}`
}

function commandInput(executionPlan) {
  const sequence = fixtureSequence + 1
  const correlation = executionPlan.correlation
  return {
    callerPrincipalId: 'svc_runtime-admission-integration',
    operation: 'execution.accept',
    commandId: nextId('cmd'),
    requestId: correlation.requestId,
    idempotencyKey: `runtime-admission-${sequence}`,
    payloadHash: String(sequence).padStart(64, 'a'),
    correlation: {
      workspaceId: correlation.workspaceId,
      projectId: correlation.projectId,
      taskId: correlation.taskId,
      agentId: correlation.agentId,
    },
    executionPlan: {
      executionPlanId: executionPlan.executionPlanId,
      contentDigest: executionPlan.contentDigest,
      schemaVersion: executionPlan.schemaVersion,
    },
    receivedAt: acceptedAt,
    retentionExpiresAt: '2026-10-20T10:00:00.000Z',
  }
}

async function snapshotAdmission(database, executionId) {
  const query = (table, order = '') =>
    database.$client.unsafe(`select * from ${table} where execution_id = $1${order}`, [executionId])
  const [commandRows, executionRows, attemptRows, budgetRows, entries, receipts] =
    await Promise.all([
      query('command_inbox'),
      query('executions'),
      query('execution_attempts', ' order by sequence'),
      query('usage_budget_states'),
      query('usage_ledger_entries', ' order by sequence'),
      query('usage_operation_receipts', ' order by idempotency_key'),
    ])
  return { commandRows, executionRows, attemptRows, budgetRows, entries, receipts }
}

async function seedCatalogAndPlan(database) {
  const inputs = createExecutionPlanTestFixtureInputs()
  inputs.profile.definition.skills = []
  inputs.skills = []

  const catalogRepository = new PostgresCatalogRepository(database)
  const catalog = new VersionedCatalog(catalogRepository, catalogRepository)
  await catalog.createAgentProfile({
    profileId: inputs.profile.profileId,
    displayName: 'Runtime budget admission fixture',
    ownership: { scope: 'system' },
    createdAt: inputs.profile.createdAt,
  })
  const draft = await catalog.createAgentProfileDraft({
    profileId: inputs.profile.profileId,
    profileVersionId: inputs.profile.profileVersionId,
    version: inputs.profile.version,
    definition: inputs.profile.definition,
    createdAt: inputs.profile.createdAt,
  })
  inputs.profile = await catalog.publishAgentProfileVersion({
    profileVersionId: draft.profileVersionId,
    expectedRevision: draft.revision,
    publishedAt: acceptedAt,
  })
  await new PostgresContextPackageRepository(database).put(
    contextPackageSerializationFixtures.futurePi
  )

  const plans = new PostgresExecutionPlanRepository(database)
  const basePlan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
  await plans.put(basePlan)
  return { catalogRepository, plans, basePlan, inputs }
}

function openComposition() {
  const composition = createManagedCloudWorkflowWorkerComposition(
    workerConfiguration,
    currentFixture.runtime,
    currentFixture.graph,
    () => ({
      database: isolated.application,
      check: async () => {
        await isolated.application.$client.unsafe('select 1')
      },
      // The isolated database owns this shared test connection and closes it after all
      // rebuilt compositions have been released.
      close: async () => {},
    })
  )
  currentFixture.compositions.push(composition)
  return composition
}

async function seedOwner(graph) {
  fixturePlanSequence += 1
  let executionPlan = fixtureBasePlan
  if (fixturePlanSequence > 1 || graph) {
    const inputs = structuredClone(fixturePlanInputs)
    inputs.correlation = {
      ...inputs.correlation,
      taskId: nextId('tsk'),
      requestId: nextId('req'),
    }
    if (graph) inputs.graph = graph
    inputs.compiledAt = new Date(Date.parse(acceptedAt) + fixturePlanSequence * 1_000).toISOString()
    executionPlan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
    await fixturePlans.put(executionPlan)
  }

  const accepted = await currentFixture.acceptanceService.acceptExecution(
    commandInput(executionPlan)
  )
  const attemptId = nextId('att')
  const attempt = await currentFixture.lifecycle.createAttempt({
    executionId: accepted.execution.executionId,
    attemptId,
    expectedExecutionVersion: accepted.execution.version,
    queuedAt: new Date(Date.parse(accepted.execution.updatedAt) + 1_000).toISOString(),
    deadlineAt: accepted.execution.deadlineAt,
  })
  return { accepted, attempt, executionPlan }
}

async function expectDeniedWithoutChanges(owner, composition = currentFixture.firstComposition) {
  const database = currentFixture.firstComposition.connection.database
  const before = await snapshotAdmission(database, owner.accepted.execution.executionId)
  const dispatchCount = currentFixture.callbacks.dispatch.length
  await expect(
    composition.activities.dispatch({
      executionId: owner.accepted.execution.executionId,
      attemptId: owner.attempt.attemptId,
      executionPlan: owner.executionPlan,
      effectKey: `runtime-dispatch:${owner.accepted.execution.executionId}`,
    })
  ).rejects.toMatchObject({ code: 'RUNTIME_BUDGET_ADMISSION_DENIED' })
  expect(currentFixture.callbacks.dispatch).toHaveLength(dispatchCount)
  expect(await snapshotAdmission(database, owner.accepted.execution.executionId)).toEqual(before)
}

async function closeCompositions(compositions) {
  const cleanupErrors = []
  for (const composition of compositions.toReversed()) {
    try {
      await composition.connection.close()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  compositions.length = 0
  return cleanupErrors
}

function registerAdmissionTest(name, body) {
  runTest.skipIf(!enabled)(
    name,
    async () => {
      try {
        await body(currentFixture)
      } catch (error) {
        testFailure = error
        throw error
      }
    },
    30_000
  )
}

if (enabled) {
  beforeAll(async () => {
    const credentials = {
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    }

    try {
      isolated = await createIsolatedTestDatabase(credentials)
      await isolated.migrate()
      const seeded = await seedCatalogAndPlan(isolated.application)
      fixtureCatalogRepository = seeded.catalogRepository
      fixturePlans = seeded.plans
      fixtureBasePlan = seeded.basePlan
      fixturePlanInputs = seeded.inputs
      const graphs = new PostgresGraphDefinitionRepository(
        isolated.application,
        seeded.inputs.correlation.workspaceId
      )
      const graph = await new GraphDefinitionCatalog(graphs).publish({
        definition: {
          graphDefinitionId: 'budget-admission-graph',
          graphVersion: '1.0.0',
          schemaVersion: 1,
          nodes: [{ node: 'work', operation: { kind: 'runtime', name: 'execute' } }],
          edges: [
            { from: '__start__', to: 'work' },
            { from: 'work', to: '__end__' },
          ],
          schemas: {
            input: 'schema://budget/input/v1',
            state: 'schema://budget/state/v1',
            output: 'schema://budget/output/v1',
          },
          requiredCapabilities: ['runtime.invoke'],
          compatibility: {
            contractMajorVersions: [1],
            compilerVersions: ['1.0.0'],
            adapterVersions: ['1.4.12'],
          },
        },
        publishedAt: acceptedAt,
      })
      fixtureGraphSelection = {
        reference: graph.reference,
        input: { objective: 'integration admission denial' },
      }
      fixtureGraphAuthority = new GraphDefinitionExecutionAuthority({
        repository: (workspaceId) =>
          new PostgresGraphDefinitionRepository(isolated.application, workspaceId),
        environment: {
          capabilities: ['runtime.invoke'],
          contractMajorVersion: 1,
          compilerVersion: '1.0.0',
          adapterVersion: '1.4.12',
        },
        validateDefinitionAndInput: (_definition, input) =>
          Object.keys(input).length === 1 && input.objective === 'integration admission denial',
      })

      const databaseUrl = new URL(credentials.application.url)
      databaseUrl.pathname = `/${isolated.name}`
      workerConfiguration = {
        service: 'workflow-worker',
        database: { ...credentials.application, url: databaseUrl.toString() },
        restate: { role: 'endpoint', requestIdentityPublicKey: 'test-only-public-key' },
        secretEncryptionKey: 'test-only-secret-encryption-key',
      }
    } catch (error) {
      if (isolated !== undefined) {
        try {
          await isolated.dispose()
        } catch (cleanupError) {
          isolated = undefined
          const setupFailure = new AggregateError(
            [error, cleanupError],
            'ISOLATED_TEST_DATABASE_SETUP_FAILED',
            {
              cause: error,
            }
          )
          throw setupFailure
        }
        isolated = undefined
      }
      throw error
    }
  }, 60_000)

  beforeEach(async () => {
    testFailure = undefined
    currentFixture = {
      callbacks: { dispatch: [], interaction: [], graph: [] },
      compositions: [],
    }
    currentFixture.runtime = {
      async dispatch(input) {
        currentFixture.callbacks.dispatch.push(input)
        return { outcome: 'completed', resultReference: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV' }
      },
      async applyInteraction(input) {
        currentFixture.callbacks.interaction.push(input)
        return { outcome: 'completed', resultReference: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV' }
      },
      async cancel(input) {
        currentFixture.callbacks.cancel = [...(currentFixture.callbacks.cancel ?? []), input]
      },
      async cleanup(input) {
        currentFixture.callbacks.cleanup = [...(currentFixture.callbacks.cleanup ?? []), input]
      },
    }
    currentFixture.graph = {
      async runGraphSegment(input) {
        currentFixture.callbacks.graph.push(input)
        return { outcome: 'completed' }
      },
      async resumeGraphSegment(input) {
        currentFixture.callbacks.graph.push(input)
        return { outcome: 'completed' }
      },
      async continueGraphSegment(input) {
        currentFixture.callbacks.graph.push(input)
        return { outcome: 'completed' }
      },
      async cancelGraphSegment(input) {
        currentFixture.callbacks.graph.push(input)
      },
    }

    try {
      currentFixture.firstComposition = openComposition()
      currentFixture.acceptanceService = new CommandInboxService({
        repository: currentFixture.firstComposition.commands.repository,
        executionIdFactory: () => nextId('exe'),
        executionPlanValidator: new ExecutionPlanAcceptanceValidator(fixturePlans, {
          graphs: fixtureGraphAuthority,
          catalog: {
            profiles: fixtureCatalogRepository,
            skills: fixtureCatalogRepository,
          },
        }),
        now: () => acceptedAt,
      })
      currentFixture.lifecycle = new ExecutionLifecycleService(
        new PostgresExecutionRepository(currentFixture.firstComposition.connection.database)
      )
      currentFixture.owner = await seedOwner()
    } catch (error) {
      testFailure = error
      const cleanupErrors = await closeCompositions(currentFixture.compositions)
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          'ISOLATED_TEST_COMPOSITION_DISPOSAL_FAILED',
          { cause: error }
        )
      }
      throw error
    }
  }, 60_000)

  afterEach(async () => {
    if (currentFixture === undefined) return
    const cleanupErrors = await closeCompositions(currentFixture.compositions)
    currentFixture = undefined
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        testFailure === undefined ? cleanupErrors : [testFailure, ...cleanupErrors],
        'ISOLATED_TEST_COMPOSITION_DISPOSAL_FAILED'
      )
    }
  }, 30_000)

  afterAll(async () => {
    try {
      await isolated?.dispose()
    } catch (error) {
      const disposalFailure = new AggregateError(
        testFailure === undefined ? [error] : [testFailure, error],
        'ISOLATED_TEST_DATABASE_DISPOSAL_FAILED',
        { cause: error }
      )
      throw disposalFailure
    }
  }, 30_000)
}

registerAdmissionTest(
  'actual Cloud worker composition allows read-only runtime admission and replays across rebuilds',
  async ({ callbacks, firstComposition, owner }) => {
    const database = firstComposition.connection.database
    const initialSnapshot = await snapshotAdmission(database, owner.accepted.execution.executionId)
    await firstComposition.activities.dispatch({
      executionId: owner.accepted.execution.executionId,
      attemptId: owner.attempt.attemptId,
      executionPlan: owner.executionPlan,
      effectKey: `runtime-dispatch:${owner.accepted.execution.executionId}:first`,
    })
    expect(callbacks.dispatch).toHaveLength(1)
    expect(await snapshotAdmission(database, owner.accepted.execution.executionId)).toEqual(
      initialSnapshot
    )

    const rebuiltComposition = openComposition()
    await rebuiltComposition.activities.dispatch({
      executionId: owner.accepted.execution.executionId,
      attemptId: owner.attempt.attemptId,
      executionPlan: owner.executionPlan,
      effectKey: `runtime-dispatch:${owner.accepted.execution.executionId}:replay`,
    })
    expect(callbacks.dispatch).toHaveLength(2)
    expect(await snapshotAdmission(database, owner.accepted.execution.executionId)).toEqual(
      initialSnapshot
    )
  }
)

registerAdmissionTest(
  'actual Cloud worker composition denies dispatch when the usage budget state is missing',
  async ({ firstComposition, owner }) => {
    await firstComposition.connection.database.$client.unsafe(
      'delete from usage_budget_states where execution_id = $1',
      [owner.accepted.execution.executionId]
    )
    await expectDeniedWithoutChanges(owner)
  }
)

registerAdmissionTest(
  'actual Cloud worker composition denies dispatch when the usage receipt is missing',
  async ({ firstComposition, owner }) => {
    const [missingReceiptRow] = await firstComposition.connection.database.$client.unsafe(
      'select * from usage_operation_receipts where execution_id = $1',
      [owner.accepted.execution.executionId]
    )
    expect(missingReceiptRow).toBeDefined()
    await firstComposition.connection.database.$client.unsafe(
      'delete from usage_operation_receipts where workspace_id = $1 and idempotency_key = $2',
      [missingReceiptRow.workspace_id, missingReceiptRow.idempotency_key]
    )
    await expectDeniedWithoutChanges(owner)
  }
)

registerAdmissionTest(
  'actual Cloud worker composition denies dispatch for a corrupt usage receipt and blocks interactions and graphs',
  async ({ callbacks, firstComposition, owner }) => {
    owner = await seedOwner(fixtureGraphSelection)
    const [corruptReceiptRow] = await firstComposition.connection.database.$client.unsafe(
      'select * from usage_operation_receipts where execution_id = $1',
      [owner.accepted.execution.executionId]
    )
    expect(corruptReceiptRow).toBeDefined()
    const corruptFingerprint = `sha256:${'f'.repeat(64)}`
    await firstComposition.connection.database.$client.unsafe(
      'update usage_operation_receipts set fingerprint = $3, receipt = $4::jsonb where workspace_id = $1 and idempotency_key = $2',
      [
        corruptReceiptRow.workspace_id,
        corruptReceiptRow.idempotency_key,
        corruptFingerprint,
        JSON.stringify({ ...corruptReceiptRow.receipt, fingerprint: corruptFingerprint }),
      ]
    )
    await expectDeniedWithoutChanges(owner)

    const interactionCount = callbacks.interaction.length
    const graphCount = callbacks.graph.length
    const identity = owner.accepted.execution
    await expect(
      firstComposition.activities.applyInteraction({
        executionId: identity.executionId,
        attemptId: owner.attempt.attemptId,
        interactionId: nextId('int'),
        responseId: nextId('rsp'),
        action: 'approve',
        effectKey: `interaction:${identity.executionId}`,
      })
    ).rejects.toMatchObject({ code: 'RUNTIME_BUDGET_ADMISSION_DENIED' })
    const beforeGraph = await snapshotAdmission(
      firstComposition.connection.database,
      identity.executionId
    )
    await expect(
      firstComposition.activities.runGraphSegment({
        executionId: identity.executionId,
        attemptId: owner.attempt.attemptId,
        workspaceId: identity.correlation.workspaceId,
        workflowId: `wfl_${identity.executionId.slice(4)}`,
        graph: owner.executionPlan.graph.reference,
        threadId: `graph:${identity.executionId}`,
        input: owner.executionPlan.graph.input,
        idempotencyKey: `graph:${identity.executionId}`,
      })
    ).rejects.toMatchObject({ code: 'RUNTIME_BUDGET_ADMISSION_DENIED' })
    expect(callbacks.interaction).toHaveLength(interactionCount)
    expect(callbacks.graph).toHaveLength(graphCount)
    expect(
      await snapshotAdmission(firstComposition.connection.database, identity.executionId)
    ).toEqual(beforeGraph)
  }
)

registerAdmissionTest(
  'actual Cloud worker composition denies settled budgets while preserving cancellation and cleanup',
  async ({ callbacks, firstComposition, owner }) => {
    const ledger = new DurableUsageLedger({
      store: new PostgresDurableUsageStore(firstComposition.connection.database),
    })
    await ledger.finalizeBudget({
      workspaceId: owner.accepted.execution.correlation.workspaceId,
      executionId: owner.accepted.execution.executionId,
      source: {
        sourceId: 'runtime-admission-settlement-fixture',
        idempotencyKey: `runtime-admission-settlement:${owner.accepted.execution.executionId}`,
      },
    })
    await expectDeniedWithoutChanges(owner)

    // Cancellation and cleanup remain available after allowance finalization; these lifecycle
    // operations do not invoke the runtime spend-admission preflight.
    const identity = owner.accepted.execution
    await firstComposition.activities.cancelActive({
      executionId: identity.executionId,
      attemptId: owner.attempt.attemptId,
      effectKey: `cancel:${identity.executionId}`,
      reason: 'user_request',
    })
    await firstComposition.activities.cleanup({
      executionId: identity.executionId,
      attemptId: owner.attempt.attemptId,
      effectKey: `cleanup:${identity.executionId}`,
    })
    expect(callbacks.cancel).toHaveLength(1)
    expect(callbacks.cleanup).toHaveLength(1)
  }
)
