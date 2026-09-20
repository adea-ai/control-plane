import { describe, expect, test } from 'bun:test'
import { withTimeout } from './index.ts'

describe('withTimeout', () => {
  test('resolves the wrapped value when the promise settles in time', async () => {
    expect(await withTimeout(Promise.resolve('ok'), 1_000, () => new Error('late'))).toBe('ok')
  })

  test('rejects with the caller error on timeout and clears the timer', async () => {
    const error = new Error('MODEL_TIMEOUT')
    expect(async () => await withTimeout(new Promise(() => {}), 10, () => error)).toThrow(error)
  })

  test('propagates the wrapped promise rejection instead of the timeout', async () => {
    const failure = new Error('provider failed')
    expect(
      async () => await withTimeout(Promise.reject(failure), 10, () => new Error('late'))
    ).toThrow(failure)
  })
})
