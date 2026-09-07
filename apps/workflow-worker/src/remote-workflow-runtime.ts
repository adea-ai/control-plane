import { isDeepStrictEqual } from 'node:util'
import {
  createQueuedRuntimeCommandRecord,
  type ExecutionAttempt,
  type RuntimeCommandRecord,
  type RuntimeCommandRepository,
} from '@control-plane/domain'
import type { ExecutionPlan } from '@control-plane/execution-plan'
import {
  GatewayCommandEnvelopeSchema,
  type GatewayCommandEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import type { WorkflowInteractionResponse, WorkflowRuntimeOutcome } from './execution-workflow.js'
import type { ExecutionWorkflowInput } from '@control-plane/orchestration'
import type { WorkflowRuntimeActivityPort } from './cloud-execution-activities.js'

export interface RemoteRuntimeAttemptReader {
  getAttempt(attemptId: string): Promise<ExecutionAttempt | undefined>
}

interface RemoteRuntimeCommandInput {
  readonly executionId: string
  readonly attempt: ExecutionAttempt
  readonly effectKey: string
  readonly marketplacePluginReferences?: ExecutionWorkflowInput['marketplacePluginReferences']
}

export interface RemoteRuntimeCommandFactory {
  createExecute(
    input: RemoteRuntimeCommandInput & { readonly executionPlan: ExecutionPlan }
  ): Promise<unknown> | unknown
  createInteraction?(
    input: RemoteRuntimeCommandInput & { readonly response: WorkflowInteractionResponse }
  ): Promise<unknown> | unknown
  createCancel(
    input: RemoteRuntimeCommandInput & {
      readonly reason: 'user_request' | 'deadline'
      // Internal replay input, read from the first persisted command, never a caller lease.
      readonly issuedAt?: string
    }
  ): Promise<unknown> | unknown
}

export interface RemoteRuntimeOutcomeWaiter {
  wait(input: {
    readonly command: RuntimeCommandRecord
    readonly executionId: string
    readonly attemptId: string
  }): Promise<WorkflowRuntimeOutcome>
}

export interface DurableRemoteWorkflowRuntimeOptions {
  readonly attempts: RemoteRuntimeAttemptReader
  readonly commands: RuntimeCommandRepository
  readonly factory: RemoteRuntimeCommandFactory
  readonly waiter: RemoteRuntimeOutcomeWaiter
  readonly now?: () => Date
}

export class DurableRemoteWorkflowRuntime implements WorkflowRuntimeActivityPort {
  readonly #attempts: RemoteRuntimeAttemptReader
  readonly #commands: RuntimeCommandRepository
  readonly #factory: RemoteRuntimeCommandFactory
  readonly #now: () => Date
  readonly #waiter: RemoteRuntimeOutcomeWaiter

  constructor(options: DurableRemoteWorkflowRuntimeOptions) {
    this.#attempts = options.attempts
    this.#commands = options.commands
    this.#factory = options.factory
    this.#waiter = options.waiter
    this.#now = options.now ?? (() => new Date())
  }

  async dispatch(input: {
    readonly executionId: string
    readonly attemptId: string
    readonly executionPlan: ExecutionPlan
    readonly marketplacePluginReferences?: ExecutionWorkflowInput['marketplacePluginReferences']
    readonly effectKey: string
  }): Promise<WorkflowRuntimeOutcome> {
    const attempt = await this.#requiredAttempt(input.executionId, input.attemptId)
    const command = GatewayCommandEnvelopeSchema.parse(
      await this.#factory.createExecute({
        executionId: input.executionId,
        attempt,
        executionPlan: input.executionPlan,
        ...(input.marketplacePluginReferences === undefined
          ? {}
          : { marketplacePluginReferences: input.marketplacePluginReferences }),
        effectKey: input.effectKey,
      })
    )
    if (command.operation !== 'runtime.execute') throw new Error('REMOTE_RUNTIME_OPERATION_INVALID')
    return this.#enqueueAndWait(command, attempt, input.executionPlan.correlation.workspaceId)
  }

  async applyInteraction(
    input: WorkflowInteractionResponse & {
      readonly executionId: string
      readonly attemptId: string
      readonly effectKey: string
    }
  ): Promise<WorkflowRuntimeOutcome> {
    if (this.#factory.createInteraction === undefined) {
      throw new Error('REMOTE_RUNTIME_INTERACTION_UNCONFIGURED')
    }
    const attempt = await this.#requiredAttempt(input.executionId, input.attemptId)
    const command = GatewayCommandEnvelopeSchema.parse(
      await this.#factory.createInteraction({
        executionId: input.executionId,
        attempt,
        response: input,
        effectKey: input.effectKey,
      })
    )
    if (!['runtime.input', 'runtime.approval', 'runtime.cancel'].includes(command.operation)) {
      throw new Error('REMOTE_RUNTIME_OPERATION_INVALID')
    }
    return this.#enqueueAndWait(command, attempt, command.workspaceId)
  }

  async cancel(input: {
    readonly executionId: string
    readonly attemptId: string
    readonly effectKey: string
    readonly reason: 'user_request' | 'deadline'
  }): Promise<void> {
    const attempt = await this.#requiredAttempt(input.executionId, input.attemptId)
    const command = GatewayCommandEnvelopeSchema.parse(
      await this.#factory.createCancel({
        executionId: input.executionId,
        attempt,
        effectKey: input.effectKey,
        reason: input.reason,
      })
    )
    if (command.operation !== 'runtime.cancel') throw new Error('REMOTE_RUNTIME_OPERATION_INVALID')
    await this.#enqueueAndWait(command, attempt, command.workspaceId, (issuedAt) =>
      this.#factory.createCancel({
        executionId: input.executionId,
        attempt,
        effectKey: input.effectKey,
        reason: input.reason,
        issuedAt,
      })
    )
  }

  async cleanup(): Promise<void> {}

  async #requiredAttempt(executionId: string, attemptId: string): Promise<ExecutionAttempt> {
    const attempt = await this.#attempts.getAttempt(attemptId)
    if (
      attempt === undefined ||
      attempt.executionId !== executionId ||
      attempt.runtime === undefined
    ) {
      throw new Error('REMOTE_RUNTIME_ATTEMPT_MISSING')
    }
    if (
      attempt.runtime.runtimeNodeRefId === undefined ||
      attempt.runtime.runtimeConnectionId === undefined
    ) {
      throw new Error('REMOTE_RUNTIME_ROUTE_MISSING')
    }
    return attempt
  }

  async #enqueueAndWait(
    command: GatewayCommandEnvelope,
    attempt: ExecutionAttempt,
    workspaceId: string,
    replayAt?: (issuedAt: string) => Promise<unknown> | unknown
  ): Promise<WorkflowRuntimeOutcome> {
    const record = await this.#enqueue(command, attempt, workspaceId, replayAt)
    return this.#waiter.wait({
      command: record,
      executionId: attempt.executionId,
      attemptId: attempt.attemptId,
    })
  }

  async #enqueue(
    command: GatewayCommandEnvelope,
    attempt: ExecutionAttempt,
    workspaceId: string,
    replayAt?: (issuedAt: string) => Promise<unknown> | unknown
  ): Promise<RuntimeCommandRecord> {
    if (
      command.executionId !== attempt.executionId ||
      command.attemptId !== attempt.attemptId ||
      command.workspaceId !== workspaceId ||
      command.nodeId !== attempt.runtime?.runtimeNodeRefId ||
      command.runtimeConnectionId !== attempt.runtime.runtimeConnectionId
    ) {
      throw new Error('REMOTE_RUNTIME_COMMAND_SCOPE_MISMATCH')
    }
    const record = createQueuedRuntimeCommandRecord(command, this.#now().toISOString())
    const created = await this.#commands.create(record)
    if (created.outcome === 'conflict') {
      // A retry may be constructed at a later time. Never replace or renew the
      // persisted lease: compare the complete command using its original times.
      // This also handles JSONB object-key ordering without weakening payload,
      // driver, protocol, capability, idempotency or scope comparisons.
      const original = created.record.commandEnvelope
      // Cancellation embeds requestedAt in its hashed payload. Rebuild it from
      // persisted issuance time, then compare every semantic field as usual.
      const candidate =
        replayAt === undefined
          ? command
          : GatewayCommandEnvelopeSchema.parse(await replayAt(created.record.issuedAt))
      const replay = {
        ...candidate,
        sentAt: original['sentAt'],
        issuedAt: original['issuedAt'],
        expiresAt: original['expiresAt'],
      }
      if (!isDeepStrictEqual(original, replay)) {
        throw new Error('REMOTE_RUNTIME_COMMAND_CONFLICT')
      }
    }
    return created.record
  }
}
