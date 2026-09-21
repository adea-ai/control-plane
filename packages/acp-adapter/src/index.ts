import {
  TransportedRuntimeAdapter,
  type RuntimeAdapter,
  type RuntimeAdapterInspection,
  type RuntimeApprovalRequest,
  type RuntimeCancelRequest,
  type RuntimeExecutionHandle,
  type RuntimeExecutionProgress,
  type RuntimeExecutionStatus,
  type RuntimeInputRequest,
  type RuntimeProgressOptions,
  type RuntimeSessionOperation,
  type RuntimeSessionResult,
} from '@control-plane/runtime-sdk'
import { createAcpDriverState, type AcpDriverState } from './acp-driver-state.js'
import type { AcpAdapterOptions, AcpDriverOptions } from './acp-driver-types.js'
import { executionStatus, cleanupExecution, startExecution } from './acp-driver-execution.js'
import {
  cancelExecution,
  progressUpdates,
  submitDriverApproval,
  submitDriverInput,
} from './acp-driver-interactions.js'
import { sessionDriverOperation } from './acp-driver-sessions.js'
import { inspectDriver } from './acp-driver-transport.js'

export { AcpUpdateSchema, AcpSnapshotSchema } from './acp-schemas.js'
export { ReferenceAcpTransport } from './reference-transport.js'
export type { AcpUpdate, AcpSnapshot } from './acp-schemas.js'
export type {
  AcpAdapterOptions,
  AcpDriverOptions,
  AcpExternalSessionsOptions,
  AcpSessionReplay,
  AcpTransport,
  AcpTransportCall,
} from './acp-driver-types.js'

/**
 * ACP protocol state machine. Shared protocol state lives on the instance in a
 * single private record (`#state`) so the subsystem modules under
 * `acp-driver-*.ts` can each own one concern without splitting ownership of
 * maps, counters, and uncertainty tracking that span concerns.
 */
export class AcpDriver implements RuntimeAdapter {
  readonly #state: AcpDriverState

  constructor(options: AcpDriverOptions) {
    this.#state = createAcpDriverState(options)
  }

  async inspect(
    requirements?: Parameters<RuntimeAdapter['inspect']>[0]
  ): Promise<RuntimeAdapterInspection> {
    return inspectDriver(this.#state, requirements)
  }

  async start(
    requestInput: Parameters<RuntimeAdapter['start']>[0]
  ): Promise<RuntimeExecutionHandle> {
    return startExecution(this.#state, requestInput)
  }

  async *progress(
    handleInput: RuntimeExecutionHandle,
    options: RuntimeProgressOptions = {}
  ): AsyncIterable<RuntimeExecutionProgress> {
    yield* progressUpdates(this.#state, handleInput, options)
  }

  async submitInput(
    handleInput: RuntimeExecutionHandle,
    requestInput: RuntimeInputRequest
  ): Promise<RuntimeExecutionStatus> {
    return submitDriverInput(this.#state, handleInput, requestInput)
  }

  async submitApproval(
    handleInput: RuntimeExecutionHandle,
    requestInput: RuntimeApprovalRequest
  ): Promise<RuntimeExecutionStatus> {
    return submitDriverApproval(this.#state, handleInput, requestInput)
  }

  async cancel(
    handleInput: RuntimeExecutionHandle,
    requestInput: RuntimeCancelRequest
  ): Promise<RuntimeExecutionStatus> {
    return cancelExecution(this.#state, handleInput, requestInput)
  }

  async status(handleInput: RuntimeExecutionHandle): Promise<RuntimeExecutionStatus> {
    return executionStatus(this.#state, handleInput)
  }

  reconcile(handle: RuntimeExecutionHandle): Promise<RuntimeExecutionStatus> {
    return this.status(handle)
  }

  async session(operationInput: RuntimeSessionOperation): Promise<RuntimeSessionResult> {
    return sessionDriverOperation(this.#state, operationInput)
  }

  async cleanup(handleInput: RuntimeExecutionHandle): Promise<void> {
    return cleanupExecution(this.#state, handleInput)
  }
}

export class AcpAdapter extends TransportedRuntimeAdapter {
  constructor(options: AcpAdapterOptions) {
    super(options.transport, 'acp')
  }
}

export * from './acp-helpers.js'
export * from './reference-transport.js'
export * from './acp-utils.js'
