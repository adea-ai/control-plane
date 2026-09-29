import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import { ContextPackageCompiler, contextPackageSerializationFixtures } from '@control-plane/context'
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
  PostgresCommandAcceptanceRepository,
  PostgresContextPackageRepository,
  PostgresExecutionRepository,
  PostgresExecutionPlanRepository,
  PostgresRuntimeCommandRepository,
  PostgresRuntimeConnectionRepository,
  reconciliationCheckpoints,
} from '@control-plane/database'
import { createIsolatedTestDatabase } from '@control-plane/database/testing'
import { HostedServerControlPlaneComposition } from './composition.ts'

const integrationEnabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const now = '2026-09-01T12:00:00.000Z'
const correlation = {
  workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
}
const requestId = 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const executionId = 'exe_01DRZ3NDEKTSV4RRFFQ69G5FAV'
const commandId = 'cmd_01DRZ3NDEKTSV4RRFFQ69G5FAV'
const attemptId = 'att_01DRZ3NDEKTSV4RRFFQ69G5FAV'
const resultReference = 'art_01DRZ3NDEKTSV4RRFFQ69G5FAV'

async function seedAcceptancePlan(isolated) {
  const base = contextPackageSerializationFixtures.futurePi
  const contextPackage = new ContextPackageCompiler(base.compiler.version).compile({
    objective: base.objective,
    projectState: {
      schemaVersion: 1,
      workspaceId: correlation.workspaceId,
      projectId: correlation.projectId,
      revision: base.projectState.revision,
      items: [],
      createdAt: now,
      updatedAt: now,
    },
    expectedProjectStateRevision: base.projectState.revision,
    candidates: [],
    artifacts: [],
    constraints: base.constraints,
    permissions: base.permissions,
    successCriteria: base.successCriteria,
    returnContract: base.returnContract,
    budgets: base.budgets,
    compiledAt: now,
  })
  const inputs = createExecutionPlanTestFixtureInputs({ contextPackage })
  inputs.correlation = { ...correlation, requestId }
  const catalogRepository = new PostgresCatalogRepository(isolated.application)
  const catalog = new VersionedCatalog(catalogRepository, catalogRepository)
  const { contentDigest: _contentDigest, ...skillManifest } = inputs.skills[0].manifest
  await new PostgresContextPackageRepository(isolated.application).put(contextPackage)
  await catalog.createSkill({
    skillId: inputs.skills[0].skillId,
    displayName: 'Hosted reconciliation fixture',
    ownership: { scope: 'system' },
    provenance: { source: 'system-curated', ownerRef: 'system', trust: 'trusted' },
    createdAt: inputs.skills[0].createdAt,
  })
  const skillDraft = await catalog.createSkillDraft({
    skillId: inputs.skills[0].skillId,
    skillVersionId: inputs.skills[0].skillVersionId,
    manifest: skillManifest,
    content: inputs.skills[0].content,
    createdAt: inputs.skills[0].createdAt,
  })
  const publishedSkill = await catalog.publishSkillVersion({
    skillVersionId: skillDraft.skillVersionId,
    expectedRevision: skillDraft.revision,
    publishedAt: now,
  })
  await catalog.createAgentProfile({
    profileId: inputs.profile.profileId,
    displayName: 'Hosted reconciliation fixture',
    ownership: { scope: 'system' },
    createdAt: inputs.profile.createdAt,
  })
  const profileDraft = await catalog.createAgentProfileDraft({
    profileId: inputs.profile.profileId,
    profileVersionId: inputs.profile.profileVersionId,
    version: inputs.profile.version,
    definition: {
      ...inputs.profile.definition,
      skills: [
        {
          skillId: publishedSkill.skillId,
          skillVersionId: publishedSkill.skillVersionId,
          contentDigest: publishedSkill.manifest.contentDigest,
        },
      ],
    },
    createdAt: inputs.profile.createdAt,
  })
  const publishedProfile = await catalog.publishAgentProfileVersion({
    profileVersionId: profileDraft.profileVersionId,
    expectedRevision: profileDraft.revision,
    publishedAt: now,
  })
  inputs.profile = publishedProfile
  inputs.skills = [publishedSkill]
  const plan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
  const plans = new PostgresExecutionPlanRepository(isolated.application)
  await plans.put(plan)
  return {
    plan,
    validator: new ExecutionPlanAcceptanceValidator(plans, {
      catalog: { profiles: catalogRepository, skills: catalogRepository },
    }),
  }
}

describe.skipIf(!integrationEnabled)('reconciliation projection against PostgreSQL rows', () => {
  let isolated
  let composition
  let dataDirectory

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    await isolated.migrate()
    dataDirectory = await mkdtemp(join(tmpdir(), 'hosted-reconciliation-'))
    composition = new HostedServerControlPlaneComposition({
      dataDirectory,
      // Discovery labels only: the real connection is injected below.
      databaseUrl: 'postgresql://control_plane_app:secret@127.0.0.1:54329/control_plane',
      connection: {
        database: isolated.application,
        check: async () => undefined,
        close: async () => undefined,
      },
      endpointFactory: {
        create: async () => ({ run: async () => undefined, shutdown: async () => undefined }),
      },
      workflowRuntime: {
        start: async () => undefined,
        stop: async () => undefined,
        health: async () => ({ ready: true, component: 'test', version: '1' }),
      },
      // The scheduler drives the passes: source and effects are the composed
      // production projection over the isolated PostgreSQL database.
      reconciliation: { projection: 'observation', intervalMs: 10, batchLimit: 10 },
    })
  }, 60_000)

  afterAll(async () => {
    await composition?.close().catch(() => undefined)
    await isolated?.dispose()
    await rm(dataDirectory, { recursive: true, force: true })
  })

  test('scheduler-driven passes converge a runtime-terminal execution and replay idempotently', async () => {
    // Seed real rows: an accepted execution advanced to running with an attempt,
    // and a runtime command whose terminal result the gateway recorded but the
    // workflow runtime never applied.
    const { plan, validator } = await seedAcceptancePlan(isolated)
    const inbox = new CommandInboxService({
      repository: new PostgresCommandAcceptanceRepository(isolated.application),
      executionIdFactory: () => executionId,
      executionPlanValidator: validator,
      now: () => now,
    })
    const { execution } = await inbox.acceptExecution({
      callerPrincipalId: 'svc_agent-hq',
      operation: 'execution.accept',
      commandId,
      requestId,
      idempotencyKey: 'reconciliation-projection:1',
      payloadHash: '8'.repeat(64),
      correlation,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      receivedAt: now,
      retentionExpiresAt: '2099-01-01T00:00:00.000Z',
    })
    const executions = new PostgresExecutionRepository(isolated.application)
    const lifecycle = new ExecutionLifecycleService(executions)
    await lifecycle.createAttempt({
      executionId,
      attemptId,
      expectedExecutionVersion: execution.version,
      queuedAt: now,
      runtime: { runtimeDefinitionId: 'rtd_01DRZ3NDEKTSV4RRFFQ69G5FAV' },
    })
    await lifecycle.transitionExecution({
      executionId,
      expectedVersion: execution.version + 1,
      to: 'queued',
      transitionedAt: now,
    })
    await lifecycle.transitionExecution({
      executionId,
      expectedVersion: execution.version + 2,
      to: 'running',
      transitionedAt: now,
    })
    await lifecycle.transitionAttempt({
      attemptId,
      expectedVersion: 1,
      to: 'running',
      transitionedAt: now,
    })
    const runtimeCommands = new PostgresRuntimeCommandRepository(isolated.application)
    // The runtime command row carries a foreign key to the connection registry.
    await new PostgresRuntimeConnectionRepository(isolated.application).insert({
      runtimeConnectionId: 'rtc_01DRZ3NDEKTSV4RRFFQ69G5FAV',
      identityDigest: `sha256:${'d'.repeat(64)}`,
      connectionType: 'managed_local',
      runtimeNodeRefId: 'rnr_01DRZ3NDEKTSV4RRFFQ69G5FAV',
      runtimeDefinitionId: 'rtd_01DRZ3NDEKTSV4RRFFQ69G5FAV',
      location: 'local_device',
      adapterVersion: '1.0.0',
      driverVersion: '1.0.0',
      harnessVersion: '1.0.0',
      status: 'connected',
      health: 'healthy',
      capabilities: [],
      compatibilityState: 'compatible',
      limitations: [],
      lastDiscoveredAt: now,
      lastHeartbeatAt: now,
      lastHealthCheckAt: now,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    await runtimeCommands.create({
      commandId: 'cmd_01DRZ3NDEKTSV4RRFFQ69G5FAW',
      executionId,
      attemptId,
      nodeId: 'rnr_01DRZ3NDEKTSV4RRFFQ69G5FAV',
      runtimeConnectionId: 'rtc_01DRZ3NDEKTSV4RRFFQ69G5FAV',
      workspaceId: correlation.workspaceId,
      idempotencyKey: 'reconciliation-projection:runtime:1',
      payloadHash: `sha256:${'a'.repeat(64)}`,
      commandEnvelope: { operation: 'runtime.start' },
      issuedAt: now,
      expiresAt: '2026-09-01T13:00:00.000Z',
      status: 'succeeded',
      version: 2,
      deliveryAttempts: 1,
      lastChannelGeneration: 1,
      lastSequence: 1,
      firstDispatchedAt: now,
      lastDispatchedAt: now,
      resultReference,
      resultStatus: 'succeeded',
      resultRecordedAt: now,
      createdAt: now,
      updatedAt: now,
    })

    await composition.start()
    try {
      // The scheduler eventually applies the recorded runtime outcome.
      await waitFor(async () => {
        const current = await executions.getExecution(executionId)
        return current?.state === 'completed' && current?.terminalResultRef === resultReference
      }, 'CONVERGENCE')
      const attempt = await executions.getAttempt(attemptId)
      expect(attempt.state).toBe('completed')
      expect(attempt.terminalResultRef).toBe(resultReference)

      // Replays are idempotent: one checkpoint, and the billable runtime
      // command record is never re-issued or mutated by reconciliation.
      await waitFor(async () => {
        const checkpoints = await readCheckpoints()
        return checkpoints.some(
          (checkpoint) =>
            checkpoint.action === 'apply_runtime_terminal' &&
            checkpoint.state === 'remediated' &&
            checkpoint.resolvedAt !== undefined
        )
      }, 'CHECKPOINT_CONVERGENCE')
      const checkpointsAfterConvergence = await readCheckpoints()
      expect(checkpointsAfterConvergence).toHaveLength(1)
      const [checkpoint] = checkpointsAfterConvergence
      expect(checkpoint).toMatchObject({
        executionId,
        commandId,
        attemptId,
        action: 'apply_runtime_terminal',
        state: 'remediated',
      })
      expect(checkpoint.resolvedAt).toBeInstanceOf(Date)
      expect(await composition.reconciliationService.runBatch({ limit: 10 })).toMatchObject({
        examined: 0,
        reconciled: 0,
        remediated: 0,
      })
      expect(await readCheckpoints()).toHaveLength(1)
      const runtimeCommand = await runtimeCommands.get('cmd_01DRZ3NDEKTSV4RRFFQ69G5FAW')
      expect(runtimeCommand.status).toBe('succeeded')
      expect(runtimeCommand.version).toBe(2)
    } finally {
      await composition.close()
    }
  })

  async function readCheckpoints() {
    return isolated.application.select().from(reconciliationCheckpoints)
  }
})

async function waitFor(predicate, label) {
  const started = Date.now()
  while (Date.now() - started < 15_000) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`HOSTED_RECONCILIATION_PROJECTION_TIMEOUT_${label}`)
}
