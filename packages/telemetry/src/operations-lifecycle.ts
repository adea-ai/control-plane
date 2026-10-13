import { createOperationsMetricEmitter, type OperationsMetricPoint } from './operations.js'
import type { MetricAdapter } from './types.js'

export interface OperationsMeasurementLifecycleOptions {
  readonly adapter: MetricAdapter
  readonly serviceName: string
  /** Explicitly scoped producer; undefined means the substrate is unavailable. */
  readonly measure: () =>
    | readonly OperationsMetricPoint[]
    | undefined
    | Promise<readonly OperationsMetricPoint[] | undefined>
  readonly intervalMs: number
  readonly maxPoints?: number
}

/**
 * Opt-in runtime observations. The producer owns workspace scope and source
 * quality; only its already-filtered points reach the bounded metric emitter.
 * Never forwards reports, identifiers, payloads or producer/exporter errors.
 * One pass at a time, including manual samples, with bounded emission volume.
 */
export class OperationsMeasurementLifecycle {
  readonly #options: OperationsMeasurementLifecycleOptions
  readonly #maxPoints: number
  readonly #emitter: ReturnType<typeof createOperationsMetricEmitter>
  #timer: ReturnType<typeof setInterval> | undefined
  #inFlight: Promise<void> | undefined
  #state: 'idle' | 'running' | 'closed' = 'idle'

  constructor(options: OperationsMeasurementLifecycleOptions) {
    if (
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 1000 ||
      options.intervalMs > 86_400_000
    ) {
      throw new Error('OPERATIONS_MEASUREMENT_INTERVAL_INVALID')
    }
    const maxPoints = options.maxPoints ?? 512
    if (!Number.isSafeInteger(maxPoints) || maxPoints < 1 || maxPoints > 1024) {
      throw new Error('OPERATIONS_MEASUREMENT_POINT_LIMIT_INVALID')
    }
    this.#options = { ...options }
    this.#maxPoints = maxPoints
    this.#emitter = createOperationsMetricEmitter(options.adapter, options.serviceName)
  }

  /** Start only after persistence is ready; the initial pass is non-blocking. */
  start(): void {
    if (this.#state !== 'idle') return
    this.#state = 'running'
    this.#timer = setInterval(() => {
      void this.sample()
    }, this.#options.intervalMs)
    this.#timer.unref()
    void this.sample()
  }

  /** Concurrent callers share the active pass rather than queueing scans. */
  sample(): Promise<void> {
    if (this.#state !== 'running') return Promise.resolve()
    if (this.#inFlight !== undefined) return this.#inFlight
    // Defer the producer until the in-flight fence has been installed.
    const pass = Promise.resolve().then(async () => {
      try {
        const points = await this.#options.measure()
        if (points === undefined) return
        for (const point of points.slice(0, this.#maxPoints)) this.#emitter.record(point)
      } catch {
        // A missing/degraded source or failed exporter cannot change runtime state.
      }
    })
    this.#inFlight = pass
    void pass.then(() => {
      if (this.#inFlight === pass) this.#inFlight = undefined
    })
    return pass
  }

  /** Drain observations before the composition closes its persistence. */
  async close(): Promise<void> {
    this.#state = 'closed'
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    await this.#inFlight
  }
}
