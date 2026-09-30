import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CommandInboxService,
  ExecutionLifecycleService,
  InteractionService,
} from '@control-plane/domain'
import {
  SqlitePersistenceProvider,
  SqliteCommandAcceptanceRepository,
  SqliteContextPackageRepository,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
  SqliteInteractionRepository,
  SqliteVersionedCatalogRepository,
} from '@control-plane/sqlite-persistence'
import { FilesystemObjectStore } from '@control-plane/object-store'
import {
  createExecutionPlanTestFixture,
  createExecutionPlanTestFixtureInputs,
} from '@control-plane/execution-plan/testing'
import { ExecutionPlanAcceptanceValidator } from '@control-plane/execution-plan'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { seedSystemCatalogOwners } from './test-catalog-owners.mjs'
import { DirectRuntimeActivityPort } from './direct-runtime-activities.ts'
import { LocalRuntimeInteractions } from './runtime-interactions.ts'

test('two durable approvals skip resolved history and replay each effect without another submission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-repeated-interaction-'))
  const persistence = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  const objectStore = new FilesystemObjectStore({
    rootDirectory: join(directory, 'artifacts'),
    maxObjectBytes: 4096,
  })
  const executionId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const attemptId = 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const ids = ['int_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'int_01ARZ3NDEKTSV4RRFFQ69G5FAW']
  const handle = { handleId: 'native:repeated', attemptId, startedAt: new Date().toISOString() }
  const planInputs = createExecutionPlanTestFixtureInputs()
  const plan = createExecutionPlanTestFixture()
  const submissions = []
  let completed = false
  const runtime = {
    transportKind: 'direct-local',
    start: async () => handle,
    async *progress() {
      // Every subscription replays all historical events, like native ACP.
      for (let index = 0; index < ids.length; index++) {
        if (index > submissions.length) break
        yield {
          handleId: handle.handleId,
          sequence: index + 1,
          occurredAt: handle.startedAt,
          type: 'interaction',
          data: { interactionId: ids[index], kind: 'permission' },
        }
      }
      if (submissions.length === 2) completed = true
    },
    status: async () =>
      completed
        ? {
            handle,
            state: 'completed',
            observedAt: handle.startedAt,
            result: {
              outcome: 'completed',
              output: { ok: true },
              usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
              artifacts: [],
            },
          }
        : { handle, state: 'awaiting_input', observedAt: handle.startedAt },
    async submitApproval(_, request) {
      expect(request.interactionId).toBe(ids[submissions.length])
      submissions.push(request)
      return { handle, state: 'running', observedAt: handle.startedAt }
    },
  }
  try {
    await persistence.migrate()
    const plans = new SqliteExecutionPlanRepository(persistence)
    const catalog = new SqliteVersionedCatalogRepository(persistence)
    await new SqliteContextPackageRepository(persistence).put(
      contextPackageSerializationFixtures.futurePi
    )
    await plans.put(plan)
    await seedSystemCatalogOwners(catalog, planInputs.profile, planInputs.skills)
    await catalog.insertAgentProfileVersion(planInputs.profile)
    for (const skill of planInputs.skills) await catalog.insertSkillVersion(skill)
    const commandRepository = new SqliteCommandAcceptanceRepository(persistence)
    const accepted = await new CommandInboxService({
      repository: commandRepository,
      executionIdFactory: () => executionId,
      executionPlanValidator: new ExecutionPlanAcceptanceValidator(plans, {
        catalog: { profiles: catalog, skills: catalog },
      }),
    }).acceptExecution({
      callerPrincipalId: 'svc_owner',
      operation: 'execution.accept',
      commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestId: plan.correlation.requestId,
      idempotencyKey: 'repeated-interaction-owner',
      payloadHash: 'a'.repeat(64),
      correlation: {
        workspaceId: plan.correlation.workspaceId,
        projectId: plan.correlation.projectId,
        taskId: plan.correlation.taskId,
        agentId: plan.correlation.agentId,
      },
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      receivedAt: '2026-09-01T12:00:00.000Z',
      retentionExpiresAt: '2099-01-01T00:00:00.000Z',
    })
    const lifecycle = new ExecutionLifecycleService(new SqliteExecutionRepository(persistence))
    await lifecycle.createAttempt({
      executionId,
      attemptId,
      expectedExecutionVersion: accepted.execution.version,
      queuedAt: '2026-09-01T12:01:00.000Z',
    })
    await lifecycle.transitionExecution({
      executionId,
      expectedVersion: accepted.execution.version + 1,
      to: 'queued',
      transitionedAt: '2026-09-01T12:02:00.000Z',
    })
    await lifecycle.transitionExecution({
      executionId,
      expectedVersion: accepted.execution.version + 2,
      to: 'starting',
      transitionedAt: '2026-09-01T12:03:00.000Z',
    })
    await lifecycle.transitionExecution({
      executionId,
      expectedVersion: accepted.execution.version + 3,
      to: 'awaiting_input',
      transitionedAt: '2026-09-01T12:04:00.000Z',
    })
    const repository = new SqliteInteractionRepository(persistence)
    const bridge = new LocalRuntimeInteractions(repository, commandRepository)
    const activities = new DirectRuntimeActivityPort(persistence, objectStore, runtime, bridge)
    expect(
      await activities.dispatch({
        executionId,
        attemptId,
        executionPlan: plan,
        effectKey: 'repeated:dispatch',
      })
    ).toEqual({ outcome: 'awaiting_input', interactionId: ids[0] })
    for (let index = 0; index < ids.length; index++) {
      const response = {
        executionId,
        attemptId,
        interactionId: ids[index],
        responseId: `cmd_01ARZ3NDEKTSV4RRFFQ69G5FA${index === 0 ? 'V' : 'W'}`,
        action: 'grant',
      }
      expect((await repository.get(ids[index])).state).toBe('pending')
      await new InteractionService(repository).respond({
        ...response,
        expectedVersion: 1,
        respondingPrincipalId: 'svc_owner',
        respondedAt: new Date().toISOString(),
      })
      const input = { ...response, effectKey: `repeated:response:${index}` }
      const outcome = await activities.applyInteraction(input)
      expect(outcome).toMatchObject(
        index === 0
          ? { outcome: 'awaiting_input', interactionId: ids[1] }
          : { outcome: 'completed' }
      )
      expect(await activities.applyInteraction(input)).toEqual(outcome)
      expect(submissions).toHaveLength(index + 1)
    }
    expect(
      (await repository.listForAttempt(executionId, attemptId)).map((request) => request.state)
    ).toEqual(['responded', 'responded'])
  } finally {
    persistence.close()
    objectStore.close()
    await rm(directory, { recursive: true, force: true })
  }
})
