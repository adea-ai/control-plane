export interface RetentionSweepOptions {
  readonly commandInbox: { readonly deleteExpiredInbox: (now: Date) => Promise<number> }
  readonly executionEvents: {
    readonly deleteExpiredEvents: (now: Date) => Promise<number>
  }
  /** Non-overlapping sweep cadence; a slow pass never overlaps the next one. */
  readonly intervalMs: number
  readonly onError?: (error: unknown) => void
}

const MAXIMUM_INTERVAL_MS = 3_600_000 * 24

/**
 * M11.9 retention worker (#194): completion-scheduled, non-overlapping sweeps
 * that physically delete durable records past their retention deadline.
 * Explicit composition configuration only — constructing the sweep without
 * starting it enables nothing. Storage-neutral: the command-inbox and
 * execution-events deletions are supplied as callables, so both the SQLite
 * and PostgreSQL repositories satisfy the ports.
 */
export class RetentionSweep {
  readonly #commandInbox: RetentionSweepOptions['commandInbox']
  readonly #executionEvents: RetentionSweepOptions['executionEvents']
  readonly #intervalMs: number
  readonly #onError: (error: unknown) => void
  #timer: ReturnType<typeof setInterval> | undefined
  #inFlight: Promise<unknown> | undefined
  #closing = false

  constructor(options: RetentionSweepOptions) {
    this.#commandInbox = options.commandInbox
    this.#executionEvents = options.executionEvents
    this.#intervalMs = positiveInterval(options.intervalMs)
    this.#onError = options.onError ?? (() => {})
  }

  start(): void {
    if (this.#closing) throw new Error('RETENTION_SWEEP_CLOSED')
    if (this.#timer !== undefined) throw new Error('RETENTION_SWEEP_ALREADY_STARTED')
    this.#timer = setInterval(() => {
      this.#inFlight = this.run()
        .catch((error) => this.#onError(error))
        .finally(() => {
          this.#inFlight = undefined
        })
      this.#inFlight.catch(() => undefined)
    }, this.#intervalMs)
    this.#timer.unref?.()
  }

  /** Runs one sweep immediately; also used by the scheduled passes. */
  async run(): Promise<{ inbox: number; events: number }> {
    const now = new Date()
    const inbox = await this.#commandInbox.deleteExpiredInbox(now)
    const events = await this.#executionEvents.deleteExpiredEvents(now)
    return { inbox, events }
  }

  close(): void {
    this.#closing = true
    if (this.#timer !== undefined) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
  }
}

function positiveInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_INTERVAL_MS) {
    throw new Error('RETENTION_SWEEP_INVALID_INTERVAL')
  }
  return value
}
