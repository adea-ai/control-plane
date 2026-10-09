import { semanticAttributes } from './context.js'
import { redactTelemetryValue, sanitizeAttributes, sanitizeSpanOutcome } from './redaction.js'
import type {
  ErrorTracker,
  MetricAdapter,
  StructuredLogger,
  TelemetryIdentifiers,
  TelemetrySpan,
  TelemetrySamplingPolicy,
  TraceAdapter,
  TraceContext,
} from './types.js'

const noopSpan: TelemetrySpan = { end: () => undefined }
const noopTraceAdapter: TraceAdapter = { startSpan: () => noopSpan }
const noopMetricAdapter: MetricAdapter = {
  add: () => undefined,
  record: () => undefined,
  recordGauge: () => undefined,
}
const noopErrorTracker: ErrorTracker = { captureException: () => undefined }

export interface TelemetryOptions {
  readonly serviceName: string
  readonly logger?: StructuredLogger
  readonly traceAdapter?: TraceAdapter
  readonly metricAdapter?: MetricAdapter
  readonly errorTracker?: ErrorTracker
  readonly samplingPolicy?: TelemetrySamplingPolicy
}

export class Telemetry {
  readonly #serviceName: string
  readonly #logger: StructuredLogger | undefined
  readonly #traceAdapter: TraceAdapter
  readonly #metricAdapter: MetricAdapter
  readonly #errorTracker: ErrorTracker
  readonly #samplingPolicy: TelemetrySamplingPolicy | undefined

  constructor(options: TelemetryOptions) {
    this.#serviceName = options.serviceName
    this.#logger = options.logger
    this.#traceAdapter = options.traceAdapter ?? noopTraceAdapter
    this.#metricAdapter = options.metricAdapter ?? noopMetricAdapter
    this.#errorTracker = options.errorTracker ?? noopErrorTracker
    this.#samplingPolicy = options.samplingPolicy
  }

  startSpan(
    name: string,
    identifiers: TelemetryIdentifiers = {},
    attributes: Readonly<Record<string, unknown>> = {},
    parent?: TraceContext
  ): TelemetrySpan {
    if (this.#samplingPolicy && !safeShouldSample(this.#samplingPolicy, { name, identifiers })) {
      return noopSpan
    }
    try {
      return safeSpan(
        this.#traceAdapter.startSpan({
          name,
          attributes: {
            ...semanticAttributes({ serviceName: this.#serviceName, ...identifiers }),
            ...sanitizeAttributes(attributes),
          },
          ...(parent === undefined ? {} : { parent }),
        })
      )
    } catch {
      return noopSpan
    }
  }

  withServiceSpan<Result>(
    name: string,
    identifiers: TelemetryIdentifiers,
    operation: () => Result | Promise<Result>
  ): Promise<Result> {
    return this.#withSpan(`service.${name}`, identifiers, operation)
  }

  withDatabaseSpan<Result>(
    name: string,
    identifiers: TelemetryIdentifiers,
    operation: () => Result | Promise<Result>
  ): Promise<Result> {
    return this.#withSpan(`database.${name}`, identifiers, operation)
  }

  increment(name: string, value: number, identifiers: TelemetryIdentifiers = {}): void {
    try {
      this.#metricAdapter.add(
        name,
        value,
        semanticAttributes({ serviceName: this.#serviceName, ...identifiers })
      )
    } catch {
      // Observability is deliberately non-authoritative and fail-open.
    }
  }

  record(name: string, value: number, identifiers: TelemetryIdentifiers = {}): void {
    try {
      this.#metricAdapter.record(
        name,
        value,
        semanticAttributes({ serviceName: this.#serviceName, ...identifiers })
      )
    } catch {
      // Observability is deliberately non-authoritative and fail-open.
    }
  }

  log(
    level: 'error' | 'info' | 'warn',
    event: string,
    identifiers: TelemetryIdentifiers,
    details?: unknown
  ): void {
    try {
      this.#logger?.write({
        level,
        event,
        metadata: semanticAttributes({ serviceName: this.#serviceName, ...identifiers }),
        ...(details === undefined ? {} : { details: redactTelemetryValue(details) }),
      })
    } catch {
      // Logging outages cannot change execution results.
    }
  }

  async #withSpan<Result>(
    name: string,
    identifiers: TelemetryIdentifiers,
    operation: () => Result | Promise<Result>
  ): Promise<Result> {
    const span = this.startSpan(name, identifiers)
    try {
      const result = await operation()
      span.end({ status: 'ok' })
      return result
    } catch (error) {
      const safeError = redactTelemetryValue(error)
      span.end({ status: 'error', error: safeError })
      try {
        this.#errorTracker.captureException(
          safeError,
          semanticAttributes({ serviceName: this.#serviceName, ...identifiers })
        )
      } catch {
        // Error reporting must preserve the original domain error.
      }
      throw error
    }
  }
}

function safeSpan(span: TelemetrySpan): TelemetrySpan {
  return {
    ...(span.context === undefined ? {} : { context: span.context }),
    end(outcome) {
      try {
        span.end(sanitizeSpanOutcome(outcome))
      } catch {
        // Span export is not part of the authoritative operation.
      }
    },
  }
}

function safeShouldSample(
  policy: TelemetrySamplingPolicy,
  input: Parameters<TelemetrySamplingPolicy['shouldSample']>[0]
): boolean {
  try {
    return policy.shouldSample(input)
  } catch {
    return false
  }
}

export function createTelemetry(options: TelemetryOptions): Telemetry {
  return new Telemetry(options)
}
