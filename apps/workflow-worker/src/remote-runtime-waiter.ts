import type { Execution, RuntimeCommandRecord } from '@control-plane/domain'
import type { ExecutionEvent } from '@control-plane/events'
import { GatewayCommandEnvelopeSchema } from '@control-plane/runtime-gateway-protocol'
import type { RemoteRuntimeOutcomeWaiter } from './remote-workflow-runtime.js'
import type { WorkflowRuntimeOutcome } from './execution-workflow.js'

export interface RemoteRuntimeExecutionReader {
  getExecution(executionId: string): Promise<Execution | undefined>
}

export interface RemoteRuntimeCommandReader {
  get(commandId: string): Promise<RuntimeCommandRecord | undefined>
}

export interface RemoteRuntimeEventReader {
  latestInteraction(executionId: string, attemptId: string): Promise<ExecutionEvent | undefined>
}

export interface PollingRemoteRuntimeOutcomeWaiterOptions {
  readonly executions: RemoteRuntimeExecutionReader
  readonly commands: RemoteRuntimeCommandReader
  readonly events: RemoteRuntimeEventReader
  readonly now?: () => Date
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly pollIntervalMs?: number
}

export class PollingRemoteRuntimeOutcomeWaiter implements RemoteRuntimeOutcomeWaiter {
  readonly #commands: RemoteRuntimeCommandReader
  readonly #events: RemoteRuntimeEventReader
  readonly #executions: RemoteRuntimeExecutionReader
  readonly #now: () => Date
  readonly #pollIntervalMs: number
  readonly #sleep: (milliseconds: number) => Promise<void>

  constructor(options: PollingRemoteRuntimeOutcomeWaiterOptions) {
    this.#executions = options.executions
    this.#commands = options.commands
    this.#events = options.events
    this.#now = options.now ?? (() => new Date())
    this.#sleep = options.sleep ?? sleep
    this.#pollIntervalMs = options.pollIntervalMs ?? 250
    if (
      !Number.isSafeInteger(this.#pollIntervalMs) ||
      this.#pollIntervalMs < 10 ||
      this.#pollIntervalMs > 10_000
    ) {
      throw new Error('REMOTE_RUNTIME_POLL_INTERVAL_INVALID')
    }
  }

  async wait(input: {
    readonly command: RuntimeCommandRecord
    readonly executionId: string
    readonly attemptId: string
  }): Promise<WorkflowRuntimeOutcome> {
    const envelope = GatewayCommandEnvelopeSchema.parse(input.command.commandEnvelope)
    const operation = envelope.operation
    const parameters = 'parameters' in envelope.payload ? envelope.payload.parameters : undefined
    const respondedInteractionId =
      (operation === 'runtime.approval' || operation === 'runtime.input') &&
      typeof parameters === 'object' &&
      parameters !== null &&
      !Array.isArray(parameters) &&
      typeof parameters['interactionId'] === 'string'
        ? parameters['interactionId']
        : undefined
    for (;;) {
      const execution = await this.#executions.getExecution(input.executionId)
      if (execution === undefined) throw new Error('REMOTE_RUNTIME_EXECUTION_MISSING')
      const outcome = await this.#executionOutcome(
        execution,
        input.attemptId,
        operation === 'runtime.cancel',
        respondedInteractionId
      )
      if (outcome !== undefined) return outcome
      const command = await this.#commands.get(input.command.commandId)
      if (command === undefined) throw new Error('REMOTE_RUNTIME_COMMAND_MISSING')
      if (command.status === 'failed') {
        return {
          outcome: 'failed',
          failureCode: 'REMOTE_RUNTIME_COMMAND_FAILED',
          retryable: false,
        }
      }
      if (command.status === 'cancelled') return { outcome: 'cancelled' }
      if (operation === 'runtime.cancel' && command.status === 'succeeded') {
        return { outcome: 'cancelled' }
      }
      if (
        command.status === 'expired' ||
        this.#now().getTime() >= Date.parse(input.command.expiresAt)
      ) {
        return {
          outcome: 'failed',
          failureCode: 'REMOTE_RUNTIME_COMMAND_EXPIRED',
          retryable: true,
        }
      }
      await this.#sleep(this.#pollIntervalMs)
    }
  }

  async #executionOutcome(
    execution: Execution,
    attemptId: string,
    cancelling: boolean,
    respondedInteractionId?: string
  ): Promise<WorkflowRuntimeOutcome | undefined> {
    if (execution.state === 'completed') {
      if (execution.terminalResultRef === undefined) {
        throw new Error('REMOTE_RUNTIME_RESULT_REFERENCE_MISSING')
      }
      return { outcome: 'completed', resultReference: execution.terminalResultRef }
    }
    if (execution.state === 'failed') {
      return {
        outcome: 'failed',
        failureCode: execution.failure?.code ?? 'REMOTE_RUNTIME_FAILED',
        retryable: false,
      }
    }
    if (execution.state === 'cancelled') return { outcome: 'cancelled' }
    if (execution.state === 'timed_out') {
      return { outcome: 'failed', failureCode: 'REMOTE_RUNTIME_TIMED_OUT', retryable: false }
    }
    // Control delivery can precede the next execution-state event. Do not
    // re-suspend on the interaction this command answered, or let any pending
    // interaction hide cancellation confirmation/expiry.
    if (execution.state !== 'awaiting_input' || cancelling) return undefined
    const interaction = await this.#events.latestInteraction(execution.executionId, attemptId)
    const interactionId = interaction?.payload['interactionId']
    return typeof interactionId === 'string' && interactionId !== respondedInteractionId
      ? { outcome: 'awaiting_input', interactionId }
      : undefined
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
