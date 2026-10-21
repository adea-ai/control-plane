import { describe, expect, test } from 'bun:test'
import {
  ExecutionLifecycleError,
  ExecutionLifecycleService,
  ExecutionSchema,
  InMemoryExecutionRepository,
} from './index.ts'

const ids = {
  executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  secondExecutionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAW',
  attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  secondAttemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAW',
  workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  runtimeDefinitionId: 'rtd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  runtimeNodeRefId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  runtimeConnectionId: 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  artifactId: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV',
}

const routingDecision = {
  routingVersion: 1,
  policy: {
    policyId: 'runtime-standard',
    version: 1,
    digest: `sha256:${'c'.repeat(64)}`,
  },
  evaluatedAt: '2026-08-23T10:00:59.000Z',
  inputDigest: `sha256:${'d'.repeat(64)}`,
  decisionDigest: `sha256:${'e'.repeat(64)}`,
  selectedRank: 1,
  candidateCount: 2,
  reasonCodes: ['HEALTH', 'LOCALITY'],
}

const acceptedAt = '2026-08-23T10:00:00.000Z'
const digest = `sha256:${'a'.repeat(64)}`

/** A complete execution read model, as the execution repository stores it. */
function readModelInput(overrides = {}) {
  return {
    ...executionInput(),
    state: 'accepted',
    version: 1,
    attemptCount: 0,
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
    ...overrides,
  }
}

function acceptedModelCases() {
  return {
    accepts: ['deepseek-flash', 'DeepSeek-V3', 'GPT-4o', 'GLM-4'],
    refuses: ['', ' ', 'deepseek flash', '-deepseek', '.deepseek'],
  }
}

function setup() {
  const repository = new InMemoryExecutionRepository()
  return { repository, service: new ExecutionLifecycleService(repository) }
}

function executionInput(executionId = ids.executionId) {
  return {
    executionId,
    correlation: {
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      taskId: ids.taskId,
      agentId: ids.agentId,
      requestId: ids.requestId,
    },
    executionPlan: {
      executionPlanId: ids.executionPlanId,
      contentDigest: digest,
      schemaVersion: 1,
    },
    acceptedAt,
    deadlineAt: '2026-08-23T11:00:00.000Z',
  }
}

describe('Execution lifecycle', () => {
  describe('the accepted model on the execution read model', () => {
    test('carries the accepted model id, including an uppercase ASCII one', () => {
      for (const modelId of acceptedModelCases().accepts) {
        expect(ExecutionSchema.parse(readModelInput({ modelId })).modelId).toBe(modelId)
      }
    })

    test('refuses a malformed model id instead of carrying it', () => {
      for (const modelId of acceptedModelCases().refuses) {
        expect(() => ExecutionSchema.parse(readModelInput({ modelId }))).toThrow()
      }
    })

    test('an execution without a model keeps the read model exactly as it was', () => {
      const parsed = ExecutionSchema.parse(readModelInput())
      expect(parsed.modelId).toBeUndefined()
    })
  })

  test('keeps one immutable product intent and plan across multiple concrete attempts', async () => {
    const { repository, service } = setup()
    const execution = await service.createExecution(executionInput())
    const first = await service.createAttempt({
      executionId: execution.executionId,
      attemptId: ids.attemptId,
      expectedExecutionVersion: execution.version,
      queuedAt: '2026-08-23T10:01:00.000Z',
      runtime: {
        runtimeDefinitionId: ids.runtimeDefinitionId,
        runtimeNodeRefId: ids.runtimeNodeRefId,
        runtimeConnectionId: ids.runtimeConnectionId,
        routingDecision,
      },
    })
    const afterFirst = await service.getExecution(execution.executionId)
    const second = await service.createAttempt({
      executionId: execution.executionId,
      attemptId: ids.secondAttemptId,
      expectedExecutionVersion: afterFirst.version,
      queuedAt: '2026-08-23T10:02:00.000Z',
    })

    expect(first.sequence).toBe(1)
    expect(second.sequence).toBe(2)
    expect(await repository.listAttempts(execution.executionId)).toHaveLength(2)
    expect(await service.getExecution(execution.executionId)).toMatchObject({
      executionId: ids.executionId,
      attemptCount: 2,
      latestAttemptId: ids.secondAttemptId,
      correlation: executionInput().correlation,
      executionPlan: executionInput().executionPlan,
    })
    expect(await repository.getAttempt(ids.attemptId)).toMatchObject({
      executionId: ids.executionId,
      runtime: {
        runtimeDefinitionId: ids.runtimeDefinitionId,
        runtimeNodeRefId: ids.runtimeNodeRefId,
        runtimeConnectionId: ids.runtimeConnectionId,
        routingDecision,
      },
    })
    expect(JSON.stringify(await service.getExecution(execution.executionId))).not.toContain(
      ids.runtimeDefinitionId
    )
  })

  test('rejects repository writes that try to replace immutable execution intent or plan pins', async () => {
    const { repository, service } = setup()
    const execution = await service.createExecution(executionInput())
    const changed = {
      ...execution,
      version: execution.version + 1,
      executionPlan: { ...execution.executionPlan, contentDigest: `sha256:${'b'.repeat(64)}` },
    }

    expect(await repository.compareAndSetExecution(execution.version, changed)).toBe(false)
    expect(await service.getExecution(execution.executionId)).toEqual(execution)
  })

  test('applies deterministic lifecycle timestamps and terminal metadata', async () => {
    const { service } = setup()
    const accepted = await service.createExecution(executionInput())
    const queued = await service.transitionExecution({
      executionId: accepted.executionId,
      expectedVersion: accepted.version,
      to: 'queued',
      transitionedAt: '2026-08-23T10:01:00.000Z',
    })
    const running = await service.transitionExecution({
      executionId: queued.executionId,
      expectedVersion: queued.version,
      to: 'running',
      transitionedAt: '2026-08-23T10:02:00.000Z',
    })
    const completed = await service.transitionExecution({
      executionId: running.executionId,
      expectedVersion: running.version,
      to: 'completed',
      transitionedAt: '2026-08-23T10:03:00.000Z',
      terminalResultRef: ids.artifactId,
    })

    expect(completed).toMatchObject({
      state: 'completed',
      version: 4,
      queuedAt: '2026-08-23T10:01:00.000Z',
      runningAt: '2026-08-23T10:02:00.000Z',
      terminalAt: '2026-08-23T10:03:00.000Z',
      terminalResultRef: ids.artifactId,
    })
  })

  test('clears reconciliation failure metadata after terminal recovery', async () => {
    const { service } = setup()
    const accepted = await service.createExecution(executionInput())
    const reconciling = await service.transitionExecution({
      executionId: accepted.executionId,
      expectedVersion: accepted.version,
      to: 'reconciliation_required',
      transitionedAt: '2026-08-23T10:01:00.000Z',
      failure: { classification: 'infrastructure', code: 'DELIVERY_UNCONFIRMED' },
    })
    const completed = await service.transitionExecution({
      executionId: accepted.executionId,
      expectedVersion: reconciling.version,
      to: 'completed',
      transitionedAt: '2026-08-23T10:02:00.000Z',
      terminalResultRef: ids.artifactId,
    })

    expect(completed).toMatchObject({ state: 'completed', terminalResultRef: ids.artifactId })
    expect(completed.failure).toBeUndefined()
  })

  test('rejects invalid, stale, and post-terminal transitions with classified errors', async () => {
    const { service } = setup()
    const accepted = await service.createExecution(executionInput())

    await expect(
      service.transitionExecution({
        executionId: accepted.executionId,
        expectedVersion: accepted.version,
        to: 'completed',
        transitionedAt: '2026-08-23T10:01:00.000Z',
      })
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })

    const queued = await service.transitionExecution({
      executionId: accepted.executionId,
      expectedVersion: accepted.version,
      to: 'queued',
      transitionedAt: '2026-08-23T10:01:00.000Z',
    })
    await expect(
      service.transitionExecution({
        executionId: queued.executionId,
        expectedVersion: accepted.version,
        to: 'starting',
        transitionedAt: '2026-08-23T10:02:00.000Z',
      })
    ).rejects.toMatchObject({ code: 'STALE_EXECUTION_VERSION', currentVersion: queued.version })

    const failed = await service.transitionExecution({
      executionId: queued.executionId,
      expectedVersion: queued.version,
      to: 'failed',
      transitionedAt: '2026-08-23T10:03:00.000Z',
      failure: { classification: 'runtime_error', code: 'RUNTIME_EXITED' },
    })
    await expect(
      service.transitionExecution({
        executionId: failed.executionId,
        expectedVersion: failed.version,
        to: 'queued',
        transitionedAt: '2026-08-23T10:04:00.000Z',
      })
    ).rejects.toBeInstanceOf(ExecutionLifecycleError)
    await expect(
      service.transitionExecution({
        executionId: failed.executionId,
        expectedVersion: failed.version,
        to: 'queued',
        transitionedAt: '2026-08-23T10:04:00.000Z',
      })
    ).rejects.toMatchObject({ code: 'TERMINAL_STATE' })
  })

  test('allows exactly one concurrent transition for an expected version', async () => {
    const { service } = setup()
    const accepted = await service.createExecution(executionInput())

    const outcomes = await Promise.allSettled([
      service.transitionExecution({
        executionId: accepted.executionId,
        expectedVersion: accepted.version,
        to: 'queued',
        transitionedAt: '2026-08-23T10:01:00.000Z',
      }),
      service.transitionExecution({
        executionId: accepted.executionId,
        expectedVersion: accepted.version,
        to: 'cancelling',
        transitionedAt: '2026-08-23T10:01:00.000Z',
      }),
    ])

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(outcomes.find(({ status }) => status === 'rejected').reason).toMatchObject({
      code: 'STALE_EXECUTION_VERSION',
    })
  })

  test('allows exactly one concurrent retry for an expected execution version', async () => {
    const { repository, service } = setup()
    const execution = await service.createExecution(executionInput())

    const outcomes = await Promise.allSettled([
      service.createAttempt({
        executionId: execution.executionId,
        attemptId: ids.attemptId,
        expectedExecutionVersion: execution.version,
        queuedAt: '2026-08-23T10:01:00.000Z',
      }),
      service.createAttempt({
        executionId: execution.executionId,
        attemptId: ids.secondAttemptId,
        expectedExecutionVersion: execution.version,
        queuedAt: '2026-08-23T10:01:00.000Z',
      }),
    ])

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(await repository.listAttempts(execution.executionId)).toHaveLength(1)
  })
})

describe('ExecutionAttempt lifecycle', () => {
  test('rejects stale transitions and keeps runtime identity on the attempt', async () => {
    const { service } = setup()
    const execution = await service.createExecution(executionInput())
    const attempt = await service.createAttempt({
      executionId: execution.executionId,
      attemptId: ids.attemptId,
      expectedExecutionVersion: execution.version,
      queuedAt: '2026-08-23T10:01:00.000Z',
      runtime: { runtimeDefinitionId: ids.runtimeDefinitionId },
    })
    const starting = await service.transitionAttempt({
      attemptId: attempt.attemptId,
      expectedVersion: attempt.version,
      to: 'starting',
      transitionedAt: '2026-08-23T10:02:00.000Z',
    })

    await expect(
      service.transitionAttempt({
        attemptId: attempt.attemptId,
        expectedVersion: attempt.version,
        to: 'running',
        transitionedAt: '2026-08-23T10:03:00.000Z',
      })
    ).rejects.toMatchObject({ code: 'STALE_ATTEMPT_VERSION', currentVersion: starting.version })
    expect(starting.runtime).toEqual({ runtimeDefinitionId: ids.runtimeDefinitionId })
  })

  test('keeps the routing policy and decision immutable on the selected attempt', async () => {
    const { repository, service } = setup()
    const execution = await service.createExecution(executionInput())
    const attempt = await service.createAttempt({
      executionId: execution.executionId,
      attemptId: ids.attemptId,
      expectedExecutionVersion: execution.version,
      queuedAt: '2026-08-23T10:01:00.000Z',
      runtime: { runtimeConnectionId: ids.runtimeConnectionId, routingDecision },
    })

    expect(attempt.runtime.routingDecision).toEqual(routingDecision)
    expect(
      await repository.compareAndSetAttempt(attempt.version, {
        ...attempt,
        version: attempt.version + 1,
        runtime: {
          ...attempt.runtime,
          routingDecision: { ...routingDecision, decisionDigest: `sha256:${'f'.repeat(64)}` },
        },
      })
    ).toBe(false)
    expect(await repository.getAttempt(attempt.attemptId)).toEqual(attempt)
  })
})
