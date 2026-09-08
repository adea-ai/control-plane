import { describe, expect, test } from 'bun:test'
import {
  MockRuntimeAdapter,
  RuntimeAdapterContract,
  RuntimeAdapterError,
  RuntimeAdapterInspectionSchema,
  RuntimeExecutionProgressSchema,
  RuntimeExecutionStatusSchema,
  RuntimeSessionResultSchema,
  runRuntimeAdapterConformance,
} from './index.ts'

const attemptId = 'att_01JABCDEF0123456789ABCDEFG'

test('cancelled status preserves authoritative usage without a completed result', async () => {
  const adapter = createAdapter()
  const handle = await adapter.start({ attemptId, idempotencyKey: 'cancel-usage', executionPlan })
  const status = {
    handle,
    state: 'cancelled',
    observedAt: '2026-08-24T20:00:00.000Z',
    terminalUsage: { inputTokens: 11, outputTokens: 3, durationMs: 20 },
  }
  expect(RuntimeExecutionStatusSchema.parse(status).terminalUsage).toEqual(status.terminalUsage)
  expect(RuntimeExecutionStatusSchema.parse(status).result).toBeUndefined()
  expect(RuntimeExecutionStatusSchema.safeParse({ ...status, state: 'running' }).success).toBe(
    false
  )
  expect(
    RuntimeExecutionStatusSchema.safeParse({
      ...status,
      terminalUsage: { ...status.terminalUsage, inputTokens: -1 },
    }).success
  ).toBe(false)
})
const executionPlan = Object.freeze({
  schemaVersion: 1,
  executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
  contentDigest: `sha256:${'a'.repeat(64)}`,
  runtimeRequirements: [
    { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
    { capability: 'session.history', necessity: 'optional', minimumSupport: 'degraded' },
  ],
})

function createAdapter() {
  return new MockRuntimeAdapter({
    now: () => '2026-08-24T20:00:00.000Z',
    capabilities: [
      { name: 'stream.output', support: 'supported' },
      { name: 'execution.cancel', support: 'supported' },
      { name: 'interaction.user-input', support: 'supported' },
      { name: 'interaction.approval', support: 'supported' },
      { name: 'session.create', support: 'supported' },
      { name: 'session.history', support: 'degraded', limitations: ['History may be truncated'] },
      { name: 'session.close', support: 'supported' },
    ],
  })
}

describe('RuntimeAdapter contract', () => {
  test('exposes provider-neutral inspection and capability eligibility', async () => {
    const inspection = RuntimeAdapterInspectionSchema.parse(await createAdapter().inspect())

    expect(inspection.metadata).toEqual({
      contractVersion: { major: 1, minor: 0 },
      adapterName: 'mock',
      adapterVersion: '1.0.0',
      runtimeFamily: 'mock',
      driverVersion: '1.0.0',
      harnessVersion: '1.0.0',
    })
    expect(inspection.capabilityEvaluation).toBeUndefined()
    expect(
      (await createAdapter().inspect(executionPlan.runtimeRequirements)).capabilityEvaluation
    ).toEqual({
      eligible: true,
      mode: 'degraded',
      missingRequired: [],
      insufficientRequired: [],
      missingOptional: [],
      degradedOptional: ['session.history'],
    })
    expect(RuntimeAdapterContract.idempotentOperations).toContain('cleanup')
    expect(RuntimeAdapterContract.terminalStates).toEqual([
      'completed',
      'failed',
      'cancelled',
      'timed_out',
    ])
  })

  test('starts idempotently without mutating the immutable ExecutionPlan', async () => {
    const adapter = createAdapter()
    const before = globalThis.structuredClone(executionPlan)
    const request = { attemptId, idempotencyKey: 'dispatch:one', executionPlan }

    const first = await adapter.start(request)
    const replay = await adapter.start(request)

    expect(replay).toEqual(first)
    expect(executionPlan).toEqual(before)
    expect(() => {
      executionPlan.schemaVersion = 2
    }).toThrow()
  })

  test('normalizes progress, input, approval, cancellation, status, and reconciliation', async () => {
    const adapter = createAdapter()
    const handle = await adapter.start({
      attemptId,
      idempotencyKey: 'dispatch:lifecycle',
      executionPlan,
    })

    await adapter.submitInput(handle, {
      interactionId: 'int_01JABCDEF0123456789ABCDEFG',
      idempotencyKey: 'input:one',
      text: 'Continue',
    })
    await expect(
      adapter.submitInput(handle, {
        interactionId: 'int_01JABCDEF0123456789ABCDEFG',
        idempotencyKey: 'input:one',
        text: 'Conflicting input',
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', classification: 'conflict' })
    await adapter.submitApproval(handle, {
      interactionId: 'int_01JBBCDEF0123456789ABCDEFG',
      idempotencyKey: 'approval:one',
      decision: 'approve',
    })
    const progress = []
    for await (const event of adapter.progress(handle, { afterSequence: 0 })) {
      progress.push(RuntimeExecutionProgressSchema.parse(event))
    }
    expect(progress.map((event) => event.sequence)).toEqual([1, 2, 3, 4])
    expect(progress.map((event) => event.type)).toEqual([
      'status',
      'status',
      'interaction',
      'interaction',
    ])

    const cancelled = RuntimeExecutionStatusSchema.parse(
      await adapter.cancel(handle, {
        idempotencyKey: 'cancel:one',
        requestedAt: '2026-08-24T20:00:00.000Z',
      })
    )
    expect(cancelled.state).toBe('cancelled')
    expect(
      await adapter.cancel(handle, {
        idempotencyKey: 'cancel:one',
        requestedAt: '2026-08-24T20:00:00.000Z',
      })
    ).toEqual(cancelled)
    expect(await adapter.status(handle)).toEqual(cancelled)
    expect(await adapter.reconcile(handle)).toEqual(cancelled)
  })

  test('normalizes completed results, usage, artifacts, and adapter errors', async () => {
    const adapter = createAdapter()
    const handle = await adapter.start({
      attemptId,
      idempotencyKey: 'dispatch:complete',
      executionPlan,
    })
    const completed = adapter.complete(handle, {
      output: { answer: 42 },
      usage: { inputTokens: 10, outputTokens: 2, durationMs: 100 },
      artifacts: [
        {
          artifactId: 'art_01JABCDEF0123456789ABCDEFG',
          version: 1,
          mediaType: 'application/json',
          digest: `sha256:${'b'.repeat(64)}`,
          sizeBytes: 13,
          locator: 'artifact://result',
        },
      ],
    })

    expect(RuntimeExecutionStatusSchema.parse(completed).result).toMatchObject({
      outcome: 'completed',
      output: { answer: 42 },
      usage: { inputTokens: 10, outputTokens: 2, durationMs: 100 },
    })
    await expect(
      adapter.cancel(handle, {
        idempotencyKey: 'cancel:late',
        requestedAt: '2026-08-24T20:00:00.000Z',
      })
    ).rejects.toMatchObject({
      name: 'RuntimeAdapterError',
      code: 'EXECUTION_TERMINAL',
      classification: 'conflict',
      retryable: false,
    })
    expect(RuntimeAdapterError).toBeDefined()
  })

  test('supports independent session operations and explicit unsupported errors', async () => {
    const adapter = createAdapter()
    const created = RuntimeSessionResultSchema.parse(
      await adapter.session({ operation: 'create', idempotencyKey: 'session:create' })
    )
    const history = RuntimeSessionResultSchema.parse(
      await adapter.session({ operation: 'history', sessionId: created.session.sessionId })
    )

    expect(created.operation).toBe('create')
    expect(history).toMatchObject({ operation: 'history', entries: [] })
    await expect(adapter.session({ operation: 'list' })).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
      classification: 'unsupported',
    })
  })
})

describe('RuntimeAdapter conformance', () => {
  test('the mock adapter passes the reusable suite', async () => {
    const adapter = createAdapter()
    const report = await runRuntimeAdapterConformance({
      adapter,
      executionPlan,
      attemptId,
      complete: (handle) =>
        adapter.complete(handle, {
          output: { ok: true },
          usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
          artifacts: [],
        }),
    })

    expect(report.passed).toBe(true)
    expect(report.checks).toEqual([
      'inspection',
      'capabilities',
      'idempotent-start',
      'normalized-error',
      'immutable-plan',
      'progress',
      'status-reconcile',
      'terminal-result',
      'idempotent-cleanup',
    ])
  })
})
