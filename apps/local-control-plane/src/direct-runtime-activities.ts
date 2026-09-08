import { createHash } from 'node:crypto'
import type { LocalRuntimeInteractions } from './runtime-interactions.js'
import type { JsonValue, ObjectStore, PersistenceProvider } from '@control-plane/deployment'
import type {
  RuntimeExecutionHandle,
  RuntimeExecutionStatus,
  RuntimeAdapterWithTransport,
} from '@control-plane/runtime-sdk'
import { RuntimeExecutionStatusSchema } from '@control-plane/runtime-sdk'
import type {
  WorkflowInteractionValue,
  WorkflowRuntimeOutcome,
} from '@control-plane/workflow-runtime'
import type { WorkflowRuntimeActivityPort } from '@control-plane/workflow-worker'

const namespaces = {
  effects: 'workflow-effects',
  handles: 'runtime-handles',
  cancellations: 'runtime-cancellations',
  terminalUsage: 'runtime-terminal-usage',
} as const

interface DirectRuntimeCancellationIntent {
  readonly attemptId: string
  readonly effectKey: string
  readonly reason: 'user_request' | 'deadline'
  readonly requestedAt: string
}

export class DirectRuntimeActivityPort implements WorkflowRuntimeActivityPort {
  readonly #dispatches = new Map<string, Promise<WorkflowRuntimeOutcome>>()

  constructor(
    readonly persistence: PersistenceProvider,
    readonly objectStore: ObjectStore,
    readonly runtime: RuntimeAdapterWithTransport,
    readonly interactions?: LocalRuntimeInteractions
  ) {
    if (runtime.transportKind !== 'direct-local') {
      throw new Error('DIRECT_RUNTIME_TRANSPORT_REQUIRED')
    }
  }

  dispatch(
    input: Parameters<WorkflowRuntimeActivityPort['dispatch']>[0]
  ): Promise<WorkflowRuntimeOutcome> {
    const pending = this.#dispatches.get(input.effectKey)
    if (pending !== undefined) return pending
    const operation = this.#dispatch(input)
    this.#dispatches.set(input.effectKey, operation)
    const release = () => this.#dispatches.delete(input.effectKey)
    void operation.then(release, release)
    return operation
  }

  async #dispatch(
    input: Parameters<WorkflowRuntimeActivityPort['dispatch']>[0]
  ): Promise<WorkflowRuntimeOutcome> {
    const resultId = recordId(input.effectKey)
    const intentId = recordId(`dispatch-intent:${input.effectKey}`)
    const admission = await this.persistence.transaction(async (transaction) => {
      const result = await transaction.get(namespaces.effects, resultId)
      if (result !== undefined) return { result: result.value }
      const intent = await transaction.get(namespaces.effects, intentId)
      if (intent !== undefined) return { claimed: false }
      const previousHandle = await transaction.get(namespaces.handles, recordId(input.executionId))
      if (
        (previousHandle?.value as unknown as RuntimeExecutionHandle | undefined)?.attemptId ===
        input.attemptId
      )
        return { claimed: false }
      // Commit before calling the runtime: a lost ACK or process crash cannot
      // make replay indistinguishable from a never-dispatched attempt.
      await transaction.put({
        namespace: namespaces.effects,
        id: intentId,
        value: {
          kind: 'dispatch-intent',
          executionId: input.executionId,
          attemptId: input.attemptId,
        },
      })
      return { claimed: true }
    })
    if ('result' in admission) return admission.result as WorkflowRuntimeOutcome
    if (!admission.claimed) {
      const handle = await this.#handle(input.executionId, input.attemptId, false)
      if (handle !== undefined) {
        let recovered: RuntimeExecutionStatus | undefined
        try {
          recovered = RuntimeExecutionStatusSchema.parse(await this.runtime.reconcile(handle))
        } catch {
          // Missing native state is ambiguous, not permission to restart work.
        }
        if (
          recovered !== undefined &&
          recovered.handle.handleId === handle.handleId &&
          recovered.handle.attemptId === handle.attemptId &&
          recovered.handle.startedAt === handle.startedAt &&
          ['completed', 'failed', 'cancelled', 'timed_out'].includes(recovered.state)
        ) {
          const status = recovered
          return this.#effect(input.effectKey, () =>
            this.#outcome(input.executionId, input.attemptId, status)
          )
        }
      }
      // Do not cache this observation over a concurrent owner's eventual result.
      // The retained intent requires reconciliation before an operator retries.
      return {
        outcome: 'failed',
        failureCode: 'LOCAL_RUNTIME_DISPATCH_AMBIGUOUS',
        retryable: false,
      }
    }
    return this.#effect(input.effectKey, async () => {
      const handle = await this.runtime.start({
        attemptId: input.attemptId,
        idempotencyKey: input.effectKey,
        executionPlan:
          input.marketplacePluginReferences === undefined
            ? input.executionPlan
            : {
                ...input.executionPlan,
                marketplacePluginReferences: input.marketplacePluginReferences,
              },
      })
      await this.#saveHandle(input.executionId, handle)
      const cancellation = await this.#cancellation(input.executionId)
      if (cancellation !== undefined) {
        this.#assertAttempt(handle, cancellation.attemptId)
        await this.#cancelHandle(input.executionId, handle, cancellation)
        return { outcome: 'cancelled' }
      }
      return this.#observe(input.executionId, input.attemptId, handle)
    })
  }

  applyInteraction(input: {
    interactionId: string
    responseId: string
    action: 'approve' | 'deny' | 'input' | 'grant' | 'resume' | 'cancel'
    value?: WorkflowInteractionValue
    executionId: string
    attemptId: string
    effectKey: string
  }): Promise<WorkflowRuntimeOutcome> {
    return this.#effect(input.effectKey, async () => {
      const handle = await this.#handle(input.executionId, input.attemptId, true)
      await this.interactions?.assertResponse(input)
      let status: RuntimeExecutionStatus
      if (input.action === 'approve' || input.action === 'deny' || input.action === 'grant') {
        status = await this.runtime.submitApproval(handle, {
          interactionId: input.interactionId,
          idempotencyKey: input.effectKey,
          decision: input.action === 'grant' ? 'approve' : input.action,
        })
      } else if (input.action === 'cancel') {
        status = await this.runtime.cancel(handle, {
          idempotencyKey: input.effectKey,
          requestedAt: new Date().toISOString(),
        })
      } else if (input.action === 'input' && input.value !== undefined) {
        const text = typeof input.value === 'string' ? input.value : JSON.stringify(input.value)
        if (text.length === 0) {
          return {
            outcome: 'failed',
            failureCode: 'LOCAL_INTERACTION_PAYLOAD_INVALID',
            retryable: false,
          }
        }
        status = await this.runtime.submitInput(handle, {
          interactionId: input.interactionId,
          idempotencyKey: input.effectKey,
          text,
        })
      } else {
        return {
          outcome: 'failed',
          failureCode: 'LOCAL_INTERACTION_PAYLOAD_UNAVAILABLE',
          retryable: false,
        }
      }
      if (['starting', 'running', 'awaiting_input'].includes(status.state))
        return this.#observe(input.executionId, input.attemptId, handle, input.interactionId)
      return this.#outcome(input.executionId, input.attemptId, status)
    })
  }

  async #observe(
    executionId: string,
    attemptId: string,
    handle: RuntimeExecutionHandle,
    respondedInteractionId?: string
  ): Promise<WorkflowRuntimeOutcome> {
    let interactionId: string | undefined
    for await (const progress of this.runtime.progress(handle)) {
      const candidate = progress.data['interactionId']
      if (progress.type !== 'interaction' || typeof candidate !== 'string') continue
      // Progress is replayable. Previously resolved requests must not suspend
      // this resumed turn again; their durable records retain the scope check.
      const pending = await this.interactions?.record(executionId, attemptId, progress)
      if (pending === false || candidate === respondedInteractionId) continue
      interactionId = candidate
      break
    }
    return this.#outcome(executionId, attemptId, await this.runtime.status(handle), interactionId)
  }

  async cancel(input: {
    executionId: string
    attemptId: string
    effectKey: string
    reason: 'user_request' | 'deadline'
  }): Promise<void> {
    const existingHandle = await this.#handle(input.executionId, input.attemptId, false)
    const intent = await this.#recordCancellation(input)
    const handle = existingHandle ?? (await this.#handle(input.executionId, input.attemptId, false))
    if (handle !== undefined) await this.#cancelHandle(input.executionId, handle, intent)
  }

  async cleanup(input: {
    executionId: string
    attemptId?: string
    effectKey: string
  }): Promise<void> {
    await this.#effect(input.effectKey, async () => {
      const handle = await this.#handle(input.executionId, input.attemptId, false)
      const attemptId = input.attemptId ?? handle?.attemptId
      if (attemptId !== undefined)
        await this.interactions?.resolveTerminal(input.executionId, attemptId)
      if (handle !== undefined) await this.runtime.cleanup(handle)
      return { cleaned: true }
    })
  }

  async #outcome(
    executionId: string,
    attemptId: string,
    status: RuntimeExecutionStatus,
    interactionId?: string
  ): Promise<WorkflowRuntimeOutcome> {
    await this.#recordTerminalUsage(executionId, attemptId, status)
    if (status.state === 'completed') {
      const key = `executions/${executionId}/attempts/${attemptId}/result.json`
      const artifactId = `art_${executionId.slice(4)}`
      await this.objectStore.put({
        key,
        body: new TextEncoder().encode(JSON.stringify(status.result)),
        contentType: 'application/json',
        metadata: { execution: executionId, attempt: attemptId },
      })
      return { outcome: 'completed', resultReference: artifactId }
    }
    if (status.state === 'failed' || status.state === 'timed_out') {
      return {
        outcome: 'failed',
        failureCode: status.error?.code ?? 'RUNTIME_FAILED',
        retryable: status.error?.retryable ?? false,
      }
    }
    if (status.state === 'cancelled') return { outcome: 'cancelled' }
    if (status.state === 'awaiting_input' && interactionId !== undefined) {
      return { outcome: 'awaiting_input', interactionId }
    }
    return {
      outcome: 'failed',
      failureCode: 'RUNTIME_NONTERMINAL_RESULT',
      retryable: true,
    }
  }

  async #saveHandle(executionId: string, handle: RuntimeExecutionHandle): Promise<void> {
    await this.persistence.transaction(async (transaction) => {
      const id = recordId(executionId)
      const current = await transaction.get(namespaces.handles, id)
      if (current === undefined) {
        await transaction.put({ namespace: namespaces.handles, id, value: json(handle) })
      } else if (JSON.stringify(current.value) !== JSON.stringify(handle)) {
        throw new Error('RUNTIME_HANDLE_CONFLICT')
      }
    })
  }

  async #recordCancellation(input: {
    executionId: string
    attemptId: string
    effectKey: string
    reason: 'user_request' | 'deadline'
  }): Promise<DirectRuntimeCancellationIntent> {
    return this.persistence.transaction(async (transaction) => {
      const id = recordId(input.executionId)
      const current = await transaction.get(namespaces.cancellations, id)
      if (current !== undefined) {
        const intent = current.value as unknown as DirectRuntimeCancellationIntent
        if (
          intent.attemptId !== input.attemptId ||
          intent.effectKey !== input.effectKey ||
          intent.reason !== input.reason
        ) {
          throw new Error('RUNTIME_CANCELLATION_CONFLICT')
        }
        return intent
      }
      const intent: DirectRuntimeCancellationIntent = {
        attemptId: input.attemptId,
        effectKey: input.effectKey,
        reason: input.reason,
        requestedAt: new Date().toISOString(),
      }
      await transaction.put({ namespace: namespaces.cancellations, id, value: json(intent) })
      return intent
    })
  }

  async #cancellation(executionId: string): Promise<DirectRuntimeCancellationIntent | undefined> {
    const record = await this.persistence.transaction(async (transaction) =>
      transaction.get(namespaces.cancellations, recordId(executionId))
    )
    return record?.value as unknown as DirectRuntimeCancellationIntent | undefined
  }

  async #cancelHandle(
    executionId: string,
    handle: RuntimeExecutionHandle,
    intent: DirectRuntimeCancellationIntent
  ): Promise<void> {
    await this.#effect(intent.effectKey, async () => {
      const validate = (value: RuntimeExecutionStatus): RuntimeExecutionStatus => {
        const status = RuntimeExecutionStatusSchema.parse(value)
        if (
          status.handle.handleId !== handle.handleId ||
          status.handle.attemptId !== handle.attemptId ||
          status.handle.startedAt !== handle.startedAt
        )
          throw new Error('RUNTIME_CANCEL_HANDLE_MISMATCH')
        return status
      }
      let status = validate(
        await this.runtime.cancel(handle, {
          idempotencyKey: intent.effectKey,
          requestedAt: intent.requestedAt,
        })
      )
      const terminal = (value: RuntimeExecutionStatus) =>
        ['completed', 'failed', 'cancelled', 'timed_out'].includes(value.state)
      // An idempotent adapter can retain its initial, non-terminal ACK. Read
      // current state on each retry instead of committing that ACK as a stop.
      if (!terminal(status)) status = validate(await this.runtime.reconcile(handle))
      if (!terminal(status)) throw new Error('RUNTIME_CANCEL_UNCONFIRMED')
      await this.#recordTerminalUsage(executionId, handle.attemptId, status)
      return { cancelled: true, reason: intent.reason }
    })
  }

  async #recordTerminalUsage(
    executionId: string,
    attemptId: string,
    statusInput: RuntimeExecutionStatus
  ): Promise<void> {
    const status = RuntimeExecutionStatusSchema.parse(statusInput)
    if (status.terminalUsage === undefined) return
    this.#assertAttempt(status.handle, attemptId)
    const value = json({
      schemaVersion: 1,
      executionId,
      attemptId,
      handle: status.handle,
      state: status.state,
      usage: status.terminalUsage,
    })
    await this.persistence.transaction(async (transaction) => {
      const id = recordId(`${executionId}:${attemptId}`)
      const existing = await transaction.get(namespaces.terminalUsage, id)
      if (existing !== undefined) {
        if (JSON.stringify(existing.value) !== JSON.stringify(value))
          throw new Error('RUNTIME_TERMINAL_USAGE_CONFLICT')
        return
      }
      await transaction.put({ namespace: namespaces.terminalUsage, id, value })
    })
  }

  async #handle(
    executionId: string,
    attemptId: string | undefined,
    required: true
  ): Promise<RuntimeExecutionHandle>
  async #handle(
    executionId: string,
    attemptId: string | undefined,
    required: false
  ): Promise<RuntimeExecutionHandle | undefined>
  async #handle(
    executionId: string,
    attemptId: string | undefined,
    required = true
  ): Promise<RuntimeExecutionHandle | undefined> {
    const handle = await this.persistence.transaction(async (transaction) =>
      transaction.get(namespaces.handles, recordId(executionId))
    )
    if (handle === undefined) {
      if (required) throw new Error('RUNTIME_HANDLE_MISSING')
      return undefined
    }
    const value = handle.value as unknown as RuntimeExecutionHandle
    if (attemptId !== undefined) this.#assertAttempt(value, attemptId)
    return value
  }

  #assertAttempt(handle: RuntimeExecutionHandle, attemptId: string): void {
    if (handle.attemptId !== attemptId) throw new Error('RUNTIME_HANDLE_ATTEMPT_MISMATCH')
  }

  async #effect<Result extends JsonValue>(
    effectKey: string,
    operation: () => Promise<Result>
  ): Promise<Result> {
    const id = recordId(effectKey)
    const replay = await this.persistence.transaction(async (transaction) =>
      transaction.get(namespaces.effects, id)
    )
    if (replay !== undefined) return replay.value as Result
    const result = await operation()
    return this.persistence.transaction(async (transaction) => {
      const concurrent = await transaction.get(namespaces.effects, id)
      if (concurrent !== undefined) return concurrent.value as Result
      await transaction.put({ namespace: namespaces.effects, id, value: result })
      return result
    })
  }
}

function recordId(value: string): string {
  return `r-${createHash('sha256').update(value).digest('hex')}`
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
