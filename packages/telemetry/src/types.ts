export type TelemetryAttributeValue = boolean | number | string

export interface TelemetryIdentifiers {
  readonly serviceName?: string
  readonly requestId?: string
  readonly correlationId?: string
  readonly workspaceId?: string
  readonly executionId?: string
  readonly attemptId?: string
  readonly workflowId?: string
  readonly runtimeId?: string
  readonly runtimeNodeId?: string
  readonly profileVersion?: string
  readonly skillVersion?: string
  readonly graphVersion?: string
  readonly modelAlias?: string
  readonly toolId?: string
  readonly policyVersion?: string
  readonly sandboxId?: string
  readonly delegationId?: string
}

export interface TraceContext {
  readonly traceparent: string
  readonly tracestate?: string
}

export interface SpanInput {
  readonly name: string
  readonly attributes: Readonly<Record<string, TelemetryAttributeValue>>
  readonly parent?: TraceContext
}

export interface SpanOutcome {
  readonly status: 'error' | 'ok'
  readonly error?: unknown
}

export interface TelemetrySpan {
  readonly context?: TraceContext
  end(outcome: SpanOutcome): void
}

export interface TraceAdapter {
  startSpan(input: SpanInput): TelemetrySpan
}

export interface MetricAdapter {
  add(
    name: string,
    value: number,
    attributes: Readonly<Record<string, TelemetryAttributeValue>>
  ): void
  record(
    name: string,
    value: number,
    attributes: Readonly<Record<string, TelemetryAttributeValue>>
  ): void
  /**
   * One non-additive, signed observation (last-value gauge semantics). The
   * only correct path for measurements that may legitimately be negative —
   * snapshot deltas such as storage shrinkage — which histograms and counters
   * reject or accumulate.
   */
  recordGauge(
    name: string,
    value: number,
    attributes: Readonly<Record<string, TelemetryAttributeValue>>
  ): void
}

export interface TelemetrySamplingInput {
  readonly name: string
  readonly identifiers: TelemetryIdentifiers
}

export interface TelemetrySamplingPolicy {
  shouldSample(input: TelemetrySamplingInput): boolean
}

export interface ErrorTracker {
  captureException(error: unknown, context: unknown): void
  flush?(): Promise<void>
}

export interface StructuredLogEntry {
  readonly level: 'error' | 'info' | 'warn'
  readonly event: string
  readonly metadata?: Readonly<object>
  readonly details?: unknown
}

export interface StructuredLogger {
  write(entry: StructuredLogEntry): void
}
