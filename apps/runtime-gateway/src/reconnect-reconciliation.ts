import type { RuntimeCommandRecord, RuntimeCommandRepository } from '@control-plane/domain'
import {
  GatewayHelloEnvelopeSchema,
  type GatewayRetainedCommandOutcome,
} from '@control-plane/runtime-gateway-protocol'
import type { RuntimeCommandDeliveryService } from './runtime-command-delivery.js'
import type { ActiveRuntimeNodeChannelRecord, GatewayMetrics } from './websocket-coordination.js'

export type ReconnectInvalidReason =
  | 'node_revoked'
  | 'grant_revoked'
  | 'runtime_incompatible'
  | 'capability_changed'
export type ReconnectManualReason =
  | ReconnectInvalidReason
  | 'acknowledged_without_outcome'
  | 'unknown_retained_outcome'

export interface ReconnectCommandValidator {
  validate(
    command: RuntimeCommandRecord
  ): Promise<
    { readonly valid: true } | { readonly valid: false; readonly reason: ReconnectInvalidReason }
  >
}

export interface RetainedCommandOutcomeApplier {
  apply(command: RuntimeCommandRecord, outcome: GatewayRetainedCommandOutcome): Promise<void>
}

export interface ExecutionReconnectReconciler {
  reconcile(executionId: string): Promise<unknown>
  requireManualIntervention(input: {
    readonly executionId: string
    readonly commandId: string
    readonly reason: ReconnectManualReason
  }): Promise<void>
}

export interface RuntimeReconnectReconciliationOptions {
  readonly repository: RuntimeCommandRepository
  readonly delivery: RuntimeCommandDeliveryService
  readonly validator: ReconnectCommandValidator
  readonly outcomes: RetainedCommandOutcomeApplier
  readonly executions: ExecutionReconnectReconciler
  readonly metrics: GatewayMetrics
  readonly now?: () => Date
  readonly limit?: number
}

export interface RuntimeReconnectReconciliationResult {
  readonly redelivered: number
  readonly reused: number
  readonly appliedTerminal: number
  readonly active: number
  readonly manualIntervention: number
  readonly expired: number
  readonly invalid: number
}

export class RuntimeReconnectReconciliationError extends Error {
  constructor(readonly code: 'RECONNECT_SCOPE_MISMATCH' | 'RECONNECT_OUTCOME_CONFLICT') {
    super(code)
    this.name = 'RuntimeReconnectReconciliationError'
  }
}

export class RuntimeReconnectReconciliationService {
  readonly #delivery: RuntimeCommandDeliveryService
  readonly #executions: ExecutionReconnectReconciler
  readonly #limit: number
  readonly #metrics: GatewayMetrics
  readonly #now: () => Date
  readonly #outcomes: RetainedCommandOutcomeApplier
  readonly #repository: RuntimeCommandRepository
  readonly #validator: ReconnectCommandValidator

  constructor(options: RuntimeReconnectReconciliationOptions) {
    this.#repository = options.repository
    this.#delivery = options.delivery
    this.#validator = options.validator
    this.#outcomes = options.outcomes
    this.#executions = options.executions
    this.#metrics = options.metrics
    this.#now = options.now ?? (() => new Date())
    this.#limit = options.limit ?? 256
    if (!Number.isSafeInteger(this.#limit) || this.#limit < 1 || this.#limit > 1_000) {
      throw new Error('Invalid reconnect reconciliation limit')
    }
  }

  async reconcile(
    helloValue: unknown,
    source: ActiveRuntimeNodeChannelRecord
  ): Promise<RuntimeReconnectReconciliationResult> {
    const started = this.#now().getTime()
    const hello = GatewayHelloEnvelopeSchema.parse(helloValue)
    if (
      hello.nodeId !== source.nodeId ||
      hello.workspaceId !== source.workspaceId ||
      hello.channelGeneration !== source.channelGeneration ||
      hello.protocolVersion.major !== source.protocolVersion.major ||
      hello.protocolVersion.minor > source.protocolVersion.minor
    ) {
      throw new RuntimeReconnectReconciliationError('RECONNECT_SCOPE_MISMATCH')
    }
    const result = {
      redelivered: 0,
      reused: 0,
      appliedTerminal: 0,
      active: 0,
      manualIntervention: 0,
      expired: 0,
      invalid: 0,
    }
    const retained = new Map(
      (hello.retainedCommandOutcomes ?? []).map((outcome) => [outcome.commandId, outcome])
    )
    for (const outcome of retained.values()) {
      const command = await this.#repository.get(outcome.commandId)
      if (!command) {
        result.manualIntervention++
        this.#metrics.increment('runtime_gateway.recovery_unknown_outcomes')
        continue
      }
      this.#assertOutcome(command, outcome, source)
      if (['succeeded', 'failed', 'cancelled'].includes(command.status)) {
        if (command.status !== outcome.status) this.#conflict()
        result.reused++
        continue
      }
      const validation = await this.#validator.validate(command)
      if (!validation.valid) {
        result.invalid++
        await this.#manual(command, validation.reason, result)
        continue
      }
      if (['succeeded', 'failed', 'cancelled'].includes(outcome.status)) {
        await this.#outcomes.apply(command, outcome)
        result.appliedTerminal++
        await this.#executions.reconcile(command.executionId)
      } else if (['accepted', 'running', 'cancelling'].includes(outcome.status)) {
        result.active++
        await this.#executions.reconcile(command.executionId)
      } else {
        await this.#manual(command, 'unknown_retained_outcome', result)
      }
    }

    const pending = await this.#repository.listDispatchable(
      source.nodeId,
      this.#now().toISOString(),
      this.#limit
    )
    let sequence = Math.max(hello.lastAcknowledgedSequence + 1, 1)
    for (const command of pending) {
      if (retained.has(command.commandId)) continue
      if (Date.parse(command.expiresAt) <= this.#now().getTime()) {
        await this.#delivery.deliver(command.commandId, {
          channelGeneration: source.channelGeneration,
          sequence: sequence++,
        })
        result.expired++
        continue
      }
      const validation = await this.#validator.validate(command)
      if (!validation.valid) {
        result.invalid++
        await this.#manual(command, validation.reason, result)
        continue
      }
      const safelyUnacknowledged =
        command.status === 'queued' ||
        (command.lastSequence !== undefined &&
          command.lastSequence > hello.lastAcknowledgedSequence)
      if (!safelyUnacknowledged) {
        await this.#manual(command, 'acknowledged_without_outcome', result)
        continue
      }
      await this.#delivery.deliver(command.commandId, {
        channelGeneration: source.channelGeneration,
        sequence: sequence++,
      })
      result.redelivered++
      this.#metrics.increment('runtime_gateway.recovery_redeliveries')
    }
    this.#metrics.observe(
      'runtime_gateway.recovery_duration_ms',
      Math.max(0, this.#now().getTime() - started)
    )
    return result
  }

  async #manual(
    command: RuntimeCommandRecord,
    reason: ReconnectManualReason,
    result: { manualIntervention: number }
  ): Promise<void> {
    result.manualIntervention++
    this.#metrics.increment('runtime_gateway.recovery_manual_intervention')
    await this.#executions.requireManualIntervention({
      executionId: command.executionId,
      commandId: command.commandId,
      reason,
    })
  }

  #assertOutcome(
    command: RuntimeCommandRecord,
    outcome: GatewayRetainedCommandOutcome,
    source: ActiveRuntimeNodeChannelRecord
  ): void {
    if (
      command.nodeId !== source.nodeId ||
      command.workspaceId !== source.workspaceId ||
      command.payloadHash !== outcome.payloadHash
    ) {
      this.#conflict()
    }
  }

  #conflict(): never {
    throw new RuntimeReconnectReconciliationError('RECONNECT_OUTCOME_CONFLICT')
  }
}
