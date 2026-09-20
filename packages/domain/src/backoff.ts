/**
 * Shared exponential-backoff computation (M13 #405 consolidation).
 *
 * One formula, parameterized per call site: `baseDelayMs * 2 ** exponent`
 * with the exponent clamped to `[0, attempt - exponentShift]`-shaped bounds
 * and the result clamped to `[minDelayMs, maxDelayMs]` — floor applied
 * before ceiling, matching the historical call-site formulas exactly.
 */

export interface ComputeBackoffDelayMsInput {
  /** Base delay in milliseconds; the pre-exponential delay at attempt 0 (after shift). */
  readonly baseDelayMs: number
  /** Attempt number as the call site counts it (already shifted by the site if needed). */
  readonly attempt: number
  /** Subtracted from `attempt` before clamping, for sites that count from 1. Default 0. */
  readonly exponentShift?: number
  /** Floor applied to the raw delay BEFORE the ceiling (historical `max(...)`). Default 0. */
  readonly minDelayMs?: number
  /** Ceiling applied to the raw delay (historical `Math.min(cap, ...)`). Omit for uncapped. */
  readonly maxDelayMs?: number
  /** Exponent ceiling (historical `2 ** Math.min(attempt, N)`). Omit for uncapped. */
  readonly maxExponent?: number
}

export function computeBackoffDelayMs(input: ComputeBackoffDelayMsInput): number {
  const shift = input.exponentShift ?? 0
  const exponent = Math.min(
    Math.max(0, input.attempt - shift),
    input.maxExponent ?? Number.POSITIVE_INFINITY
  )
  const raw = input.baseDelayMs * 2 ** exponent
  const floored = Math.max(raw, input.minDelayMs ?? 0)
  return input.maxDelayMs === undefined ? floored : Math.min(floored, input.maxDelayMs)
}
