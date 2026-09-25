/**
 * Structural view of one class assessment (the authoritative definition lives
 * with the eligibility predicate in @control-plane/domain, which this package
 * must not depend on). Counts only — never record payloads or identifiers.
 */
export interface RetentionAssessmentSummary {
  readonly classId: string
  readonly assessedAt: string
  readonly scanned: number
  readonly truncated: boolean
  readonly eligible: number
  readonly retainedByReason: Readonly<Record<string, number | undefined>>
}

export interface RetentionSweepOptions {
  readonly commandInbox: { readonly deleteExpiredInbox: (now: Date) => Promise<number> }
  readonly executionEvents: {
    readonly deleteExpiredEvents: (now: Date) => Promise<number>
  }
  /**
   * Optional read-only eligibility assessment (#194). Deletion stays
   * fail-closed until the claim path exists, so a pass reports how many
   * expired candidates exist, how many are eligible, and why the rest are
   * retained instead of only failing.
   */
  readonly assessCommandInbox?: (now: Date) => Promise<RetentionAssessmentSummary>
  readonly assessExecutionEvents?: (now: Date) => Promise<RetentionAssessmentSummary>
  /** Non-overlapping sweep cadence; a slow pass never overlaps the next one. */
  readonly intervalMs: number
  readonly onError?: (error: unknown) => void
  /** Receives one payload-free pass record per pass. */
  readonly onReport?: (report: RetentionSweepReport) => void
}

/** Counts and reason codes only; never record payloads or identifiers. */
export interface RetentionSweepReport {
  readonly at: string
  readonly inbox: number
  readonly events: number
  /** Class guards that refused deletion this pass, by error code. */
  readonly blocked: readonly string[]
  readonly assessment: {
    readonly commandInbox?: RetentionAssessmentSummary
    readonly executionEvents?: RetentionAssessmentSummary
  }
}

const ELIGIBILITY_REQUIRED = new Set([
  'COMMAND_RETENTION_ELIGIBILITY_REQUIRED',
  'EVENT_RETENTION_ELIGIBILITY_REQUIRED',
])

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
  readonly #assessCommandInbox: RetentionSweepOptions['assessCommandInbox']
  readonly #assessExecutionEvents: RetentionSweepOptions['assessExecutionEvents']
  readonly #intervalMs: number
  readonly #onError: (error: unknown) => void
  readonly #onReport: ((report: RetentionSweepReport) => void) | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #inFlight: Promise<unknown> | undefined
  #closing: Promise<void> | undefined
  #started = false

  constructor(options: RetentionSweepOptions) {
    this.#commandInbox = options.commandInbox
    this.#executionEvents = options.executionEvents
    this.#assessCommandInbox = options.assessCommandInbox
    this.#assessExecutionEvents = options.assessExecutionEvents
    this.#intervalMs = positiveInterval(options.intervalMs)
    this.#onError = options.onError ?? (() => console.error('RETENTION_SWEEP_FAILED'))
    this.#onReport = options.onReport
  }

  start(): void {
    if (this.#closing !== undefined) throw new Error('RETENTION_SWEEP_CLOSED')
    if (this.#started) throw new Error('RETENTION_SWEEP_ALREADY_STARTED')
    this.#started = true
    this.#schedule()
  }

  #schedule(): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#inFlight = Promise.resolve()
        .then(() => this.run())
        .catch((error) => {
          try {
            this.#onError(error)
          } catch {
            // Reporting failures must not stop later passes or prevent draining.
          }
        })
        .finally(() => {
          this.#inFlight = undefined
          if (this.#closing === undefined) this.#schedule()
        })
    }, this.#intervalMs)
    this.#timer.unref?.()
  }

  /** Runs one sweep immediately; also used by the scheduled passes. */
  async run(): Promise<{ inbox: number; events: number }> {
    const now = new Date()
    const commandInboxAssessment =
      this.#assessCommandInbox === undefined ? undefined : await this.#assessCommandInbox(now)
    const executionEventsAssessment =
      this.#assessExecutionEvents === undefined ? undefined : await this.#assessExecutionEvents(now)
    const assessment: RetentionSweepReport['assessment'] = {
      ...(commandInboxAssessment === undefined ? {} : { commandInbox: commandInboxAssessment }),
      ...(executionEventsAssessment === undefined
        ? {}
        : { executionEvents: executionEventsAssessment }),
    }
    const blocked: string[] = []
    const inbox = await this.#sweep(() => this.#commandInbox.deleteExpiredInbox(now), blocked)
    const events = await this.#sweep(() => this.#executionEvents.deleteExpiredEvents(now), blocked)
    this.#onReport?.({ at: now.toISOString(), inbox, events, blocked, assessment })
    return { inbox, events }
  }

  /**
   * One class per call: a fail-closed eligibility refusal is expected while
   * deletion is disabled and must not stop the other class or the schedule.
   * Any other storage error still propagates to `onError`.
   */
  async #sweep(operation: () => Promise<number>, blocked: string[]): Promise<number> {
    try {
      return await operation()
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      if (!ELIGIBILITY_REQUIRED.has(code)) throw error
      blocked.push(code)
      return 0
    }
  }

  /** Cancels future passes and drains the scheduled pass before storage closes. */
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    this.#closing = (async () => {
      await this.#inFlight
    })()
    return this.#closing
  }
}

function positiveInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_INTERVAL_MS) {
    throw new Error('RETENTION_SWEEP_INVALID_INTERVAL')
  }
  return value
}
