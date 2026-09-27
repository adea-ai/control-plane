import { expect, test } from 'bun:test'
import { ControlApiFixtures } from '@control-plane/contracts'
import { CommandInboxService, InMemoryCommandAcceptanceRepository } from '@control-plane/domain'
import { DurableExecutionAcceptanceService } from './execution-acceptance.service.ts'

test.each(['optimistic replay', 'acceptance race'])(
  'admission denial prevents workflow submission on %s',
  async (path) => {
    const fixture = ControlApiFixtures.executionAcceptance.request
    const request = {
      ...fixture,
      payload: {
        ...fixture.payload,
        retentionExpiresAt: new Date(Date.parse(fixture.issuedAt) + 30 * 86_400_000).toISOString(),
      },
    }
    const repository = new InMemoryCommandAcceptanceRepository()
    const commands = new CommandInboxService({
      repository,
      executionIdFactory: () => 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      executionPlanValidator: { validate: async () => true },
      now: () => request.issuedAt,
    })
    const accepted = await commands.acceptExecution({
      callerPrincipalId: 'svc_admission-test',
      operation: request.operation,
      commandId: request.commandId,
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      payloadHash: request.payloadHash,
      correlation: {
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        taskId: request.payload.taskId,
        agentId: request.payload.agentId,
      },
      executionPlan: request.payload.executionPlan,
      receivedAt: request.issuedAt,
      retentionExpiresAt: request.payload.retentionExpiresAt,
    })
    let verified = 0
    repository.verifyAdmission = async () => {
      verified += 1
      throw new Error('BUDGET_NOT_FOUND')
    }
    if (path === 'acceptance race') repository.get = async () => undefined
    let dispatched = 0
    const service = new DurableExecutionAcceptanceService({
      commands,
      dispatcher: {
        submit: async () => {
          dispatched += 1
        },
      },
      now: () => request.issuedAt,
    })

    await expect(service.accept(request, 'svc_admission-test')).rejects.toThrow('BUDGET_NOT_FOUND')
    expect(verified).toBe(1)
    expect(dispatched).toBe(0)
    expect(await repository.getByExecutionId(accepted.execution.executionId)).toMatchObject({
      status: 'accepted',
      version: 1,
    })
    expect(repository.executionCount).toBe(1)
  }
)
