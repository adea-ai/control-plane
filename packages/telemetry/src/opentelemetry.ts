import {
  context as activeContext,
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
  type Counter,
  type Gauge,
  type Histogram,
  type Span,
  type SpanContext,
} from '@opentelemetry/api'
import type {
  MetricAdapter,
  SpanOutcome,
  TelemetrySpan,
  TraceAdapter,
  TraceContext,
} from './types.js'
import { sanitizeSpanOutcome } from './redaction.js'

export function createOpenTelemetryTraceAdapter(serviceName: string): TraceAdapter {
  const tracer = trace.getTracer(serviceName)
  return {
    startSpan(input) {
      const parent = input.parent ? contextFromTraceparent(input.parent) : undefined
      const parentContext = parent
        ? trace.setSpanContext(activeContext.active(), parent)
        : activeContext.active()
      const span = tracer.startSpan(
        input.name,
        { attributes: input.attributes as Attributes },
        parentContext
      )
      const spanContext = span.spanContext()
      const propagatedContext = validSpanContext(spanContext)
        ? traceContextFromSpan(spanContext, input.parent?.tracestate)
        : input.parent
      return {
        ...(propagatedContext === undefined ? {} : { context: propagatedContext }),
        end(outcome) {
          finishSpan(span, outcome)
        },
      } satisfies TelemetrySpan
    },
  }
}

export function createOpenTelemetryMetricAdapter(serviceName: string): MetricAdapter {
  const meter = metrics.getMeter(serviceName)
  const counters = new Map<string, Counter>()
  const histograms = new Map<string, Histogram>()
  const gauges = new Map<string, Gauge>()
  return {
    add(name, value, attributes) {
      let counter = counters.get(name)
      if (!counter) {
        counter = meter.createCounter(name)
        counters.set(name, counter)
      }
      counter.add(value, attributes as Attributes)
    },
    record(name, value, attributes) {
      let histogram = histograms.get(name)
      if (!histogram) {
        histogram = meter.createHistogram(name)
        histograms.set(name, histogram)
      }
      histogram.record(value, attributes as Attributes)
    },
    // Signed observations go through the synchronous Gauge instrument: a
    // non-additive, last-value instrument that accepts negative values. The
    // histogram `record` creates would silently drop them — the OpenTelemetry
    // SDK warns via `diag` and returns without recording — so shrinkage
    // observations must never reach it.
    recordGauge(name, value, attributes) {
      let gauge = gauges.get(name)
      if (!gauge) {
        gauge = meter.createGauge(name)
        gauges.set(name, gauge)
      }
      gauge.record(value, attributes as Attributes)
    },
  }
}

function contextFromTraceparent(context: TraceContext): SpanContext | undefined {
  const match = context.traceparent.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/)
  if (!match?.[1] || !match[2] || !match[3]) return undefined
  return {
    traceId: match[1],
    spanId: match[2],
    traceFlags: Number.parseInt(match[3], 16),
    isRemote: true,
  }
}

function validSpanContext(value: SpanContext): boolean {
  return !/^0+$/.test(value.traceId) && !/^0+$/.test(value.spanId)
}

function traceContextFromSpan(span: SpanContext, tracestate?: string): TraceContext {
  const flags = span.traceFlags.toString(16).padStart(2, '0')
  const traceparent = `00-${span.traceId}-${span.spanId}-${flags}`
  return tracestate === undefined ? { traceparent } : { traceparent, tracestate }
}

function finishSpan(span: Span, outcome: SpanOutcome): void {
  const safeOutcome = sanitizeSpanOutcome(outcome)
  span.setStatus({ code: safeOutcome.status === 'ok' ? SpanStatusCode.OK : SpanStatusCode.ERROR })
  if (safeOutcome.status === 'error') {
    span.recordException(String(safeOutcome.error ?? 'operation failed'))
  }
  span.end()
}
