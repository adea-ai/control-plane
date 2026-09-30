# Telemetry

`@control-plane/telemetry` is the sole observability boundary for services, workers, and future
runtime operations. Domain packages must not import OpenTelemetry, Sentry, or another vendor SDK.
OpenTelemetry provides portable trace and metric APIs; Sentry is an optional exception diagnostic
sink and never stores authoritative execution state.

## Correlation

Use stable semantic attributes when an identifier is available: `service.name`, `request.id`,
`control.correlation_id`, `workspace.id`, `execution.id`, `execution.attempt.id`, `workflow.id`, and
`runtime.id`. HTTP boundaries accept only valid W3C `traceparent`/`tracestate` headers. Internal
service clients must inject the resulting trace context into the next request or message carrier.

Use `withServiceSpan` for service operations and `withDatabaseSpan` around a complete transaction.
An operation may replace trace, metric, logger, and error-tracker adapters in tests without changing
domain code.

## Safe attributes

Telemetry may contain identifiers, event names, bounded status values, timings, counts, route
templates, and sanitized error classifications. It must not contain credentials, authorization or
cookie headers, prompts, file contents, model inputs, tool inputs, arbitrary request/response bodies,
or full third-party payloads. Known secret fields and `key=value` diagnostics are redacted before a
log, span, or Sentry adapter receives them. Sentry 11 is initialized with explicit `dataCollection` restrictions: user information, cookies, HTTP bodies, generative AI inputs/outputs, database query data, queue data, and GraphQL documents/variables are disabled; identifying request/response headers and query parameters are filtered. The removed `sendDefaultPii` option is not used.

Development uses correlated console span events. Staging and production use the OpenTelemetry API
adapter, which remains a no-op until a deployment registers an SDK/exporter. Tests can inject a
recording adapter and must not require a live telemetry vendor or DSN.
