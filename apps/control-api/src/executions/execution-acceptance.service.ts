import { randomBytes } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { managedCloudOperationalPolicy } from '@control-plane/config'
import {
  ExecutionAcceptanceRequestSchema,
  ExecutionAcceptanceResponseSchema,
  IdentifierSchemas,
  type ExecutionAcceptanceResponse,
} from '@control-plane/contracts'
import {
  CommandInboxError,
  InteractionRequestSchema,
  type InteractionSignalDispatcher,
  type InteractionRequest,
  type CommandInboxRecord,
  type CommandInboxService,
} from '@control-plane/domain'
import {
  ExecutionWorkflowInputSchema,
  type ExecutionWorkflowInput,
} from '@control-plane/orchestration'

export const EXECUTION_ACCEPTANCE_SERVICE = Symbol('EXECUTION_ACCEPTANCE_SERVICE')
const restateWorkflowName = 'execution-lifecycle'
const crockfordAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export interface ExecutionAcceptanceService {
  accept(envelope: unknown, callerPrincipalId: string): Promise<ExecutionAcceptanceResponse>
}

export interface ExecutionWorkflowDispatcher {
  submit(input: ExecutionWorkflowInput): Promise<void>
}

export interface DurableExecutionAcceptanceServiceOptions {
  readonly commands: CommandInboxService
  readonly dispatcher: ExecutionWorkflowDispatcher
  readonly now?: () => string
}

export class DurableExecutionAcceptanceService implements ExecutionAcceptanceService {
  readonly #commands: CommandInboxService
  readonly #dispatcher: ExecutionWorkflowDispatcher
  readonly #now: () => string

  constructor(options: DurableExecutionAcceptanceServiceOptions) {
    this.#commands = options.commands
    this.#dispatcher = options.dispatcher
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async accept(envelope: unknown, callerPrincipalId: string): Promise<ExecutionAcceptanceResponse> {
    const request = ExecutionAcceptanceRequestSchema.parse(envelope)
    const deadlineAt = workflowDeadline(request)
    let accepted
    try {
      accepted = await this.#commands.acceptExecution({
        callerPrincipalId,
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
        ...(request.payload.marketplacePluginReferences === undefined
          ? {}
          : { marketplacePluginReferences: request.payload.marketplacePluginReferences }),
        parentExecutionId: request.payload.parentExecutionId,
        receivedAt: request.issuedAt,
        retentionExpiresAt: request.payload.retentionExpiresAt,
        deadlineAt: request.payload.deadlineAt,
      })
    } catch (error) {
      normalizeCommandError(error)
    }

    let command = accepted.command
    if (command.status === 'accepted' || command.status === 'reconciliation_required') {
      try {
        await this.#dispatcher.submit(
          ExecutionWorkflowInputSchema.parse({
            executionId: accepted.execution.executionId,
            workflowId: workflowIdFromExecutionId(accepted.execution.executionId),
            executionPlan: accepted.execution.executionPlan,
            ...(accepted.execution.marketplacePluginReferences === undefined
              ? {}
              : { marketplacePluginReferences: accepted.execution.marketplacePluginReferences }),
            deadlineAt,
          })
        )
        command = await this.#transition(command, 'processing')
      } catch {
        if (command.status === 'accepted') await this.#markReconciliationRequired(command)
        throw new ServiceUnavailableException({
          code: 'RESTATE_SUBMISSION_UNCONFIRMED',
          message: 'Restate workflow submission is unavailable',
        })
      }
    }

    return ExecutionAcceptanceResponseSchema.parse({
      contractVersion: request.contractVersion,
      requestId: request.requestId,
      correlation: request.correlation,
      data: {
        commandId: command.commandId,
        executionId: command.executionId,
        executionPlan: command.executionPlan,
        status: command.status,
        replayed: accepted.replayed,
        ...(command.resultReference === undefined
          ? {}
          : { resultReference: command.resultReference }),
        ...(command.errorReference === undefined ? {} : { errorReference: command.errorReference }),
      },
    })
  }

  async #transition(command: CommandInboxRecord, to: 'processing'): Promise<CommandInboxRecord> {
    try {
      return await this.#commands.transitionCommand({
        callerPrincipalId: command.callerPrincipalId,
        operation: command.operation,
        workspaceId: command.workspaceId,
        projectId: command.projectId,
        idempotencyKey: command.idempotencyKey,
        expectedVersion: command.version,
        to,
        transitionedAt: transitionTimestamp(this.#now(), command.lastSeenAt),
      })
    } catch (error) {
      if (error instanceof CommandInboxError && error.code === 'STALE_COMMAND_VERSION') {
        const latest = await this.#commands.repository.get(command)
        if (
          latest?.status === to ||
          latest?.status === 'completed' ||
          latest?.status === 'failed'
        ) {
          return latest
        }
      }
      throw error
    }
  }

  async #markReconciliationRequired(command: CommandInboxRecord): Promise<void> {
    try {
      await this.#commands.transitionCommand({
        callerPrincipalId: command.callerPrincipalId,
        operation: command.operation,
        workspaceId: command.workspaceId,
        projectId: command.projectId,
        idempotencyKey: command.idempotencyKey,
        expectedVersion: command.version,
        to: 'reconciliation_required',
        transitionedAt: transitionTimestamp(this.#now(), command.lastSeenAt),
        errorReference: `restate://submission-unconfirmed/${command.executionId}`,
      })
    } catch (error) {
      if (!(error instanceof CommandInboxError && error.code === 'STALE_COMMAND_VERSION'))
        throw error
    }
  }
}

@Injectable()
export class UnavailableExecutionAcceptanceService implements ExecutionAcceptanceService {
  async accept(): Promise<ExecutionAcceptanceResponse> {
    throw new ServiceUnavailableException({
      code: 'EXECUTION_ACCEPTANCE_NOT_CONFIGURED',
      message: 'Execution acceptance is unavailable',
    })
  }
}

export class RestateWorkflowSubmissionError extends Error {
  constructor() {
    super('Restate workflow submission failed')
    this.name = 'RestateWorkflowSubmissionError'
  }
}

export class RestateExecutionWorkflowDispatcher
  implements ExecutionWorkflowDispatcher, InteractionSignalDispatcher
{
  readonly #fetch: typeof fetch
  readonly #ingressUrl: string

  constructor(options: { readonly ingressUrl: string; readonly fetch?: typeof fetch }) {
    this.#ingressUrl = options.ingressUrl
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  async submit(inputValue: ExecutionWorkflowInput): Promise<void> {
    const input = ExecutionWorkflowInputSchema.parse(inputValue)
    await this.#send(input.executionId, 'run', input)
  }

  async deliver(
    input: InteractionRequest & { response: NonNullable<InteractionRequest['response']> }
  ): Promise<void> {
    const request = InteractionRequestSchema.parse(input)
    if (request.state !== 'responded' || !request.response)
      throw new RestateWorkflowSubmissionError()
    await this.#send(
      request.executionId,
      'respondToInteraction',
      {
        interactionId: request.interactionId,
        responseId: request.response.responseId,
        action: request.response.action,
        ...(request.response.value === undefined ? {} : { value: request.response.value }),
      },
      `${request.interactionId}:${request.response.responseId}`
    )
  }

  async #send(
    executionId: string,
    handler: 'run' | 'respondToInteraction',
    payload: unknown,
    idempotencyKey?: string
  ): Promise<void> {
    const response = await this.#fetch(this.#submissionUrl(executionId, handler), {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(managedCloudOperationalPolicy.payload.publicRequestDeadlineMs),
    }).catch(() => {
      throw new RestateWorkflowSubmissionError()
    })
    if (response.status === 409 && handler === 'run') return
    if (response.status !== 202) throw new RestateWorkflowSubmissionError()
    const body = await response.text()
    if (body.length > 4_096) throw new RestateWorkflowSubmissionError()
    try {
      const parsed: unknown = JSON.parse(body)
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (Reflect.get(parsed, 'status') !== 'Accepted' &&
          Reflect.get(parsed, 'status') !== 'PreviouslyAccepted') ||
        typeof Reflect.get(parsed, 'invocationId') !== 'string' ||
        !/^inv_[A-Za-z0-9]{1,252}$/.test(Reflect.get(parsed, 'invocationId'))
      ) {
        throw new RestateWorkflowSubmissionError()
      }
    } catch (error) {
      if (error instanceof RestateWorkflowSubmissionError) throw error
      throw new RestateWorkflowSubmissionError()
    }
  }

  #submissionUrl(executionId: string, handler: 'run' | 'respondToInteraction'): URL {
    const base = new URL(this.#ingressUrl)
    base.pathname = `${base.pathname.replace(/\/$/, '')}/`
    return new URL(
      `${restateWorkflowName}/${encodeURIComponent(executionId)}/${handler}/send`,
      base
    )
  }
}

export function createExecutionId(): string {
  let value = BigInt(`0x${randomBytes(16).toString('hex')}`)
  let encoded = ''
  for (let index = 0; index < 26; index += 1) {
    encoded = crockfordAlphabet[Number(value & 31n)] + encoded
    value >>= 5n
  }
  return IdentifierSchemas.executionId.parse(`exe_${encoded}`)
}

function workflowIdFromExecutionId(executionId: string): string {
  return `wfl_${executionId.slice(4)}`
}

function workflowDeadline(request: {
  readonly issuedAt: string
  readonly payload: {
    readonly deadlineAt?: string | undefined
    readonly retentionExpiresAt: string
  }
}): string {
  const issuedAt = Date.parse(request.issuedAt)
  const retentionExpiresAt = Date.parse(request.payload.retentionExpiresAt)
  const maximum = issuedAt + managedCloudOperationalPolicy.retention.maximumCommandLifetimeMs
  const deadlineAt =
    request.payload.deadlineAt === undefined
      ? Math.min(maximum, retentionExpiresAt)
      : Date.parse(request.payload.deadlineAt)
  if (deadlineAt <= issuedAt || deadlineAt > retentionExpiresAt || deadlineAt > maximum) {
    throw new BadRequestException({
      code: 'INVALID_EXECUTION_DEADLINE',
      message: 'Execution deadline is outside the accepted command lifetime',
    })
  }
  return new Date(deadlineAt).toISOString()
}

function transitionTimestamp(now: string, previous: string): string {
  return new Date(Math.max(Date.parse(now), Date.parse(previous))).toISOString()
}

function normalizeCommandError(error: unknown): never {
  if (!(error instanceof CommandInboxError)) throw error
  if (error.code === 'INVALID_EXECUTION_PLAN_REFERENCE') {
    throw new UnprocessableEntityException({
      code: error.code,
      message: 'Execution plan reference is invalid',
    })
  }
  if (error.code === 'IDEMPOTENCY_PAYLOAD_CONFLICT' || error.code === 'COMMAND_RETENTION_EXPIRED') {
    throw new ConflictException({ code: error.code, message: 'Execution acceptance conflicted' })
  }
  throw new BadRequestException({ code: error.code, message: 'Execution acceptance was rejected' })
}
