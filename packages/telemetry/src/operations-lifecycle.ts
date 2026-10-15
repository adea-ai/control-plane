import { createOperationsMetricEmitter, type OperationsMetricPoint } from './operations.js'
import type { MetricAdapter } from './types.js'

/**
 * Handed to every producer pass. The signal aborts when the pass exceeds its
 * deadline or the lifecycle gives up draining at close. A producer should stop
 * issuing work and settle promptly; whatever it returns after abort is discarded.
 */
export interface OperationsMeasurementContext {
  readonly signal: AbortSignal
}

export const DEFAULT_OPERATIONS_MEASUREMENT_PASS_TIMEOUT_MS = 60_000
export const DEFAULT_OPERATIONS_MEASUREMENT_CLOSE_TIMEOUT_MS = 5_000

export interface OperationsMeasurementLifecycleOptions {
  readonly adapter: MetricAdapter
  readonly serviceName: string
  /** Explicitly scoped producer; undefined means the substrate is unavailable. */
  readonly measure: (
    context: OperationsMeasurementContext
  ) =>
    | readonly OperationsMetricPoint[]
    | undefined
    | Promise<readonly OperationsMetricPoint[] | undefined>
  readonly intervalMs: number
  readonly maxPoints?: number
  /**
   * Longest a single pass may run before it is aborted and abandoned (its late
   * result is discarded). Default 60 s; 10 ms to 10 minutes.
   */
  readonly passTimeoutMs?: number
  /**
   * Longest `close()` waits for an active pass to drain before aborting it and
   * returning anyway. Default 5 s; 10 ms to 60 s.
   */
  readonly closeTimeoutMs?: number
}

interface ActivePass {
  readonly controller: AbortController
  /** Resolves once the producer has actually settled, however late. */
  settled: Promise<void>
  /** Resolves when the producer settles or its pass deadline passes. */
  bounded: Promise<void>
  /** Set once the result must be discarded; the signal is aborted with it. */
  abandoned: boolean
  done: boolean
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  code: string
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) throw new Error(code)
  return resolved
}

/**
 * Opt-in runtime observations. The producer owns workspace scope and source
 * quality; only its already-filtered points reach the bounded metric emitter.
 * Never forwards reports, identifiers, payloads or producer/exporter errors.
 * One pass at a time, including manual samples, with bounded emission volume.
 *
 * Passes and shutdown are time-bounded. A pass past `passTimeoutMs` is aborted
 * and abandoned: its late result is never emitted. A stalled producer is not
 * stacked on: no new pass starts until it actually settles, so metrics pause
 * rather than leaking work. `close()` drains an active pass for at most
 * `closeTimeoutMs`, then aborts it and returns; repeated closes share one
 * completion and nothing is emitted after close resolves.
 */
export class OperationsMeasurementLifecycle {
  readonly #options: OperationsMeasurementLifecycleOptions
  readonly #maxPoints: number
  readonly #passTimeoutMs: number
  readonly #closeTimeoutMs: number
  readonly #emitter: ReturnType<typeof createOperationsMetricEmitter>
  #timer: ReturnType<typeof setInterval> | undefined
  #active: ActivePass | undefined
  #closing: Promise<void> | undefined
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
    this.#passTimeoutMs = boundedOption(
      options.passTimeoutMs,
      DEFAULT_OPERATIONS_MEASUREMENT_PASS_TIMEOUT_MS,
      10,
      600_000,
      'OPERATIONS_MEASUREMENT_PASS_TIMEOUT_INVALID'
    )
    this.#closeTimeoutMs = boundedOption(
      options.closeTimeoutMs,
      DEFAULT_OPERATIONS_MEASUREMENT_CLOSE_TIMEOUT_MS,
      10,
      60_000,
      'OPERATIONS_MEASUREMENT_CLOSE_TIMEOUT_INVALID'
    )
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

  /**
   * Concurrent callers share the active pass rather than queueing scans. The
   * returned promise settles when the pass does or its deadline passes,
   * whichever is first; it never rejects.
   */
  sample(): Promise<void> {
    if (this.#state !== 'running') return Promise.resolve()
    const existing = this.#active
    if (existing !== undefined) return existing.bounded
    const controller = new AbortController()
    const active: ActivePass = {
      controller,
      settled: Promise.resolve(),
      bounded: Promise.resolve(),
      abandoned: false,
      done: false,
    }
    // Defer the producer until the in-flight fence has been installed.
    const settled = Promise.resolve().then(async () => {
      try {
        const points = await this.#options.measure({ signal: controller.signal })
        // A late result after the deadline or close is discarded, never emitted.
        if (points === undefined || active.abandoned) return
        for (const point of points.slice(0, this.#maxPoints)) this.#emitter.record(point)
      } catch {
        // A missing/degraded source or failed exporter cannot change runtime state.
      }
    })
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      deadlineTimer = setTimeout(() => {
        this.#abandon(active)
        resolve()
      }, this.#passTimeoutMs)
      deadlineTimer.unref()
    })
    active.settled = settled
    active.bounded = Promise.race([settled, deadline])
    this.#active = active
    void settled.then(() => {
      active.done = true
      clearTimeout(deadlineTimer)
      if (this.#active === active) this.#active = undefined
    })
    return active.bounded
  }

  /**
   * Drain an active pass for at most `closeTimeoutMs`, then abort it and
   * return. Idempotent: repeated calls share one completion. After it resolves
   * no further observation is emitted, even if the producer settles late.
   */
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing
    this.#state = 'closed'
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    const active = this.#active
    this.#closing = (async () => {
      if (active === undefined) return
      let closeTimer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<void>((resolve) => {
        closeTimer = setTimeout(resolve, this.#closeTimeoutMs)
      })
      try {
        await Promise.race([active.settled, deadline])
      } finally {
        clearTimeout(closeTimer)
        this.#abandon(active)
      }
    })()
    return this.#closing
  }

  #abandon(active: ActivePass): void {
    if (active.done || active.abandoned) return
    active.abandoned = true
    active.controller.abort()
  }
}
