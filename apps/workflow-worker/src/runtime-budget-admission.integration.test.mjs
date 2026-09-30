import { afterAll, beforeAll, expect, test as runTest } from 'bun:test'
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
} from '@control-plane/database'
import { createIsolatedTestDatabase } from '@control-plane/database/testing'
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
let fixturePlanInputs
let workerConfiguration
let testFailure
const compositions = []

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

  afterAll(async () => {
    const cleanupErrors = []
    for (const composition of compositions.toReversed()) {
      try {
        await composition.connection.close()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      await isolated?.dispose()
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        testFailure === undefined ? cleanupErrors : [testFailure, ...cleanupErrors],
        'ISOLATED_TEST_DATABASE_DISPOSAL_FAILED'
      )
    }
  }, 30_000)
}

runTest.skipIf(!enabled)(
  'actual Cloud worker composition performs read-only runtime admission from Postgres receipts',
  async () => {
    testFailure = undefined
    const callbacks = { dispatch: [], interaction: [], graph: [] }
    const runtime = {
      async dispatch(input) {
        callbacks.dispatch.push(input)
        return { outcome: 'completed', resultReference: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV' }
      },
      async applyInteraction(input) {
        callbacks.interaction.push(input)
        return { outcome: 'completed', resultReference: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV' }
      },
      async cancel(input) {
        callbacks.cancel = [...(callbacks.cancel ?? []), input]
      },
      async cleanup(input) {
        callbacks.cleanup = [...(callbacks.cleanup ?? []), input]
      },
    }
    const graph = {
      async runGraphSegment(input) {
        callbacks.graph.push(input)
        return { outcome: 'completed' }
      },
      async resumeGraphSegment(input) {
        callbacks.graph.push(input)
        return { outcome: 'completed' }
      },
      async continueGraphSegment(input) {
        callbacks.graph.push(input)
        return { outcome: 'completed' }
      },
      async cancelGraphSegment(input) {
        callbacks.graph.push(input)
      },
    }

    try {
      function openComposition() {
        const composition = createManagedCloudWorkflowWorkerComposition(
          workerConfiguration,
          runtime,
          graph,
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
        compositions.push(composition)
        return composition
      }

      const firstComposition = openComposition()
      // The worker command service deliberately cannot mint execution IDs. Seed owners through
      // its real acceptance repository and the same real plan/catalog validator used in production.
      const acceptanceService = new CommandInboxService({
        repository: firstComposition.commands.repository,
        executionIdFactory: () => nextId('exe'),
        executionPlanValidator: new ExecutionPlanAcceptanceValidator(fixturePlans, {
          catalog: {
            profiles: fixtureCatalogRepository,
            skills: fixtureCatalogRepository,
          },
        }),
        now: () => acceptedAt,
      })
      const lifecycle = new ExecutionLifecycleService(
        new PostgresExecutionRepository(firstComposition.connection.database)
      )

      let planSequence = 0
      async function seedOwner() {
        planSequence += 1
        let executionPlan = fixtureBasePlan
        if (planSequence > 1) {
          const inputs = structuredClone(fixturePlanInputs)
          inputs.correlation = {
            ...inputs.correlation,
            taskId: nextId('tsk'),
            requestId: nextId('req'),
          }
          inputs.compiledAt = new Date(Date.parse(acceptedAt) + planSequence * 1_000).toISOString()
          executionPlan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
          await fixturePlans.put(executionPlan)
        }

        const accepted = await acceptanceService.acceptExecution(commandInput(executionPlan))
        const attemptId = nextId('att')
        const attempt = await lifecycle.createAttempt({
          executionId: accepted.execution.executionId,
          attemptId,
          expectedExecutionVersion: accepted.execution.version,
          queuedAt: new Date(Date.parse(accepted.execution.updatedAt) + 1_000).toISOString(),
          deadlineAt: accepted.execution.deadlineAt,
        })
        return { accepted, attempt, executionPlan }
      }

      async function expectDeniedWithoutChanges(owner, composition = firstComposition) {
        const before = await snapshotAdmission(
          firstComposition.connection.database,
          owner.accepted.execution.executionId
        )
        const dispatchCount = callbacks.dispatch.length
        await expect(
          composition.activities.dispatch({
            executionId: owner.accepted.execution.executionId,
            attemptId: owner.attempt.attemptId,
            executionPlan: owner.executionPlan,
            effectKey: `runtime-dispatch:${owner.accepted.execution.executionId}`,
          })
        ).rejects.toMatchObject({ code: 'RUNTIME_BUDGET_ADMISSION_DENIED' })
        expect(callbacks.dispatch).toHaveLength(dispatchCount)
        expect(
          await snapshotAdmission(
            firstComposition.connection.database,
            owner.accepted.execution.executionId
          )
        ).toEqual(before)
      }

      const allowed = await seedOwner()
      const initialAllowedSnapshot = await snapshotAdmission(
        firstComposition.connection.database,
        allowed.accepted.execution.executionId
      )
      await firstComposition.activities.dispatch({
        executionId: allowed.accepted.execution.executionId,
        attemptId: allowed.attempt.attemptId,
        executionPlan: allowed.executionPlan,
        effectKey: `runtime-dispatch:${allowed.accepted.execution.executionId}:first`,
      })
      expect(callbacks.dispatch).toHaveLength(1)
      expect(
        await snapshotAdmission(
          firstComposition.connection.database,
          allowed.accepted.execution.executionId
        )
      ).toEqual(initialAllowedSnapshot)

      const rebuiltComposition = openComposition()
      await rebuiltComposition.activities.dispatch({
        executionId: allowed.accepted.execution.executionId,
        attemptId: allowed.attempt.attemptId,
        executionPlan: allowed.executionPlan,
        effectKey: `runtime-dispatch:${allowed.accepted.execution.executionId}:replay`,
      })
      expect(callbacks.dispatch).toHaveLength(2)
      expect(
        await snapshotAdmission(
          firstComposition.connection.database,
          allowed.accepted.execution.executionId
        )
      ).toEqual(initialAllowedSnapshot)

      const missingBudget = await seedOwner()
      await firstComposition.connection.database.$client.unsafe(
        'delete from usage_budget_states where execution_id = $1',
        [missingBudget.accepted.execution.executionId]
      )
      await expectDeniedWithoutChanges(missingBudget)

      const missingReceipt = await seedOwner()
      const [missingReceiptRow] = await firstComposition.connection.database.$client.unsafe(
        'select * from usage_operation_receipts where execution_id = $1',
        [missingReceipt.accepted.execution.executionId]
      )
      expect(missingReceiptRow).toBeDefined()
      await firstComposition.connection.database.$client.unsafe(
        'delete from usage_operation_receipts where workspace_id = $1 and idempotency_key = $2',
        [missingReceiptRow.workspace_id, missingReceiptRow.idempotency_key]
      )
      await expectDeniedWithoutChanges(missingReceipt)

      const corruptReceipt = await seedOwner()
      const [corruptReceiptRow] = await firstComposition.connection.database.$client.unsafe(
        'select * from usage_operation_receipts where execution_id = $1',
        [corruptReceipt.accepted.execution.executionId]
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
      await expectDeniedWithoutChanges(corruptReceipt)

      const interactionCount = callbacks.interaction.length
      const graphCount = callbacks.graph.length
      const identity = corruptReceipt.accepted.execution
      await expect(
        firstComposition.activities.applyInteraction({
          executionId: identity.executionId,
          attemptId: corruptReceipt.attempt.attemptId,
          interactionId: nextId('int'),
          responseId: nextId('rsp'),
          action: 'approve',
          effectKey: `interaction:${identity.executionId}`,
        })
      ).rejects.toMatchObject({ code: 'RUNTIME_BUDGET_ADMISSION_DENIED' })
      await expect(
        firstComposition.activities.runGraphSegment({
          executionId: identity.executionId,
          attemptId: corruptReceipt.attempt.attemptId,
          workspaceId: identity.correlation.workspaceId,
          workflowId: nextId('wfl'),
          graph: {
            graphDefinitionId: 'manager-graph',
            graphVersion: '1.0.0',
            contentDigest: `sha256:${'a'.repeat(64)}`,
          },
          threadId: 'thread-runtime-admission',
          input: { objective: 'integration admission denial' },
          idempotencyKey: `graph:${identity.executionId}`,
        })
      ).rejects.toMatchObject({ code: 'RUNTIME_BUDGET_ADMISSION_DENIED' })
      expect(callbacks.interaction).toHaveLength(interactionCount)
      expect(callbacks.graph).toHaveLength(graphCount)

      const settledBudget = await seedOwner()
      const ledger = new DurableUsageLedger({
        store: new PostgresDurableUsageStore(firstComposition.connection.database),
      })
      await ledger.finalizeBudget({
        workspaceId: settledBudget.accepted.execution.correlation.workspaceId,
        executionId: settledBudget.accepted.execution.executionId,
        source: {
          sourceId: 'runtime-admission-settlement-fixture',
          idempotencyKey: `runtime-admission-settlement:${settledBudget.accepted.execution.executionId}`,
        },
      })
      await expectDeniedWithoutChanges(settledBudget)

      // Cancellation and cleanup remain available after allowance finalization; these lifecycle
      // operations do not invoke the runtime spend-admission preflight.
      const settledIdentity = settledBudget.accepted.execution
      await firstComposition.activities.cancelActive({
        executionId: settledIdentity.executionId,
        attemptId: settledBudget.attempt.attemptId,
        effectKey: `cancel:${settledIdentity.executionId}`,
        reason: 'user_request',
      })
      await firstComposition.activities.cleanup({
        executionId: settledIdentity.executionId,
        attemptId: settledBudget.attempt.attemptId,
        effectKey: `cleanup:${settledIdentity.executionId}`,
      })
      expect(callbacks.cancel).toHaveLength(1)
      expect(callbacks.cleanup).toHaveLength(1)
    } catch (error) {
      testFailure = error
      throw error
    }
  },
  30_000
)
