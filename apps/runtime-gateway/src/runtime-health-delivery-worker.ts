export interface RuntimeHealthDeliveryWorkerOptions {
  readonly dispatcher: {
    dispatchBatch(limit: number): Promise<{ delivered: number; failed: number; conflicts: number }>
  }
  readonly intervalMs?: number
  readonly batchSize?: number
  readonly onError?: () => void
}

/** Independent from channel sweeps. Persistent retry deadlines remain owned by the dispatcher. */
export class RuntimeHealthDeliveryWorker {
  readonly #options: RuntimeHealthDeliveryWorkerOptions
  readonly #intervalMs: number
  readonly #batchSize: number
  #started = false
  #timer: ReturnType<typeof setTimeout> | undefined
  #running: Promise<void> | undefined
  #closing: Promise<void> | undefined

  constructor(options: RuntimeHealthDeliveryWorkerOptions) {
    this.#options = options
    this.#intervalMs = options.intervalMs ?? 1_000
    this.#batchSize = options.batchSize ?? 1
    if (
      !Number.isSafeInteger(this.#intervalMs) ||
      this.#intervalMs < 1 ||
      this.#intervalMs > 60_000
    )
      throw new Error('INVALID_HEALTH_DELIVERY_INTERVAL')
    if (!Number.isSafeInteger(this.#batchSize) || this.#batchSize < 1 || this.#batchSize > 128)
      throw new Error('INVALID_HEALTH_DELIVERY_BATCH')
  }

  start(): void {
    if (this.#started || this.#closing)
      throw new Error('HEALTH_DELIVERY_WORKER_ALREADY_STARTED_OR_CLOSED')
    this.#started = true
    this.#schedule()
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing
    this.#started = false
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#closing = Promise.resolve(this.#running)
    return this.#closing
  }

  #schedule(): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#running = Promise.resolve()
        .then(async () => {
          const result = await this.#options.dispatcher.dispatchBatch(this.#batchSize)
          if (result.failed > 0 || result.conflicts > 0)
            throw new Error('HEALTH_DELIVERY_INCOMPLETE')
        })
        .catch(() => {
          try {
            if (this.#options.onError) this.#options.onError()
            else console.error('RUNTIME_HEALTH_DELIVERY_FAILED')
          } catch {
            /* reporting must not stop later passes */
          }
        })
        .finally(() => {
          this.#running = undefined
          if (this.#started) this.#schedule()
        })
    }, this.#intervalMs)
    this.#timer.unref()
  }
}
