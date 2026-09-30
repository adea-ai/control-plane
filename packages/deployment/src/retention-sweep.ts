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
  /** Read-only assessments; scheduled passes have no physical-deletion port. */
  readonly assessCommandInbox: (now: Date) => Promise<RetentionAssessmentSummary>
  readonly assessExecutionEvents: (now: Date) => Promise<RetentionAssessmentSummary>
  /** Non-overlapping sweep cadence; a slow pass never overlaps the next one. */
  readonly intervalMs: number
  readonly onError?: (error: unknown) => void
  /** Receives one payload-free pass record per pass. */
  readonly onReport?: (report: RetentionSweepReport) => void
}

/** Counts and reason codes only; never record payloads or identifiers. */
export interface RetentionSweepReport {
  readonly at: string
  readonly assessment: {
    readonly commandInbox: RetentionAssessmentSummary
    readonly executionEvents: RetentionAssessmentSummary
  }
}

const MAXIMUM_INTERVAL_MS = 3_600_000 * 24

/**
 * M11.9 retention worker (#194): completion-scheduled, non-overlapping,
 * read-only assessments. Physical deletion is an operator action and is
 * deliberately absent from this scheduler's ports.
 */
export class RetentionSweep {
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
  async run(): Promise<RetentionSweepReport> {
    const now = new Date()
    const report: RetentionSweepReport = {
      at: now.toISOString(),
      assessment: {
        commandInbox: await this.#assessCommandInbox(now),
        executionEvents: await this.#assessExecutionEvents(now),
      },
    }
    this.#onReport?.(report)
    return report
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
