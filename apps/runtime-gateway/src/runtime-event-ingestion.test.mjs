import { describe, expect, test } from 'bun:test'
import {
  ExecutionLifecycleService,
  InMemoryExecutionRepository,
  InMemoryRuntimeCommandRepository,
} from '@control-plane/domain'
import {
  InMemoryExecutionEventRepository,
  InMemoryRuntimeEventEffectSink,
} from '@control-plane/events'
import { golden } from '@control-plane/runtime-gateway-protocol/fixtures'
import { RecordingGatewayMetrics } from './websocket-lifecycle.js'
import { RuntimeCommandDeliveryService } from './runtime-command-delivery.js'
import { RuntimeEventIngestionService } from './runtime-event-ingestion.js'

const resultReference = 'art_01JABCDEF0123456789ABCDEFG'
const source = {
  nodeId: golden.command.nodeId,
  workspaceId: golden.command.workspaceId,
  channelGeneration: 1,
}

describe('Runtime Gateway event ingestion', () => {
  test('persists progress once and classifies duplicate, conflicting, and out-of-order frames', async () => {
    const fixture = await setup()
    expect(await fixture.ingestion.ingestProgress(golden.progress, source)).toMatchObject({
      outcome: 'applied',
      event: { type: 'attempt.progressed' },
    })
    expect(await fixture.ingestion.ingestProgress(golden.progress, source)).toMatchObject({
      outcome: 'duplicate',
    })
    expect(
      await fixture.ingestion.ingestProgress(
        { ...golden.progress, sequence: 4, eventSequence: 3 },
        source
      )
    ).toMatchObject({ outcome: 'applied' })
    expect(
      await fixture.ingestion.ingestProgress(
        { ...golden.progress, sequence: 3, eventSequence: 2 },
        source
      )
    ).toEqual({ outcome: 'out_of_order' })
    await expect(
      fixture.ingestion.ingestProgress(
        { ...golden.progress, event: { ...golden.progress.event, data: { message: 'changed' } } },
        source
      )
    ).rejects.toMatchObject({ code: 'RUNTIME_EVENT_CONFLICT' })

    expect(await fixture.events.queryAfter(golden.command.executionId, 0, 10)).toHaveLength(2)
    expect(fixture.quarantine.records).toHaveLength(1)
  })

  test('applies one normalized terminal result and one usage payload across duplicate delivery', async () => {
    const fixture = await setup()
    await fixture.delivery.deliver(golden.command.commandId, {
      channelGeneration: 2,
      sequence: 2,
    })
    const reconnectedSource = { ...source, channelGeneration: 2 }
    const first = await fixture.ingestion.ingestResult(golden.result, reconnectedSource)
    const duplicate = await fixture.ingestion.ingestResult(golden.result, reconnectedSource)

    expect(first).toMatchObject({
      outcome: 'applied',
      event: { type: 'execution.completed', payload: { usage: { outputTokens: 2 } } },
    })
    expect(duplicate).toMatchObject({
      outcome: 'duplicate',
      event: { eventId: first.event.eventId },
    })
    expect(await fixture.lifecycle.getExecution(golden.command.executionId)).toMatchObject({
      state: 'completed',
      terminalResultRef: resultReference,
    })
    expect(await fixture.executions.getAttempt(golden.command.attemptId)).toMatchObject({
      state: 'completed',
      terminalResultRef: resultReference,
    })
    expect(await fixture.events.queryAfter(golden.command.executionId, 0, 10)).toHaveLength(1)
  })

  test('quarantines wrong-node, payload-mismatch, and replaced-channel messages without effects', async () => {
    const fixture = await setup()
    await expect(
      fixture.ingestion.ingestProgress(
        { ...golden.progress, nodeId: 'rnr_01JABCDEF0123456789ABCDEFH' },
        { ...source, nodeId: 'rnr_01JABCDEF0123456789ABCDEFH' }
      )
    ).rejects.toMatchObject({ code: 'RUNTIME_EVENT_SCOPE_MISMATCH' })
    await expect(
      fixture.ingestion.ingestProgress(
        { ...golden.progress, payloadHash: `sha256:${'b'.repeat(64)}` },
        source
      )
    ).rejects.toMatchObject({ code: 'RUNTIME_EVENT_PAYLOAD_MISMATCH' })
    fixture.authority.active = false
    await expect(fixture.ingestion.ingestProgress(golden.progress, source)).rejects.toMatchObject({
      code: 'RUNTIME_EVENT_STALE_CHANNEL',
    })

    expect(fixture.quarantine.records.map(({ reason }) => reason)).toEqual([
      'RUNTIME_EVENT_SCOPE_MISMATCH',
      'RUNTIME_EVENT_PAYLOAD_MISMATCH',
      'RUNTIME_EVENT_STALE_CHANNEL',
    ])
    expect(await fixture.events.queryAfter(golden.command.executionId, 0, 10)).toEqual([])
  })

  test('keeps the first committed terminal outcome in cancellation races', async () => {
    const fixture = await setup()
    const attempt = await fixture.executions.getAttempt(golden.command.attemptId)
    const execution = await fixture.lifecycle.getExecution(golden.command.executionId)
    await fixture.lifecycle.transitionAttempt({
      attemptId: attempt.attemptId,
      expectedVersion: attempt.version,
      to: 'cancelled',
      transitionedAt: '2026-08-25T12:00:02.000Z',
    })
    await fixture.lifecycle.transitionExecution({
      executionId: execution.executionId,
      expectedVersion: execution.version,
      to: 'cancelled',
      transitionedAt: '2026-08-25T12:00:02.000Z',
    })

    expect(await fixture.ingestion.ingestResult(golden.result, source)).toEqual({
      outcome: 'terminal_conflict',
    })
    expect(await fixture.lifecycle.getExecution(golden.command.executionId)).toMatchObject({
      state: 'cancelled',
    })
  })

  test('serializes concurrent cancellation and completion frames with one terminal winner', async () => {
    const fixture = await setup()
    const cancelCommand = {
      ...golden.command,
      commandId: 'cmd_01JABCDEF0123456789ABCDEFP',
      idempotencyKey: 'runtime-control:01JABCDEF0123456789ABCDEFP',
      payloadHash: `sha256:${'e'.repeat(64)}`,
      protocolVersion: { major: 1, minor: 1 },
      operation: 'runtime.cancel',
      requiredCapabilities: ['execution.cancel'],
    }
    await fixture.delivery.enqueue(cancelCommand)
    await fixture.delivery.deliver(cancelCommand.commandId, {
      channelGeneration: 1,
      sequence: 10,
    })
    const cancelResult = {
      ...golden.result,
      commandId: cancelCommand.commandId,
      payloadHash: cancelCommand.payloadHash,
      protocolVersion: { major: 1, minor: 1 },
      sequence: 11,
      status: 'cancelled',
    }

    const outcomes = await Promise.all([
      fixture.ingestion.ingestResult(golden.result, source),
      fixture.ingestion.ingestResult(cancelResult, source),
    ])
    expect(outcomes.map(({ outcome }) => outcome).toSorted()).toEqual([
      'applied',
      'terminal_conflict',
    ])
    const execution = await fixture.lifecycle.getExecution(golden.command.executionId)
    expect(['completed', 'cancelled']).toContain(execution.state)
    expect(await fixture.events.queryAfter(golden.command.executionId, 0, 10)).toHaveLength(1)
  })

  test('dispatches cancellation, input, and approval through the durable command ledger', async () => {
    const fixture = await setup()
    await expect(
      fixture.ingestion.dispatchControl(
        {
          ...golden.command,
          commandId: 'cmd_01JABCDEF0123456789ABCDEFN',
          idempotencyKey: 'runtime-control:01JABCDEF0123456789ABCDEFN',
          protocolVersion: { major: 1, minor: 1 },
          operation: 'runtime.cancel',
          nodeId: 'rnr_01JABCDEF0123456789ABCDEFH',
          requiredCapabilities: ['execution.cancel'],
        },
        { channelGeneration: 1, sequence: 9 },
        fixture.delivery
      )
    ).rejects.toMatchObject({ code: 'RUNTIME_EVENT_SCOPE_MISMATCH' })
    for (const [index, operation] of [
      'runtime.cancel',
      'runtime.input',
      'runtime.approval',
    ].entries()) {
      const suffix = ['H', 'J', 'K'][index]
      const command = {
        ...golden.command,
        commandId: `cmd_01JABCDEF0123456789ABCDEF${suffix}`,
        idempotencyKey: `runtime-control:01JABCDEF0123456789ABCDEF${suffix}`,
        payloadHash: `sha256:${String(index + 2).repeat(64)}`,
        protocolVersion: { major: 1, minor: 1 },
        operation,
        requiredCapabilities: [
          {
            'runtime.cancel': 'execution.cancel',
            'runtime.input': 'interaction.user-input',
            'runtime.approval': 'interaction.approval',
          }[operation],
        ],
      }
      expect(
        await fixture.ingestion.dispatchControl(
          command,
          { channelGeneration: 1, sequence: index + 10 },
          fixture.delivery
        )
      ).toEqual({ sent: true, commandId: command.commandId })
    }
    expect(fixture.sender.envelopes.slice(1).map(({ operation }) => operation)).toEqual([
      'runtime.cancel',
      'runtime.input',
      'runtime.approval',
    ])

    await fixture.ingestion.ingestResult(golden.result, source)
    expect(
      await fixture.ingestion.dispatchControl(
        {
          ...golden.command,
          commandId: 'cmd_01JABCDEF0123456789ABCDEFM',
          idempotencyKey: 'runtime-control:01JABCDEF0123456789ABCDEFM',
          operation: 'runtime.cancel',
          protocolVersion: { major: 1, minor: 1 },
          requiredCapabilities: ['execution.cancel'],
        },
        { channelGeneration: 1, sequence: 20 },
        fixture.delivery
      )
    ).toEqual({ sent: false, terminalState: 'completed' })
  })

  test('requires Artifact references for terminal data and bounds inline progress payloads', async () => {
    const fixture = await setup()
    await expect(
      fixture.ingestion.ingestProgress(
        {
          ...golden.progress,
          event: { ...golden.progress.event, data: { value: 'x'.repeat(17_000) } },
        },
        source
      )
    ).rejects.toMatchObject({ code: 'RUNTIME_EVENT_PAYLOAD_TOO_LARGE' })

    const artifactResult = {
      ...golden.result,
      result: {
        artifact: {
          artifactId: resultReference,
          digest: `sha256:${'c'.repeat(64)}`,
          mediaType: 'application/json',
          sizeBytes: 128,
        },
      },
    }
    expect(await fixture.ingestion.ingestResult(artifactResult, source)).toMatchObject({
      outcome: 'applied',
    })
  })

  test('normalizes command-bound runtime errors into one durable failed terminal effect', async () => {
    const fixture = await setup()
    await expect(
      fixture.ingestion.ingestError({ ...golden.error, payloadHash: undefined }, source)
    ).rejects.toMatchObject({ code: 'RUNTIME_EVENT_SCOPE_MISMATCH' })
    expect(await fixture.ingestion.ingestError(golden.error, source)).toMatchObject({
      outcome: 'applied',
      event: {
        type: 'execution.failed',
        payload: { code: 'RUNTIME_UNAVAILABLE', retryable: true },
      },
    })
    expect(await fixture.lifecycle.getExecution(golden.command.executionId)).toMatchObject({
      state: 'failed',
      failure: { classification: 'runtime_error', code: 'RUNTIME_UNAVAILABLE' },
    })
  })
})

async function setup() {
  const executions = new InMemoryExecutionRepository()
  const lifecycle = new ExecutionLifecycleService(executions)
  let execution = await lifecycle.createExecution({
    executionId: golden.command.executionId,
    correlation: {
      workspaceId: golden.command.workspaceId,
      projectId: 'prj_01JABCDEF0123456789ABCDEFG',
      taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
      agentId: 'agt_01JABCDEF0123456789ABCDEFG',
      requestId: 'req_01JABCDEF0123456789ABCDEFG',
    },
    executionPlan: {
      executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
      contentDigest: `sha256:${'d'.repeat(64)}`,
      schemaVersion: 1,
    },
    acceptedAt: '2026-08-25T11:59:58.000Z',
  })
  let attempt = await lifecycle.createAttempt({
    executionId: execution.executionId,
    attemptId: golden.command.attemptId,
    expectedExecutionVersion: execution.version,
    queuedAt: '2026-08-25T11:59:59.000Z',
    runtime: {
      runtimeNodeRefId: golden.command.nodeId,
      runtimeConnectionId: golden.command.runtimeConnectionId,
    },
  })
  execution = await lifecycle.getExecution(execution.executionId)
  execution = await lifecycle.transitionExecution({
    executionId: execution.executionId,
    expectedVersion: execution.version,
    to: 'queued',
    transitionedAt: '2026-08-25T11:59:59.000Z',
  })
  await lifecycle.transitionExecution({
    executionId: execution.executionId,
    expectedVersion: execution.version,
    to: 'running',
    transitionedAt: '2026-08-25T12:00:00.000Z',
  })
  await lifecycle.transitionAttempt({
    attemptId: attempt.attemptId,
    expectedVersion: attempt.version,
    to: 'running',
    transitionedAt: '2026-08-25T12:00:00.000Z',
  })

  const commands = new InMemoryRuntimeCommandRepository()
  const sender = new RecordingSender()
  const metrics = new RecordingGatewayMetrics()
  const delivery = new RuntimeCommandDeliveryService({
    repository: commands,
    sender,
    metrics,
    now: () => new Date('2026-08-25T12:00:01.000Z'),
  })
  await delivery.enqueue(golden.command)
  await delivery.deliver(golden.command.commandId, { channelGeneration: 1, sequence: 1 })

  const events = new InMemoryExecutionEventRepository()
  const authority = {
    active: true,
    async isActive() {
      return this.active
    },
  }
  const quarantine = {
    records: [],
    async record(value) {
      this.records.push(value)
    },
  }
  const ingestion = new RuntimeEventIngestionService({
    commands,
    executions,
    effects: new InMemoryRuntimeEventEffectSink({ lifecycle, events }),
    normalizer: new FixtureNormalizer(),
    channelAuthority: authority,
    quarantine,
    metrics,
    now: () => new Date('2026-08-25T12:00:04.000Z'),
  })
  return {
    authority,
    commands,
    delivery,
    events,
    executions,
    ingestion,
    lifecycle,
    quarantine,
    sender,
  }
}

class FixtureNormalizer {
  async normalizeProgress({ frame }) {
    return {
      handleId: 'reference-handle',
      sequence: frame.eventSequence,
      occurredAt: frame.sentAt,
      type: frame.event.kind === 'runtime.usage' ? 'usage' : 'output',
      data: frame.event.data,
    }
  }

  async normalizeResult({ frame }) {
    const state = { succeeded: 'completed', failed: 'failed', cancelled: 'cancelled' }[frame.status]
    return {
      state,
      ...(frame.status === 'succeeded' ? { resultReference } : {}),
      ...(frame.status === 'failed'
        ? { failure: { classification: 'runtime_error', code: 'RUNTIME_FAILED' } }
        : {}),
      payload: { status: frame.status, usage: { outputTokens: 2 } },
    }
  }

  async normalizeError({ frame }) {
    return {
      state: 'failed',
      failure: { classification: 'runtime_error', code: frame.code },
      payload: { code: frame.code, retryable: frame.retryable },
    }
  }
}

class RecordingSender {
  envelopes = []
  async send(envelope) {
    this.envelopes.push(envelope)
  }
}
