import { describe, expect, test } from 'bun:test'
import { PinnedModelPrice } from './model-price.ts'

const digest = `sha256:${'a'.repeat(64)}`
const snapshot = (overrides = {}) => ({
  schemaVersion: 1,
  deploymentId: 'approved.reasoning.us',
  provider: 'fixture-provider',
  model: 'fixture-model',
  version: 'operator-price-v1',
  currency: 'USD',
  fundingSource: 'hq_managed',
  validFrom: '2026-10-07T00:00:00.000Z',
  validUntil: '2026-10-08T00:00:00.000Z',
  maximumInputTokens: 32_000,
  maximumOutputTokens: 4_000,
  ratesMicrounitsPerMillionTokens: {
    input: 2_000_000,
    cachedInput: 500_000,
    output: 8_000_000,
  },
  ...overrides,
})
const pin = (input, at = '2026-10-07T12:00:00.000Z') =>
  new PinnedModelPrice(input, { now: () => at })
const quote = (price, overrides = {}) =>
  price.quote({
    requestDigest: digest,
    maximumOutputTokens: 1_000,
    ...overrides,
  })

describe('pinned server model pricing', () => {
  test('reserves the full approved input ceiling rather than a caller token estimate', () => {
    const price = pin(snapshot())
    const reservation = quote(price)
    expect(reservation).toMatchObject({
      requestDigest: digest,
      fundingSource: 'hq_managed',
      currency: 'USD',
      maximumInputTokens: 32_000,
      maximumOutputTokens: 1_000,
      maximumTokens: 33_000,
      maximumMicrounits: 72_000,
    })
    expect(reservation.priceSnapshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(Object.isFrozen(reservation)).toBe(true)
    expect(() => quote(price, { estimatedInputTokens: 1 })).toThrow('MODEL_PRICE_INVALID_REQUEST')
  })

  test('prices authoritative cached input as a subset and never counts reasoning twice', () => {
    const reservation = quote(pin(snapshot()))
    expect(
      reservation.priceUsage({
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 25,
        reasoningTokens: 20,
      })
    ).toEqual({ costMicrounits: 340, tokens: 125, costExact: true })
    expect(reservation.priceUsage({ inputTokens: 100, outputTokens: 25 })).toEqual({
      costMicrounits: 400,
      tokens: 125,
      costExact: true,
    })
  })

  test('rounds the exact aggregate up without intermediate floating point or per-category rounding', () => {
    const price = pin(
      snapshot({
        maximumInputTokens: 3,
        maximumOutputTokens: 3,
        ratesMicrounitsPerMillionTokens: { input: 300_001, cachedInput: 100_001, output: 300_001 },
      })
    )
    const reservation = quote(price, { maximumOutputTokens: 1 })
    expect(reservation.maximumMicrounits).toBe(2)
    expect(reservation.priceUsage({ inputTokens: 1, outputTokens: 1 })).toEqual({
      costMicrounits: 1,
      tokens: 2,
      costExact: true,
    })
    const large = quote(
      pin(
        snapshot({
          maximumInputTokens: 3_000_001,
          maximumOutputTokens: 1,
          ratesMicrounitsPerMillionTokens: {
            input: 3_000_000_001,
            cachedInput: 3_000_000_001,
            output: 1,
          },
        })
      ),
      { maximumOutputTokens: 1 }
    )
    expect(large.maximumMicrounits).toBe(9_000_003_004)
  })

  test('rejects missing, impossible, overflowing and above-hold usage rather than producing zero cost', () => {
    const reservation = quote(pin(snapshot()))
    for (const usage of [
      undefined,
      {},
      { inputTokens: -1, outputTokens: 1 },
      { inputTokens: 1.5, outputTokens: 1 },
      { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 1 },
      { inputTokens: 32_001, outputTokens: 0 },
      { inputTokens: 1, outputTokens: 1_001 },
      { inputTokens: 1, cachedInputTokens: 2, outputTokens: 0 },
      { inputTokens: 1, outputTokens: 1, reasoningTokens: 2 },
      { inputTokens: 1, outputTokens: 1, fundingSource: 'external_subscription' },
      { inputTokens: 1, outputTokens: 1, costMicrounits: 0 },
    ])
      expect(() => reservation.priceUsage(usage)).toThrow('MODEL_PRICE_INVALID_USAGE')
  })

  test('pins private price state and differentiates changed price versions and routes', () => {
    const input = snapshot()
    const price = pin(input)
    input.ratesMicrounitsPerMillionTokens.input = 0
    input.fundingSource = 'external_subscription'
    const reservation = quote(price)
    expect(reservation.maximumMicrounits).toBe(72_000)
    expect(reservation.fundingSource).toBe('hq_managed')
    expect(quote(pin(snapshot())).priceSnapshotDigest).toBe(reservation.priceSnapshotDigest)
    expect(quote(pin(snapshot({ version: 'operator-price-v2' }))).priceSnapshotDigest).not.toBe(
      reservation.priceSnapshotDigest
    )
    expect(quote(pin(snapshot({ deploymentId: 'other.route' }))).priceSnapshotDigest).not.toBe(
      reservation.priceSnapshotDigest
    )
  })

  test('uses the server clock and rejects backdated or future caller timestamps', () => {
    for (const at of ['2026-10-06T23:59:59.999Z', '2026-10-08T00:00:00.000Z', 'invalid']) {
      const price = pin(snapshot(), at)
      expect(() => quote(price)).toThrow('MODEL_PRICE_INVALID_REQUEST')
      expect(() => quote(price, { requestedAt: '2026-10-07T12:00:00.000Z' })).toThrow(
        'MODEL_PRICE_INVALID_REQUEST'
      )
    }
    const atExpiry = pin(snapshot(), '2026-10-07T23:59:59.999Z')
    expect(quote(atExpiry).maximumMicrounits).toBe(72_000)
  })

  test('bounds quote validity, output caps, rates and arithmetic', () => {
    const price = pin(snapshot())
    for (const changes of [
      { requestedAt: '2026-10-06T23:59:59.999Z' },
      { requestedAt: '2026-10-08T00:00:00.000Z' },
      { requestedAt: 'invalid' },
      { maximumOutputTokens: 0 },
      { maximumOutputTokens: 4_001 },
      { requestDigest: 'arbitrary' },
    ])
      expect(() => quote(price, changes)).toThrow('MODEL_PRICE_INVALID_REQUEST')
    for (const changes of [
      { validUntil: '2026-10-07T00:00:00.000Z' },
      { maximumInputTokens: Number.MAX_SAFE_INTEGER },
      { ratesMicrounitsPerMillionTokens: { input: 1, cachedInput: 2, output: 1 } },
      { ratesMicrounitsPerMillionTokens: { input: -1, cachedInput: 0, output: 1 } },
      { fundingSource: 'external_subscription' },
    ])
      expect(() => pin(snapshot(changes))).toThrow('MODEL_PRICE_INVALID_SNAPSHOT')
    const huge = pin(
      snapshot({
        maximumInputTokens: 2_000_000,
        maximumOutputTokens: 1,
        ratesMicrounitsPerMillionTokens: {
          input: Number.MAX_SAFE_INTEGER,
          cachedInput: 0,
          output: Number.MAX_SAFE_INTEGER,
        },
      })
    )
    expect(() => quote(huge, { maximumOutputTokens: 1 })).toThrow('MODEL_PRICE_OVERFLOW')
  })

  test('external subscription accounting has zero HQ cost, non-exact classification and enforced token limits', () => {
    const reservation = quote(
      pin(
        snapshot({
          fundingSource: 'external_subscription',
          ratesMicrounitsPerMillionTokens: { input: 0, cachedInput: 0, output: 0 },
        })
      )
    )
    expect(reservation.maximumMicrounits).toBe(0)
    expect(reservation.priceUsage({ inputTokens: 10, outputTokens: 2 })).toEqual({
      costMicrounits: 0,
      tokens: 12,
      costExact: false,
    })
    expect(() => reservation.priceUsage({ inputTokens: 32_001, outputTokens: 0 })).toThrow(
      'MODEL_PRICE_INVALID_USAGE'
    )
  })
})

test('paid BYO API quote retains nonzero exact price provenance', () => {
  const price = new PinnedModelPrice(snapshot({ fundingSource: 'byo_api' }), {
    now: () => '2026-10-07T12:00:00.000Z',
  })
  const byoQuote = price.quote({
    requestDigest: `sha256:${'d'.repeat(64)}`,
    maximumOutputTokens: 10,
  })
  expect(byoQuote.fundingSource).toBe('byo_api')
  expect(byoQuote.priceUsage({ inputTokens: 10, outputTokens: 2 })).toMatchObject({
    costExact: true,
  })
  expect(byoQuote.maximumMicrounits).toBeGreaterThan(0)
})
