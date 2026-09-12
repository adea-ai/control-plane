import type { ExecutionReconciliationService } from '@control-plane/domain'

export interface ReconciliationSchedulerOptions {
  /** The composed reconciliation service; only the scheduled batch entry point is required. */
  readonly service: Pick<ExecutionReconciliationService, 'runBatch'>
  /**
   * Completion-scheduled interval in milliseconds: no pass is scheduled until the
   * previous pass settles, so a slow pass never overlaps the next one.
   * Positive integer, 1..3_600_000. Invalid bounds fail closed.
   */
  readonly intervalMs: number
  /** Candidate limit handed to each batch pass. Positive integer, 1..1_000. */
  readonly batchLimit: number
  /** Invoked with a fixed diagnostic when a pass fails; failures never stop later passes. */
  readonly onBatchError?: () => void
}

const MAXIMUM_INTERVAL_MS = 3_600_000
const MAXIMUM_BATCH_LIMIT = 1_000

/**
 * Completion-scheduled, non-overlapping reconciliation driver. Explicit composition
 * configuration only: constructing the scheduler without starting it enables nothing.
 */
export class ReconciliationScheduler {
  readonly #service: ReconciliationSchedulerOptions['service']
  readonly #intervalMs: number
  readonly #batchLimit: number
  readonly #onBatchError: () => void
  #timer: ReturnType<typeof setTimeout> | undefined
  #batchTask: Promise<unknown> | undefined
  #closing: Promise<void> | undefined

  constructor(options: ReconciliationSchedulerOptions) {
    this.#service = options.service
    this.#intervalMs = positiveInteger(options.intervalMs, 'intervalMs', MAXIMUM_INTERVAL_MS)
    this.#batchLimit = positiveInteger(options.batchLimit, 'batchLimit', MAXIMUM_BATCH_LIMIT)
    this.#onBatchError =
      options.onBatchError ?? (() => console.error('RECONCILIATION_BATCH_FAILED'))
  }

  start(): void {
    if (this.#closing !== undefined) throw new Error('RECONCILIATION_SCHEDULER_CLOSED')
    if (this.#timer !== undefined) throw new Error('RECONCILIATION_SCHEDULER_ALREADY_STARTED')
    this.#schedule()
  }

  /** Cancels future passes and waits for the in-flight pass. Repeated calls share one drain. */
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    this.#closing = (async () => {
      await this.#batchTask
    })()
    return this.#closing
  }

  #schedule(): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#batchTask = Promise.resolve()
        .then(() => this.#service.runBatch({ limit: this.#batchLimit }))
        .catch(() => {
          // Never forward raw source/effect errors or let a failed pass stop later passes.
          try {
            this.#onBatchError()
          } catch {
            /* callback failure is isolated */
          }
        })
        .finally(() => {
          this.#batchTask = undefined
          if (this.#closing === undefined && this.#timer === undefined) this.#schedule()
        })
    }, this.#intervalMs)
    this.#timer.unref()
  }
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid reconciliation scheduler ${name}`)
  }
  return value
}
