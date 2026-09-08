import { isDeepStrictEqual } from 'node:util'
import {
  InteractionRequestSchema,
  InteractionService,
  type InteractionRequest,
  type InteractionRepository,
  type CommandAcceptanceRepository,
} from '@control-plane/domain'
import type { RuntimeExecutionProgress } from '@control-plane/runtime-sdk'

const interactionStates = new Set(['running', 'awaiting_input'])

export class LocalRuntimeInteractions {
  constructor(
    readonly repository: InteractionRepository & {
      listForAttempt(executionId: string, attemptId: string): Promise<InteractionRequest[]>
    },
    readonly commands: Pick<CommandAcceptanceRepository, 'getByExecutionId' | 'getExecution'>
  ) {}

  async resolveTerminal(executionId: string, attemptId: string): Promise<void> {
    const service = new InteractionService(this.repository)
    const resolvedAt = new Date().toISOString()
    for (const request of await this.repository.listForAttempt(executionId, attemptId)) {
      if (request.executionId !== executionId || request.attemptId !== attemptId)
        throw new Error('LOCAL_INTERACTION_SCOPE_MISMATCH')
      await service.resolveTerminal(request.interactionId, resolvedAt)
    }
  }

  async record(
    executionId: string,
    attemptId: string,
    event: RuntimeExecutionProgress
  ): Promise<void> {
    const [command, execution] = await Promise.all([
      this.commands.getByExecutionId(executionId),
      this.commands.getExecution(executionId),
    ])
    if (
      !command ||
      !execution ||
      !interactionStates.has(execution.state) ||
      command.executionId !== executionId ||
      execution.latestAttemptId !== attemptId ||
      command.workspaceId !== execution.correlation.workspaceId ||
      command.projectId !== execution.correlation.projectId
    )
      throw new Error('LOCAL_INTERACTION_SCOPE_MISSING')
    const kind = event.data['kind']
    if (kind !== 'input' && kind !== 'approval' && kind !== 'permission')
      throw new Error('LOCAL_INTERACTION_KIND_UNSUPPORTED')
    const requestedAt = new Date().toISOString()
    const expiresAt = new Date(
      Math.min(
        Date.parse(execution.deadlineAt ?? new Date(Date.now() + 15 * 60000).toISOString()),
        Date.parse(command.retentionExpiresAt)
      )
    ).toISOString()
    const request = InteractionRequestSchema.parse({
      interactionId: event.data['interactionId'],
      executionId,
      attemptId,
      kind,
      prompt: {
        title: kind === 'input' ? 'Runtime input requested' : 'Runtime approval requested',
      },
      allowedActions:
        kind === 'input'
          ? ['input', 'cancel']
          : kind === 'permission'
            ? ['grant', 'deny', 'cancel']
            : ['approve', 'deny', 'cancel'],
      allowedPrincipalIds: [command.callerPrincipalId],
      state: 'pending',
      version: 1,
      requestedAt,
      expiresAt,
    })
    if (await this.repository.insert(request)) return
    const existing = await this.repository.get(request.interactionId)
    if (
      !existing ||
      existing.executionId !== executionId ||
      existing.attemptId !== attemptId ||
      existing.kind !== kind ||
      !isDeepStrictEqual(existing.allowedPrincipalIds, request.allowedPrincipalIds)
    )
      throw new Error('LOCAL_INTERACTION_ID_CONFLICT')
  }

  async assertResponse(input: {
    interactionId: string
    executionId: string
    attemptId: string
    responseId: string
    action: string
    value?: unknown
  }): Promise<void> {
    const [request, execution] = await Promise.all([
      this.repository.get(input.interactionId),
      this.commands.getExecution(input.executionId),
    ])
    if (
      !execution ||
      !interactionStates.has(execution.state) ||
      execution.latestAttemptId !== input.attemptId ||
      !request ||
      request.executionId !== input.executionId ||
      request.attemptId !== input.attemptId ||
      request.state !== 'responded' ||
      !request.response ||
      request.response.responseId !== input.responseId ||
      request.response.action !== input.action ||
      !isDeepStrictEqual(request.response.value, input.value)
    )
      throw new Error('LOCAL_INTERACTION_RESPONSE_UNCONFIRMED')
  }
}
