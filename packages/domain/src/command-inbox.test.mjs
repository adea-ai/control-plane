import { describe, expect, test } from 'bun:test'
import {
  CommandInboxError,
  CommandInboxService,
  InMemoryCommandAcceptanceRepository,
} from './index.ts'

const ids = {
  commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  artifactId: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV',
}

const receivedAt = '2026-08-24T10:00:00.000Z'
const retentionExpiresAt = '2026-09-23T10:00:00.000Z'
const payloadHash = 'a'.repeat(64)

function commandInput(overrides = {}) {
  return {
    callerPrincipalId: 'svc_agent-hq',
    operation: 'execution.accept',
    commandId: ids.commandId,
    requestId: ids.requestId,
    idempotencyKey: 'task-submit-0001',
    payloadHash,
    correlation: {
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      taskId: ids.taskId,
      agentId: ids.agentId,
    },
    executionPlan: {
      executionPlanId: ids.executionPlanId,
      contentDigest: `sha256:${'b'.repeat(64)}`,
      schemaVersion: 1,
    },
    receivedAt,
    retentionExpiresAt,
    ...overrides,
  }
}

function commandScope() {
  return {
    callerPrincipalId: 'svc_agent-hq',
    operation: 'execution.accept',
    workspaceId: ids.workspaceId,
    projectId: ids.projectId,
    idempotencyKey: 'task-submit-0001',
  }
}

function setup({ now = receivedAt, planValid = true } = {}) {
  const repository = new InMemoryCommandAcceptanceRepository()
  const service = new CommandInboxService({
    repository,
    executionIdFactory: () => ids.executionId,
    executionPlanValidator: { validate: async () => planValid },
    now: () => now,
  })
  return { repository, service }
}

describe('CommandInbox execution acceptance', () => {
  test('preserves replay of an unexpired legacy record with shorter retention', async () => {
    const { service } = setup()
    const accepted = await service.acceptExecution(commandInput())
    const legacyRepository = new InMemoryCommandAcceptanceRepository()
    const legacyDeadline = new Date(Date.parse(receivedAt) + 86_400_000).toISOString()
    await legacyRepository.accept(
      { ...accepted.command, retentionExpiresAt: legacyDeadline },
      accepted.execution
    )
    const restarted = new CommandInboxService({
      repository: legacyRepository,
      executionIdFactory: () => {
        throw new Error('REPLAY_MUST_NOT_ALLOCATE')
      },
      executionPlanValidator: { validate: async () => false },
      now: () => receivedAt,
    })
    const result = await restarted.acceptExecution(
      commandInput({ retentionExpiresAt: legacyDeadline })
    )
    expect(result.replayed).toBe(true)
    expect(result.command.retentionExpiresAt).toBe(legacyDeadline)
    expect(legacyRepository.executionCount).toBe(1)
  })

  test.each([1, 30 * 24 * 60 * 60 * 1_000 - 1])(
    'rejects acceptance with %i ms retention',
    async (duration) => {
      const { service, repository } = setup()
      await expect(
        service.acceptExecution(
          commandInput({
            retentionExpiresAt: new Date(Date.parse(receivedAt) + duration).toISOString(),
          })
        )
      ).rejects.toThrow()
      expect(repository.executionCount).toBe(0)
    }
  )

  test.each([30, 31])('accepts the canonical retention floor or longer: %i days', async (days) => {
    const { service } = setup()
    const deadline = new Date(Date.parse(receivedAt) + days * 24 * 60 * 60 * 1_000).toISOString()
    const accepted = await service.acceptExecution(commandInput({ retentionExpiresAt: deadline }))
    expect(accepted.command.retentionExpiresAt).toBe(deadline)
  })

  test('returns the original accepted execution for identical retries', async () => {
    const { repository, service } = setup()
    const first = await service.acceptExecution(commandInput())
    const retry = await service.acceptExecution(
      commandInput({
        commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAW',
        requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAW',
      })
    )

    expect(first.replayed).toBe(false)
    expect(retry.replayed).toBe(true)
    expect(retry.command).toEqual(first.command)
    expect(retry.execution).toEqual(first.execution)
    expect(repository.executionCount).toBe(1)
    expect(first.command).toMatchObject({
      status: 'accepted',
      version: 1,
      conflictCount: 0,
      executionId: ids.executionId,
      payloadHash,
    })
  })

  test('records and rejects an idempotency key reused with a different payload hash', async () => {
    const { repository, service } = setup()
    await service.acceptExecution(commandInput())

    await expect(
      service.acceptExecution(commandInput({ payloadHash: 'c'.repeat(64) }))
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
      errorClass: 'conflict',
      retryable: false,
    })

    const command = await repository.get(commandScope())
    expect(command).toMatchObject({
      conflictCount: 1,
      lastConflictAt: receivedAt,
      payloadHash,
    })
    expect(repository.executionCount).toBe(1)
  })

  test('concurrent duplicate submissions converge on one command and execution', async () => {
    const { repository, service } = setup()

    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.acceptExecution(commandInput()))
    )

    expect(new Set(results.map(({ command }) => command.commandId))).toEqual(
      new Set([ids.commandId])
    )
    expect(new Set(results.map(({ execution }) => execution.executionId))).toEqual(
      new Set([ids.executionId])
    )
    expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1)
    expect(repository.executionCount).toBe(1)
  })

  test('recovers after a committed response is lost without revalidating or duplicating work', async () => {
    let validations = 0
    const repository = new InMemoryCommandAcceptanceRepository()
    const service = new CommandInboxService({
      repository,
      executionIdFactory: () => ids.executionId,
      executionPlanValidator: {
        validate: async () => {
          validations += 1
          return validations === 1
        },
      },
      now: () => receivedAt,
    })

    await service.acceptExecution(commandInput())
    const recovered = await service.acceptExecution(commandInput())

    expect(recovered.replayed).toBe(true)
    expect(validations).toBe(1)
    expect(repository.executionCount).toBe(1)
  })

  test('fails closed before persistence for an invalid plan scope or version reference', async () => {
    const { repository, service } = setup({ planValid: false })

    await expect(service.acceptExecution(commandInput())).rejects.toMatchObject({
      code: 'INVALID_EXECUTION_PLAN_REFERENCE',
      errorClass: 'stale_reference',
      retryable: false,
    })
    expect(repository.executionCount).toBe(0)
    expect(await repository.get(commandScope())).toBeUndefined()
  })

  test('returns current processing, terminal, and reconciliation-required outcomes on replay', async () => {
    const { service } = setup()
    const accepted = await service.acceptExecution(commandInput())
    const processing = await service.transitionCommand({
      ...commandInput(),
      expectedVersion: accepted.command.version,
      to: 'processing',
      transitionedAt: '2026-08-24T10:01:00.000Z',
    })
    const reconciling = await service.transitionCommand({
      ...commandInput(),
      expectedVersion: processing.version,
      to: 'reconciliation_required',
      transitionedAt: '2026-08-24T10:02:00.000Z',
      errorReference: 'reconciliation://lost-ack/1',
    })

    expect((await service.acceptExecution(commandInput())).command).toEqual(reconciling)

    const completed = await service.transitionCommand({
      ...commandInput(),
      expectedVersion: reconciling.version,
      to: 'completed',
      transitionedAt: '2026-08-24T10:03:00.000Z',
      resultReference: ids.artifactId,
    })
    expect(completed.errorReference).toBeUndefined()
    const terminalReplay = await service.acceptExecution(commandInput())

    expect(terminalReplay.command).toEqual(completed)
    expect(terminalReplay).toMatchObject({ replayed: true, execution: accepted.execution })
    await expect(
      service.transitionCommand({
        ...commandInput(),
        expectedVersion: completed.version,
        to: 'processing',
        transitionedAt: '2026-08-24T10:04:00.000Z',
      })
    ).rejects.toBeInstanceOf(CommandInboxError)
  })

  test('stores bounded error references rather than raw diagnostics', async () => {
    const { service } = setup()
    const accepted = await service.acceptExecution(commandInput())

    await expect(
      service.transitionCommand({
        ...commandInput(),
        expectedVersion: accepted.command.version,
        to: 'failed',
        transitionedAt: '2026-08-24T10:01:00.000Z',
        errorReference: 'database password leaked in stack trace',
      })
    ).rejects.toThrow()
  })

  test('transitions the acceptance command by its durable execution identity', async () => {
    const { service } = setup()
    const accepted = await service.acceptExecution(commandInput())
    await service.transitionCommand({
      ...commandInput(),
      expectedVersion: accepted.command.version,
      to: 'processing',
      transitionedAt: '2026-08-24T10:01:00.000Z',
    })

    const completed = await service.transitionExecutionCommand({
      executionId: ids.executionId,
      to: 'completed',
      transitionedAt: '2026-08-24T10:02:00.000Z',
      resultReference: ids.artifactId,
    })

    expect(completed).toMatchObject({
      executionId: ids.executionId,
      status: 'completed',
      resultReference: ids.artifactId,
    })
    expect((await service.acceptExecution(commandInput())).command).toEqual(completed)
  })

  test('rejects stale status transitions and retries after the retention deadline', async () => {
    const { service } = setup()
    const accepted = await service.acceptExecution(commandInput())
    const processing = await service.transitionCommand({
      ...commandInput(),
      expectedVersion: accepted.command.version,
      to: 'processing',
      transitionedAt: '2026-08-24T10:01:00.000Z',
    })

    await expect(
      service.transitionCommand({
        ...commandInput(),
        expectedVersion: accepted.command.version,
        to: 'failed',
        transitionedAt: '2026-08-24T10:02:00.000Z',
        errorReference: 'error://dispatch/1',
      })
    ).rejects.toMatchObject({ code: 'STALE_COMMAND_VERSION', currentVersion: processing.version })

    const expiredService = new CommandInboxService({
      repository: service.repository,
      executionIdFactory: () => ids.executionId,
      executionPlanValidator: { validate: async () => true },
      now: () => '2026-09-23T10:00:00.001Z',
    })
    await expect(expiredService.acceptExecution(commandInput())).rejects.toMatchObject({
      code: 'COMMAND_RETENTION_EXPIRED',
    })
  })
})
