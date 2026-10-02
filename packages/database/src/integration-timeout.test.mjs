import { expect, test } from 'bun:test'
import { integrationTestTimeout } from './testing.ts'

test('integration runner never reduces an authored test or setup budget', () => {
  const original = process.env.INTEGRATION_TEST_TIMEOUT_MS
  try {
    delete process.env.INTEGRATION_TEST_TIMEOUT_MS
    expect(integrationTestTimeout(90_000)).toBe(90_000)

    process.env.INTEGRATION_TEST_TIMEOUT_MS = '30000'
    expect(integrationTestTimeout(30_000)).toBe(30_000)
    expect(integrationTestTimeout(60_000)).toBe(60_000)
    expect(integrationTestTimeout(90_000)).toBe(90_000)

    process.env.INTEGRATION_TEST_TIMEOUT_MS = '120000'
    expect(integrationTestTimeout(30_000)).toBe(120_000)
    expect(integrationTestTimeout(90_000)).toBe(120_000)
    expect(integrationTestTimeout(180_000)).toBe(180_000)
  } finally {
    if (original === undefined) delete process.env.INTEGRATION_TEST_TIMEOUT_MS
    else process.env.INTEGRATION_TEST_TIMEOUT_MS = original
  }
})

test('invalid runner budgets preserve the authored budget', () => {
  const original = process.env.INTEGRATION_TEST_TIMEOUT_MS
  try {
    for (const value of ['', '0', '-1', 'NaN', 'Infinity', 'invalid']) {
      process.env.INTEGRATION_TEST_TIMEOUT_MS = value
      expect(integrationTestTimeout(60_000)).toBe(60_000)
    }
  } finally {
    if (original === undefined) delete process.env.INTEGRATION_TEST_TIMEOUT_MS
    else process.env.INTEGRATION_TEST_TIMEOUT_MS = original
  }
})
