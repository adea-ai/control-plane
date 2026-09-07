# @control-plane/telemetry

Fail-open observability toolkit: structured logging, secret redaction,
trace-context propagation, deterministic sampling, and pluggable adapters for
OpenTelemetry, Sentry, and LangSmith.

The root export is dependency-free. Provider integrations are optional peer
dependencies exposed as subpath exports, so you only pay for what you import.

## Install

```sh
bun add @adea-ai/telemetry
```

## Usage

```ts
import { createTelemetry, createStructuredLogger, jsonLogger } from '@adea-ai/telemetry'

const telemetry = createTelemetry({ serviceName: 'my-service' })

const span = telemetry.startSpan('service.handleRequest', identifiers)
span.end({ status: 'ok' })

telemetry.log('warn', 'cache.miss', identifiers, { key })
```

### Provider adapters (optional peers)

```ts
// Requires @opentelemetry/api (optional peer):
import {
  createOpenTelemetryMetricAdapter,
  createOpenTelemetryTraceAdapter,
} from '@adea-ai/telemetry/opentelemetry'

// Requires @sentry/node (optional peer; dynamically imported when enabled):
import { createSentryErrorTracker } from '@adea-ai/telemetry/sentry'
```

## What's inside

- **Structured logging** — `createStructuredLogger` / `jsonLogger` emit
  redacted JSON lines to stdout/stderr.
- **Redaction** — `redactTelemetryValue` scrubs sensitive keys, bearer
  tokens, GitHub/AWS/Slack/Stripe/Google credentials, URL credentials, and PEM
  blocks from arbitrary values; `redactDiagnostics` applies substring-based
  key matching with an explicit allowlist for diagnostics payloads.
- **Trace context** — W3C-style `traceparent` extraction/injection for
  cross-service correlation.
- **Sampling** — `createDeterministicSamplingPolicy` for stable,
  hash-based span sampling.
- **Adapters** — OpenTelemetry metrics/traces, Sentry error tracking, and a
  LangSmith trace adapter (port-injected, dependency-free).
- **Catalog** (`@adea-ai/telemetry/catalog`) — the Control Plane's canonical
  execution-trace span names, operational metric names, and diagnostic
  queries.

Observability is deliberately non-authoritative: every adapter call is
fail-open and cannot change execution results.

## License

Apache-2.0
