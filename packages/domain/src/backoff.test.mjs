import { describe, expect, test } from 'bun:test'
import { computeBackoffDelayMs } from './index.ts'

describe('computeBackoffDelayMs (#405 consolidation)', () => {
  // Historical oracle formulas, verbatim from the pre-consolidation call sites.
  const oracleDispatcher = (base, attempts) => Math.min(60_000, base * 2 ** Math.min(attempts, 16))
  const oracleAcp = (timeout, attempt) =>
    Math.min(30_000, Math.max(20, timeout * 2 ** Math.min(attempt, 10)))
  const oracleEmbedded = (retryDelayMs, attempt) =>
    Math.min(retryDelayMs * 2 ** Math.max(0, attempt - 1), 30_000)
  const oracleEvents = (base, attempts) => base * 2 ** attempts

  test('runtime-health-dispatcher parity: min(60s, base·2^min(attempts,16))', () => {
    for (const base of [1_000, 2_500, 7_500]) {
      for (const attempts of [0, 1, 5, 15, 16, 17, 40]) {
        const actual = computeBackoffDelayMs({
          baseDelayMs: base,
          attempt: attempts,
          maxDelayMs: 60_000,
          // dispatcher had no exponent clamp beyond the min(attempts, 16):
          exponentShift: 0,
        })
        expect(actual).toBe(Math.min(60_000, base * 2 ** Math.min(attempts, 16)))
      }
    }
    expect(oracleDispatcher(1_000, 16)).toBe(60_000)
  })

  test('acp-adapter parity: min(30s, max(20, timeout·2^min(attempt,10))) with floor-before-ceiling', () => {
    for (const timeout of [25, 250, 5_000, 30_000]) {
      for (const attempt of [0, 1, 4, 9, 10, 12]) {
        const actual = computeBackoffDelayMs({
          baseDelayMs: timeout,
          attempt,
          minDelayMs: 20,
          maxDelayMs: 30_000,
          maxExponent: 10,
        })
        expect(actual).toBe(oracleAcp(timeout, attempt))
      }
    }
    expect(oracleAcp(250, 0)).toBe(
      computeBackoffDelayMs({ baseDelayMs: 250, attempt: 0, minDelayMs: 20, maxDelayMs: 30_000 })
    )
  })

  test('embedded-runtime parity: min(base·2^max(0,attempt-1), 30s)', () => {
    for (const retryDelayMs of [500, 2_000, 10_000]) {
      for (const attempt of [0, 1, 2, 8, 20]) {
        const actual = computeBackoffDelayMs({
          baseDelayMs: retryDelayMs,
          attempt: attempt - 1,
          maxDelayMs: 30_000,
        })
        expect(actual).toBe(oracleEmbedded(retryDelayMs, attempt))
      }
    }
  })

  test('events parity: uncapped base·2^attempts', () => {
    for (const base of [250, 1_000]) {
      for (const attempts of [0, 1, 3, 10]) {
        const actual = computeBackoffDelayMs({ baseDelayMs: base, attempt: attempts })
        expect(actual).toBe(oracleEvents(base, attempts))
      }
    }
  })

  test('floor applies before ceiling', () => {
    // raw 10 < floor 20 < ceiling 30_000 → 20
    expect(
      computeBackoffDelayMs({ baseDelayMs: 10, attempt: 0, minDelayMs: 20, maxDelayMs: 30_000 })
    ).toBe(20)
  })
})
