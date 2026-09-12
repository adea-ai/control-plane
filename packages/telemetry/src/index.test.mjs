import { describe, expect, test } from 'bun:test'
import {
  consistencyMetricNames,
  createConsistencyMetricEmitter,
  createStructuredLogger,
  createDeterministicSamplingPolicy,
  createLangSmithTraceAdapter,
  createTelemetry,
  extractTraceContext,
  injectTraceContext,
  redactTelemetryValue,
  sanitizeAttributes,
  semanticAttributes,
} from './index.ts'
import { createSentryErrorTracker } from './sentry.ts'
import { diagnosticQueries, executionTraceSpans, operationalMetrics } from './catalog.ts'

const identifiers = {
  serviceName: 'control-api',
  requestId: 'request-1',
  correlationId: 'correlation-1',
  workspaceId: 'workspace-1',
  executionId: 'execution-1',
  attemptId: 'attempt-1',
  workflowId: 'workflow-1',
  runtimeId: 'runtime-1',
  runtimeNodeId: 'runtime-node-1',
  profileVersion: 'profile:v4',
  skillVersion: 'skill:v7',
  graphVersion: 'graph:v3',
  modelAlias: 'reasoning-standard',
  toolId: 'tool.search/v2',
  policyVersion: 'policy:v5',
  sandboxId: 'sandbox-1',
  delegationId: 'delegation-1',
}

describe('telemetry safety and correlation', () => {
  test('redacts secret and prohibited payload fields without mutating input', () => {
    const bearer = ['Bearer', 'private-bearer-value'].join(' ')
    const githubToken = ['ghp', '_', 'A'.repeat(36)].join('')
    const databaseUrl = ['postgresql://control:', 'private-database-value', '@db.invalid/app'].join(
      ''
    )
    const input = {
      authorization: 'Bearer private',
      nested: {
        apiKey: 'api-key',
        accessToken: 'private-access-token',
        aws_secret_access_key: 'private-aws-secret',
        clientSecret: 'private-client-secret',
        outputTokens: 2,
        prompt: 'private prompt',
        safe: 'visible',
      },
      error: new Error(
        `failed with token=private-token, ${bearer}, ${githubToken}, ${databaseUrl}`
      ),
    }

    const redacted = redactTelemetryValue(input)

    expect(JSON.stringify(redacted)).not.toContain('private')
    expect(redacted).toEqual({
      authorization: '[REDACTED]',
      nested: {
        apiKey: '[REDACTED]',
        accessToken: '[REDACTED]',
        aws_secret_access_key: '[REDACTED]',
        clientSecret: '[REDACTED]',
        outputTokens: 2,
        prompt: '[REDACTED]',
        safe: 'visible',
      },
      error: {
        name: 'Error',
        message:
          'failed with token=[REDACTED], Bearer [REDACTED], [REDACTED], postgresql://[REDACTED]@db.invalid/app',
      },
    })
    expect(input.nested.safe).toBe('visible')
  })

  test('redacts compound secret keys without over-redacting unrelated names', () => {
    const secretCanary = 'compound-secret-canary-9f4a'

    expect(
      redactTelemetryValue({
        privateKey: secretCanary,
        signing_key: secretCanary,
        'encryption-key': secretCanary,
        SecretValue: secretCanary,
        secretKey: secretCanary,
        credentialRef: secretCanary,
        publicKey: 'visible-public-key',
        keyId: 'visible-key-id',
        credentialId: 'visible-credential-id',
        monkey: 'visible-monkey',
        secretary: 'visible-secretary',
        tokenizer: 'visible-tokenizer',
      })
    ).toEqual({
      privateKey: '[REDACTED]',
      signing_key: '[REDACTED]',
      'encryption-key': '[REDACTED]',
      SecretValue: '[REDACTED]',
      secretKey: '[REDACTED]',
      credentialRef: '[REDACTED]',
      publicKey: 'visible-public-key',
      keyId: 'visible-key-id',
      credentialId: 'visible-credential-id',
      monkey: 'visible-monkey',
      secretary: 'visible-secretary',
      tokenizer: 'visible-tokenizer',
    })
  })

  test('redacts compound secret assignments embedded in diagnostic text', () => {
    const secretCanary = 'compound-text-secret-canary-9f4a'
    const diagnostic = [
      `privateKey=${secretCanary}`,
      `signingKey: ${secretCanary}`,
      `encryption_key=${secretCanary}`,
      `secretKey=${secretCanary}`,
      `secret-value: ${secretCanary}`,
      `credentialRef=${secretCanary}`,
    ].join(', ')

    expect(redactTelemetryValue(diagnostic)).toBe(
      'privateKey=[REDACTED], signingKey=[REDACTED], encryption_key=[REDACTED], secretKey=[REDACTED], secret-value=[REDACTED], credentialRef=[REDACTED]'
    )
  })

  test('keeps a secret canary out of structured logs', () => {
    const secretCanary = 'secret-canary-log-9f4a'
    const lines = []
    const logger = createStructuredLogger({
      now: () => new Date('2026-08-23T12:00:00.000Z'),
      writeLine: (line) => lines.push(line),
    })

    logger.write({
      level: 'info',
      event: 'service.operation',
      metadata: { serviceName: 'control-api' },
      details: { correlationId: 'correlation-1', password: secretCanary },
    })

    expect(JSON.parse(lines[0])).toEqual({
      timestamp: '2026-08-23T12:00:00.000Z',
      level: 'info',
      event: 'service.operation',
      metadata: { serviceName: 'control-api' },
      details: { correlationId: 'correlation-1', password: '[REDACTED]' },
    })
    expect(lines[0]).not.toContain(secretCanary)
  })

  test('maps every semantic identifier to stable attributes', () => {
    expect(semanticAttributes(identifiers)).toEqual({
      'service.name': 'control-api',
      'request.id': 'request-1',
      'control.correlation_id': 'correlation-1',
      'workspace.id': 'workspace-1',
      'execution.id': 'execution-1',
      'execution.attempt.id': 'attempt-1',
      'workflow.id': 'workflow-1',
      'runtime.id': 'runtime-1',
      'runtime.node.id': 'runtime-node-1',
      'agent.profile.version': 'profile:v4',
      'agent.skill.version': 'skill:v7',
      'agent.graph.version': 'graph:v3',
      'gen_ai.request.model': 'reasoning-standard',
      'tool.id': 'tool.search/v2',
      'policy.version': 'policy:v5',
      'sandbox.id': 'sandbox-1',
      'delegation.id': 'delegation-1',
    })
  })

  test('defines the complete execution span and operational metric vocabulary', () => {
    expect(executionTraceSpans).toEqual([
      'execution.root',
      'plan.compile',
      'workflow.run',
      'runtime.route',
      'runtime.start',
      'graph.run',
      'graph.node',
      'model.call',
      'tool.authorize',
      'tool.execute',
      'sandbox.execute',
      'approval.wait',
      'artifact.promote',
      'usage.settle',
      'execution.cleanup',
    ])
    expect(operationalMetrics).toContain('control.api.request.duration')
    expect(operationalMetrics).toContain('workflow.backlog.count')
    expect(operationalMetrics).toContain('runtime.gateway.ack.duration')
    expect(operationalMetrics).toContain('execution.reconciliation.count')
    expect(operationalMetrics).toContain('usage.cost.usd')
    expect(diagnosticQueries.map(({ failureClass }) => failureClass)).toEqual([
      'application',
      'workflow',
      'gateway',
      'runtime',
      'provider',
      'policy',
    ])
    expect(diagnosticQueries.every(({ signals }) => signals.length > 0)).toBe(true)
  })

  test('keeps execution correct when every telemetry adapter fails', async () => {
    const unavailable = () => {
      throw new Error('TELEMETRY_UNAVAILABLE')
    }
    const telemetry = createTelemetry({
      serviceName: 'workflow-worker',
      traceAdapter: { startSpan: unavailable },
      metricAdapter: { add: unavailable, record: unavailable },
      logger: { write: unavailable },
      errorTracker: { captureException: unavailable },
    })

    telemetry.increment('workflow.backlog.count', 1, identifiers)
    telemetry.record('control.api.request.duration', 12, identifiers)
    telemetry.log('info', 'execution.accepted', identifiers, { safe: true })
    await expect(
      telemetry.withServiceSpan('execution.run', identifiers, async () => 'completed')
    ).resolves.toBe('completed')
    await expect(
      telemetry.withServiceSpan('execution.fail', identifiers, async () => {
        throw new Error('DOMAIN_FAILURE')
      })
    ).rejects.toThrow('DOMAIN_FAILURE')
  })

  test('samples deterministically from stable execution identity', () => {
    const policy = createDeterministicSamplingPolicy({ ratio: 0.25, salt: 'release-v1' })
    const first = policy.shouldSample({ name: 'execution.root', identifiers })
    const repeated = policy.shouldSample({ name: 'execution.root', identifiers })

    expect(first).toBe(repeated)
    expect(
      createDeterministicSamplingPolicy({ ratio: 0 }).shouldSample({
        name: 'execution.root',
        identifiers,
      })
    ).toBe(false)
    expect(
      createDeterministicSamplingPolicy({ ratio: 1 }).shouldSample({
        name: 'execution.root',
        identifiers,
      })
    ).toBe(true)
  })

  test('keeps a secret canary out of LangSmith traces', () => {
    const secretCanary = 'secret-canary-trace-9f4a'
    const runs = []
    const adapter = createLangSmithTraceAdapter({
      enabled: true,
      client: {
        startRun(input) {
          const record = { input, outcome: undefined }
          runs.push(record)
          return { end: (outcome) => (record.outcome = outcome) }
        },
      },
    })
    const span = adapter.startSpan({
      name: 'model.call',
      attributes: {
        'execution.id': 'execution-1',
        prompt: secretCanary,
        diagnostic: `token=${secretCanary}`,
      },
    })
    span.end({ status: 'ok' })

    expect(JSON.stringify(runs)).not.toContain(secretCanary)
    expect(runs[0].input).toEqual({
      name: 'model.call',
      metadata: {
        'execution.id': 'execution-1',
        prompt: '[REDACTED]',
        diagnostic: 'token=[REDACTED]',
      },
    })
  })

  test('keeps a secret canary out of captured errors', () => {
    const secretCanary = 'secret-canary-error-9f4a'
    const secret = `token=${secretCanary}`
    const directOutcomes = []
    const telemetry = createTelemetry({
      serviceName: 'control-api',
      traceAdapter: {
        startSpan() {
          return { end: (outcome) => directOutcomes.push(outcome) }
        },
      },
    })
    const runs = []
    const langSmith = createLangSmithTraceAdapter({
      client: {
        startRun() {
          return { end: (outcome) => runs.push(outcome) }
        },
      },
    })

    telemetry.startSpan('http.request').end({ status: 'error', error: new Error(secret) })
    langSmith.startSpan({ name: 'model.call', attributes: {} }).end({
      status: 'error',
      error: new Error(secret),
    })

    expect(JSON.stringify({ directOutcomes, runs })).not.toContain(secretCanary)
    expect(directOutcomes[0]).toEqual({
      status: 'error',
      error: { name: 'Error', message: 'token=[REDACTED]' },
    })
    expect(runs[0]).toEqual({
      status: 'error',
      error: { name: 'Error', message: 'token=[REDACTED]' },
    })
  })

  test('propagates only valid W3C trace context across a carrier boundary', () => {
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    const context = extractTraceContext({ traceparent, tracestate: 'vendor=OpaqueValue' })
    const carrier = {}

    injectTraceContext(context, carrier)

    expect(carrier).toEqual({ traceparent, tracestate: 'vendor=OpaqueValue' })
    expect(extractTraceContext({ traceparent: 'unsafe' })).toBeUndefined()
  })

  test('records service and database spans and reports sanitized failures', async () => {
    const spans = []
    const errors = []
    const telemetry = createTelemetry({
      serviceName: 'control-api',
      traceAdapter: {
        startSpan(input) {
          const record = { input, outcome: undefined }
          spans.push(record)
          return {
            context: {
              traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
            },
            end(outcome) {
              record.outcome = outcome
            },
          }
        },
      },
      errorTracker: {
        captureException(error, context) {
          errors.push({ error, context })
        },
      },
    })

    await telemetry.withServiceSpan('execution.create', identifiers, async () => 'created')
    await expect(
      telemetry.withDatabaseSpan(
        'transaction.commit',
        { ...identifiers, workspaceId: undefined },
        async () => {
          throw new Error('failed with password=private')
        }
      )
    ).rejects.toThrow('failed')

    expect(spans.map(({ input }) => input.name)).toEqual([
      'service.execution.create',
      'database.transaction.commit',
    ])
    expect(spans.map(({ outcome }) => outcome.status)).toEqual(['ok', 'error'])
    expect(JSON.stringify(errors)).not.toContain('private')
  })

  test('configures Sentry without PII and redacts captured diagnostics', async () => {
    const calls = { captured: [], contexts: [], initialized: [] }
    const sdk = {
      captureException(error) {
        calls.captured.push(error)
      },
      async flush() {
        return true
      },
      init(options) {
        calls.initialized.push(options)
      },
      withScope(operation) {
        operation({ setContext: (_name, context) => calls.contexts.push(context) })
      },
    }
    const tracker = await createSentryErrorTracker({
      dsn: 'https://public@example.invalid/1',
      environment: 'test',
      release: '1.0.0',
      sdk,
    })

    tracker.captureException(new Error('token=private'), { authorization: 'private' })
    await tracker.flush?.()

    expect(calls.initialized[0]).toEqual(
      expect.objectContaining({ enabled: true, sendDefaultPii: false })
    )
    expect(JSON.stringify({ captured: calls.captured, contexts: calls.contexts })).not.toContain(
      'private'
    )
  })

  test('does not initialize disabled Sentry and fails open when its SDK cannot initialize', async () => {
    let initializationAttempts = 0
    const unavailableSdk = {
      captureException() {},
      async flush() {
        return false
      },
      init() {
        initializationAttempts += 1
        throw new Error('SENTRY_UNAVAILABLE')
      },
      withScope() {},
    }

    const disabled = await createSentryErrorTracker({
      enabled: false,
      environment: 'test',
      release: '1.0.0',
      sdk: unavailableSdk,
    })
    expect(initializationAttempts).toBe(0)
    expect(() => disabled.captureException(new Error('domain'))).not.toThrow()

    const unavailable = await createSentryErrorTracker({
      dsn: 'https://public@example.invalid/1',
      environment: 'test',
      release: '1.0.0',
      sdk: unavailableSdk,
    })
    expect(initializationAttempts).toBe(1)
    expect(() => unavailable.captureException(new Error('domain'))).not.toThrow()
  })

  test('redacts loopback endpoints from telemetry values and attributes', () => {
    const canary = 'loopback-canary-9f4a'
    const redacted = redactTelemetryValue({
      admin: `http://127.0.0.1:9070/v1/${canary}`,
      ingress: `http://localhost:8080/${canary}`,
      ipv6: `ws://[::1]:8080/${canary}`,
      bare: `route 127.127.1.2 keeps ${canary}`,
      unbracketed: `connect ::1 for ${canary}`,
      external: `https://control-plane.example.com/${canary}`,
    })

    const serialized = JSON.stringify(redacted)
    expect(serialized).not.toContain('127.0.0.1')
    expect(serialized).not.toContain('localhost')
    expect(serialized).not.toContain('::1')
    expect(serialized).toContain('control-plane.example.com')
    expect(redacted.admin).toBe(`http://[REDACTED_LOOPBACK]/v1/${canary}`)
    expect(redacted.ingress).toBe(`http://[REDACTED_LOOPBACK]/${canary}`)
    expect(redacted.ipv6).toBe(`ws://[REDACTED_LOOPBACK]/${canary}`)
    expect(redacted.bare).toBe(`route [REDACTED_LOOPBACK] keeps ${canary}`)
    expect(redacted.unbracketed).toBe(`connect [REDACTED_LOOPBACK] for ${canary}`)
    expect(sanitizeAttributes({ endpoint: `postgresql://localhost:5432/${canary}` })).toEqual({
      endpoint: `postgresql://[REDACTED_LOOPBACK]/${canary}`,
    })
  })

  test('redacts private filesystem paths from telemetry values', () => {
    const canary = 'path-canary-9f4a'
    const redacted = redactTelemetryValue({
      home: `/Users/dev/${canary}/control-plane.sqlite`,
      tmp: `stored at /tmp/${canary}-dir/file for later`,
      system: `/etc/control-plane/${canary}.conf and /var/log/${canary}.log`,
      windows: `mounted C:\\Users\\dev\\${canary}`,
      relative: `see docs/${canary}/readme`,
      url: `https://control-plane.example.com/docs/${canary}`,
    })

    const serialized = JSON.stringify(redacted)
    expect(serialized).not.toContain('/Users/dev')
    expect(serialized).not.toContain(`/tmp/${canary}`)
    expect(serialized).not.toContain('/etc/control-plane')
    expect(serialized).not.toContain('/var/log')
    expect(serialized).not.toContain('C:\\\\Users\\\\dev')
    expect(redacted.relative).toBe(`see docs/${canary}/readme`)
    expect(redacted.url).toBe(`https://control-plane.example.com/docs/${canary}`)
    expect(redacted.home).toBe('[REDACTED_PATH]')
    expect(redacted.tmp).toBe(`stored at [REDACTED_PATH] for later`)
  })

  test('emits consistency metrics exclusively under cataloged names with bounded labels', () => {
    const added = []
    const emitter = createConsistencyMetricEmitter(
      {
        add: (name, value, attributes) => added.push({ name, value, attributes }),
        record: () => undefined,
      },
      'local-control-plane'
    )

    emitter.recordAcceptanceOutcome('duplicate')
    emitter.recordAcceptanceOutcome('conflict')
    emitter.recordAcceptanceOutcome('accepted')
    emitter.recordResolution('included', 'PROVIDER_SELECTED')
    emitter.recordResolution('omitted', 'PROVIDER_REVOKED')
    emitter.recordResolution('degraded', 'objective text and scope digests must collapse')
    emitter.recordResolution('bogus-outcome', 'PROVIDER_UNAVAILABLE')
    emitter.recordApprovalDecision('approved')
    emitter.recordApprovalDecision('denied')
    emitter.recordApprovalDecision('expired')
    emitter.recordApprovalDecision('why did this happen')
    emitter.recordQuarantine({ reason: 'TRANSPORT_ERROR', attempted: true })
    emitter.recordQuarantine({ reason: 'HTTP_503', attempted: true })
    emitter.recordQuarantine({ reason: 'HTTP_429', attempted: true })
    emitter.recordQuarantine({ reason: 'SCHEMA_MISMATCH', attempted: false })
    emitter.recordQuarantine({ reason: 'HTTP_999', attempted: true })
    emitter.recordCheckpoint({
      reason: 'runtime_disconnected',
      state: 'manual_intervention',
      created: true,
    })
    emitter.recordCheckpoint({ reason: 'healthy', state: 'resolved', created: false })

    expect(added.map(({ name }) => name)).toEqual([
      'control.command_inbox.duplicate.count',
      'control.command_inbox.conflict.count',
      'context.provider_resolution.count',
      'context.provider_resolution.count',
      'context.provider_resolution.count',
      'context.provider_resolution.count',
      'memory.write.decision.count',
      'memory.write.decision.count',
      'memory.write.decision.count',
      'memory.write.decision.count',
      'control.event.quarantine.count',
      'control.event.quarantine.count',
      'control.event.quarantine.count',
      'control.event.quarantine.count',
      'control.event.quarantine.count',
      'execution.reconciliation.count',
      'execution.manual_intervention.count',
      'execution.reconciliation.count',
    ])
    expect(added.map(({ attributes }) => attributes)).toEqual([
      { 'service.name': 'local-control-plane', outcome: 'duplicate' },
      { 'service.name': 'local-control-plane', outcome: 'conflict' },
      { 'service.name': 'local-control-plane', outcome: 'included', reason: 'PROVIDER_SELECTED' },
      { 'service.name': 'local-control-plane', outcome: 'omitted', reason: 'PROVIDER_REVOKED' },
      { 'service.name': 'local-control-plane', outcome: 'degraded', reason: 'other' },
      { 'service.name': 'local-control-plane', outcome: 'other', reason: 'PROVIDER_UNAVAILABLE' },
      { 'service.name': 'local-control-plane', decision: 'approved' },
      { 'service.name': 'local-control-plane', decision: 'denied' },
      { 'service.name': 'local-control-plane', decision: 'expired' },
      { 'service.name': 'local-control-plane', decision: 'other' },
      {
        'service.name': 'local-control-plane',
        reason_category: 'transport_error',
        attempted: true,
      },
      { 'service.name': 'local-control-plane', reason_category: 'http_server', attempted: true },
      { 'service.name': 'local-control-plane', reason_category: 'http_retryable', attempted: true },
      {
        'service.name': 'local-control-plane',
        reason_category: 'schema_mismatch',
        attempted: false,
      },
      { 'service.name': 'local-control-plane', reason_category: 'other', attempted: true },
      {
        'service.name': 'local-control-plane',
        reason: 'runtime_disconnected',
        outcome: 'created',
      },
      { 'service.name': 'local-control-plane', reason: 'runtime_disconnected' },
      { 'service.name': 'local-control-plane', reason: 'healthy', outcome: 'observed' },
    ])
    for (const { name } of added) expect(operationalMetrics).toContain(name)
  })

  test('isolates consistency exporter failures per emission', () => {
    const attempts = []
    const emitter = createConsistencyMetricEmitter(
      {
        add(name) {
          attempts.push(name)
          throw new Error('EXPORTER_DOWN')
        },
        record: () => undefined,
      },
      'local-control-plane'
    )

    expect(() => emitter.recordAcceptanceOutcome('duplicate')).not.toThrow()
    expect(() =>
      emitter.recordCheckpoint({
        reason: 'terminal_undelivered',
        state: 'remediated',
        created: true,
      })
    ).not.toThrow()
    expect(() => emitter.recordResolution('omitted', 'PROVIDER_REVOKED')).not.toThrow()
    expect(attempts).toEqual([
      'control.command_inbox.duplicate.count',
      'execution.reconciliation.count',
      'context.provider_resolution.count',
    ])
  })

  test('exposes every consistency metric name in the catalog', () => {
    for (const name of Object.values(consistencyMetricNames)) {
      expect(operationalMetrics).toContain(name)
    }
  })
})
