import {
  ExecutionLifecycleError,
  ExecutionLifecycleService,
  type Execution,
  type ExecutionAttempt,
} from '@control-plane/domain'
import type { ExecutionEvent, ExecutionEventDraft, ExecutionEventRepository } from './index.js'
import { ExecutionEventError, ExecutionEventService } from './index.js'

export type RuntimeEventEffectOutcome =
  | 'applied'
  | 'duplicate'
  | 'conflict'
  | 'out_of_order'
  | 'terminal_conflict'

export interface RuntimeProgressEffect {
  readonly commandId: string
  readonly eventSequence: number
  readonly frameHash: string
  readonly draft: ExecutionEventDraft
}

export interface RuntimeTerminalEffect {
  readonly commandId: string
  readonly messageSequence: number
  readonly frameHash: string
  readonly execution: Execution
  readonly attempt: ExecutionAttempt
  readonly state: 'completed' | 'failed' | 'cancelled'
  readonly resultReference?: string
  readonly failure?: {
    readonly classification: 'runtime_error' | 'cancelled'
    readonly code: string
  }
  readonly draft: ExecutionEventDraft
}

export interface RuntimeEventEffectResult {
  readonly outcome: RuntimeEventEffectOutcome
  readonly event?: ExecutionEvent
}

export interface RuntimeEventEffectSink {
  applyProgress(effect: RuntimeProgressEffect): Promise<RuntimeEventEffectResult>
  applyTerminal(effect: RuntimeTerminalEffect): Promise<RuntimeEventEffectResult>
}

interface Receipt {
  readonly frameHash: string
  readonly result: RuntimeEventEffectResult
}

export class InMemoryRuntimeEventEffectSink implements RuntimeEventEffectSink {
  readonly #events: ExecutionEventRepository
  readonly #eventService: ExecutionEventService
  readonly #lastProgress = new Map<string, number>()
  readonly #lifecycle: ExecutionLifecycleService
  readonly #locks = new Map<string, Promise<void>>()
  readonly #receipts = new Map<string, Receipt>()

  constructor(options: {
    readonly lifecycle: ExecutionLifecycleService
    readonly events: ExecutionEventRepository
  }) {
    this.#lifecycle = options.lifecycle
    this.#events = options.events
    this.#eventService = new ExecutionEventService(options.events)
  }

  applyProgress(effect: RuntimeProgressEffect): Promise<RuntimeEventEffectResult> {
    return this.#withLock(effect.commandId, async () => {
      const key = `${effect.commandId}:progress:${effect.eventSequence}`
      const replay = this.#replay(key, effect.frameHash)
      if (replay) return replay
      if (effect.eventSequence <= (this.#lastProgress.get(effect.commandId) ?? 0)) {
        const result = { outcome: 'out_of_order' } as const
        this.#receipts.set(key, { frameHash: effect.frameHash, result })
        return result
      }
      const event = await this.#appendOrGet(effect.draft)
      const result = { outcome: 'applied', event } as const
      this.#lastProgress.set(effect.commandId, effect.eventSequence)
      this.#receipts.set(key, { frameHash: effect.frameHash, result })
      return result
    })
  }

  applyTerminal(effect: RuntimeTerminalEffect): Promise<RuntimeEventEffectResult> {
    return this.#withLock(effect.execution.executionId, async () => {
      const key = `${effect.commandId}:terminal:${effect.messageSequence}`
      const replay = this.#replay(key, effect.frameHash)
      if (replay) return replay

      const currentExecution = await this.#lifecycle.getExecution(effect.execution.executionId)
      const currentAttempt = await this.#lifecycle.repository.getAttempt(effect.attempt.attemptId)
      if (!currentAttempt) throw new ExecutionLifecycleError('ATTEMPT_MISSING')
      const terminalStates = ['completed', 'failed', 'cancelled', 'timed_out']
      if (
        terminalStates.includes(currentExecution.state) ||
        terminalStates.includes(currentAttempt.state)
      ) {
        const event = await this.#events.get(effect.draft.eventId)
        const duplicate =
          currentExecution.state === effect.state &&
          currentAttempt.state === effect.state &&
          event !== undefined
        const result = duplicate
          ? ({ outcome: 'duplicate', event } as const)
          : ({ outcome: 'terminal_conflict' } as const)
        this.#receipts.set(key, { frameHash: effect.frameHash, result })
        return result
      }

      await this.#lifecycle.transitionAttempt({
        attemptId: currentAttempt.attemptId,
        expectedVersion: currentAttempt.version,
        to: effect.state,
        transitionedAt: effect.draft.occurredAt,
        ...(effect.failure ? { failure: effect.failure } : {}),
        ...(effect.resultReference ? { terminalResultRef: effect.resultReference } : {}),
      })
      await this.#lifecycle.transitionExecution({
        executionId: currentExecution.executionId,
        expectedVersion: currentExecution.version,
        to: effect.state,
        transitionedAt: effect.draft.occurredAt,
        ...(effect.failure ? { failure: effect.failure } : {}),
        ...(effect.resultReference ? { terminalResultRef: effect.resultReference } : {}),
      })
      const event = await this.#appendOrGet(effect.draft)
      const result = { outcome: 'applied', event } as const
      this.#receipts.set(key, { frameHash: effect.frameHash, result })
      return result
    })
  }

  #replay(key: string, frameHash: string): RuntimeEventEffectResult | undefined {
    const receipt = this.#receipts.get(key)
    if (!receipt) return undefined
    return receipt.frameHash === frameHash
      ? { ...receipt.result, outcome: 'duplicate' }
      : { outcome: 'conflict' }
  }

  async #appendOrGet(draft: ExecutionEventDraft): Promise<ExecutionEvent> {
    try {
      return await this.#eventService.append(draft)
    } catch (error) {
      if (!(error instanceof ExecutionEventError) || error.code !== 'EVENT_EXISTS') throw error
      const event = await this.#events.get(draft.eventId)
      if (!event) throw error
      return event
    }
  }

  async #withLock<Result>(commandId: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.#locks.get(commandId) ?? Promise.resolve()
    let release = () => {}
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.then(() => current)
    this.#locks.set(commandId, queued)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.#locks.get(commandId) === queued) this.#locks.delete(commandId)
    }
  }
}
