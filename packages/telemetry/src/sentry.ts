import { redactTelemetryValue } from './redaction.js'
import type { ErrorTracker } from './types.js'

export interface SentryScopePort {
  setContext(name: string, context: Record<string, unknown>): void
}

export interface SentrySdkPort {
  captureException(error: unknown): void
  flush(timeout?: number): Promise<boolean>
  init(options: Record<string, unknown>): void
  withScope(operation: (scope: SentryScopePort) => void): void
}

export interface SentryErrorTrackerOptions {
  readonly dsn?: string
  readonly enabled?: boolean
  readonly environment: string
  readonly release: string
  readonly sdk?: SentrySdkPort
}

const disabledTracker: ErrorTracker = {
  captureException() {},
  async flush() {},
}

const restrictedDataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
    response: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
  },
  httpBodies: [],
  urlQueryParams: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  graphQL: { document: false, variables: false },
}

export async function createSentryErrorTracker(
  options: SentryErrorTrackerOptions
): Promise<ErrorTracker> {
  const enabled = options.enabled ?? Boolean(options.dsn)
  if (!enabled) return disabledTracker

  let sdk: SentrySdkPort
  try {
    sdk = options.sdk ?? ((await import('@sentry/node')) as unknown as SentrySdkPort)
    sdk.init({
      dsn: options.dsn,
      enabled: true,
      environment: options.environment,
      release: options.release,
      dataCollection: restrictedDataCollection,
    })
  } catch {
    return disabledTracker
  }
  return {
    captureException(error, context) {
      sdk.withScope((scope) => {
        const safeContext = redactTelemetryValue(context)
        scope.setContext(
          'control-plane',
          safeContext && typeof safeContext === 'object'
            ? (safeContext as Record<string, unknown>)
            : { value: safeContext }
        )
        sdk.captureException(redactTelemetryValue(error))
      })
    },
    async flush() {
      await sdk.flush(2_000)
    },
  }
}
