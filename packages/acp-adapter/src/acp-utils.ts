import { RuntimeAdapterError } from '@control-plane/runtime-sdk'

export function fail(
  code: string,
  classification: ConstructorParameters<typeof RuntimeAdapterError>[0]['classification'],
  retryable: boolean
): never {
  throw new RuntimeAdapterError({ code, classification, message: code, retryable })
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) fail('ACP_REQUEST_TIMEOUT', 'timeout', true)
}

export function withAbortSignal<Value>(
  signal: AbortSignal,
  operation: () => Promise<Value>
): Promise<Value> {
  if (signal.aborted) {
    return Promise.reject(
      new RuntimeAdapterError({
        code: 'ACP_REQUEST_TIMEOUT',
        classification: 'timeout',
        message: 'ACP_REQUEST_TIMEOUT',
        retryable: true,
      })
    )
  }
  return new Promise<Value>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      complete()
    }
    const abort = () =>
      finish(() =>
        reject(
          new RuntimeAdapterError({
            code: 'ACP_REQUEST_TIMEOUT',
            classification: 'timeout',
            message: 'ACP_REQUEST_TIMEOUT',
            retryable: true,
          })
        )
      )
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error))
      )
  })
}

export function withTimeout<Value>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<Value>,
  timeoutError: () => Error
): Promise<Value> {
  const controller = new AbortController()
  return new Promise<Value>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      complete()
    }
    const timer = setTimeout(() => {
      finish(() => reject(timeoutError()))
      controller.abort()
    }, timeoutMs)
    timer.unref?.()
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error))
      )
  })
}

export function stable(value: unknown): string {
  return JSON.stringify(value)
}

export * from './gateway.js'
export * from './stdio-client.js'
export * from './process-transport.js'
export * from './pinned-codex-build.js'
export * from './native-installation.js'
