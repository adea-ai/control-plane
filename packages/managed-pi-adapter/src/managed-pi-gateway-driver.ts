import {
  GatewayCommandEnvelopeSchema,
  GrantReferenceSchema,
  type GatewayCommandEnvelope,
  type GatewayProgressEnvelope,
  type GatewayResultEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import {
  RuntimeExecutionHandleSchema,
  type RuntimeExecutionHandle,
} from '@control-plane/runtime-sdk'
import { z } from 'zod'
import { ManagedPiConfigurationSchema, type ManagedPiEvent, type ManagedPiStatus } from './index.js'
import { type LocalProjectGrantState } from './managed-pi-gateway-types.js'
import {
  failureResult,
  inlineParameters,
  progressEnvelope,
  scenarioExecution,
  successResult,
} from './managed-pi-gateway-protocol.js'

export type ReferenceManagedPiScenario =
  | 'complete'
  | 'running'
  | 'awaiting_input'
  | 'crash'
  | 'timeout'
  | 'ambiguous'

export interface ReferenceExecution {
  readonly handle: RuntimeExecutionHandle
  readonly events: ManagedPiEvent[]
  status: ManagedPiStatus
}

export interface ReferenceManagedPiDriverOptions {
  readonly now?: () => string
  readonly scenario?: ReferenceManagedPiScenario
}

export class ReferenceManagedPiDriver {
  readonly #now: () => string
  readonly #scenario: ReferenceManagedPiScenario
  readonly #grants = new Map<string, LocalProjectGrantState>()
  readonly #executions = new Map<string, ReferenceExecution>()
  readonly #effects = new Map<string, number>()

  constructor(options: ReferenceManagedPiDriverOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#scenario = options.scenario ?? 'complete'
  }

  setGrantState(grantRef: string, state: LocalProjectGrantState): void {
    this.#grants.set(GrantReferenceSchema.parse(grantRef), state)
  }

  grantState(grantRef: string): LocalProjectGrantState {
    return this.#grants.get(GrantReferenceSchema.parse(grantRef)) ?? 'missing'
  }

  effectCount(attemptId: string, operation: GatewayCommandEnvelope['operation']): number {
    return this.#effects.get(`${attemptId}:${operation}`) ?? 0
  }

  handle(commandInput: GatewayCommandEnvelope): {
    readonly progress: GatewayProgressEnvelope[]
    readonly result: GatewayResultEnvelope
  } {
    const command = GatewayCommandEnvelopeSchema.parse(commandInput)
    this.#increment(command)
    switch (command.operation) {
      case 'runtime.execute':
        return this.#execute(command)
      case 'runtime.status':
        return this.#status(command)
      case 'runtime.input':
        return this.#input(command)
      case 'runtime.approval':
        return this.#approval(command)
      case 'runtime.cancel':
        return this.#cancel(command)
      default:
        return {
          progress: [],
          result: failureResult(
            command,
            'MANAGED_PI_OPERATION_UNSUPPORTED',
            'unsupported',
            false,
            this.#now()
          ),
        }
    }
  }

  #execute(command: GatewayCommandEnvelope): {
    progress: GatewayProgressEnvelope[]
    result: GatewayResultEnvelope
  } {
    const parameters = z
      .object({
        configuration: ManagedPiConfigurationSchema,
        grantRef: GrantReferenceSchema,
      })
      .strict()
      .parse(inlineParameters(command))
    const grantState = this.grantState(parameters.grantRef)
    if (grantState !== 'granted') {
      return {
        progress: [],
        result: failureResult(
          command,
          grantState === 'revoked' ? 'LOCAL_PROJECT_GRANT_REVOKED' : 'LOCAL_PROJECT_GRANT_MISSING',
          'validation',
          false,
          this.#now()
        ),
      }
    }
    const handle = RuntimeExecutionHandleSchema.parse({
      handleId: `managed-pi:${command.attemptId}`,
      attemptId: command.attemptId,
      startedAt: this.#now(),
    })
    const execution = scenarioExecution(handle, this.#scenario, this.#now())
    this.#executions.set(handle.handleId, execution)
    return {
      progress: execution.events.map((event) => progressEnvelope(command, event)),
      result: successResult(command, { handle }, this.#now()),
    }
  }

  #status(command: GatewayCommandEnvelope): {
    progress: GatewayProgressEnvelope[]
    result: GatewayResultEnvelope
  } {
    const parameters = z
      .object({ handleId: z.string().min(1).max(256), reconcile: z.boolean() })
      .strict()
      .parse(inlineParameters(command))
    const execution = this.#execution(parameters.handleId)
    return {
      progress: [],
      result: successResult(command, { status: execution.status }, this.#now()),
    }
  }

  #input(command: GatewayCommandEnvelope): {
    progress: GatewayProgressEnvelope[]
    result: GatewayResultEnvelope
  } {
    const parameters = z
      .object({
        handleId: z.string().min(1).max(256),
        interactionId: z.string().min(1).max(512),
        text: z.string().min(1).max(1_000_000),
      })
      .strict()
      .parse(inlineParameters(command))
    const execution = this.#execution(parameters.handleId)
    if (execution.status.state === 'waiting_input') {
      execution.status = { state: 'running', observedAt: this.#now() }
    }
    return {
      progress: [],
      result: successResult(command, { status: execution.status }, this.#now()),
    }
  }

  #approval(command: GatewayCommandEnvelope): {
    progress: GatewayProgressEnvelope[]
    result: GatewayResultEnvelope
  } {
    const parameters = z
      .object({
        handleId: z.string().min(1).max(256),
        interactionId: z.string().min(1).max(512),
        decision: z.enum(['approve', 'deny']),
        reason: z.string().min(1).max(4096).optional(),
      })
      .strict()
      .parse(inlineParameters(command))
    const execution = this.#execution(parameters.handleId)
    if (execution.status.state === 'waiting_input') {
      execution.status = { state: 'running', observedAt: this.#now() }
    }
    return {
      progress: [],
      result: successResult(command, { status: execution.status }, this.#now()),
    }
  }

  #cancel(command: GatewayCommandEnvelope): {
    progress: GatewayProgressEnvelope[]
    result: GatewayResultEnvelope
  } {
    const parameters = z
      .object({
        handleId: z.string().min(1).max(256),
        requestedAt: z.iso.datetime(),
      })
      .strict()
      .parse(inlineParameters(command))
    const execution = this.#execution(parameters.handleId)
    execution.status = { state: 'cancelled', observedAt: parameters.requestedAt }
    return {
      progress: [],
      result: successResult(command, { status: execution.status }, this.#now()),
    }
  }

  #execution(handleId: string): ReferenceExecution {
    const execution = this.#executions.get(handleId)
    if (!execution) throw new Error('REFERENCE_MANAGED_PI_EXECUTION_MISSING')
    return execution
  }

  #increment(command: GatewayCommandEnvelope): void {
    const key = `${command.attemptId}:${command.operation}`
    this.#effects.set(key, (this.#effects.get(key) ?? 0) + 1)
  }
}
