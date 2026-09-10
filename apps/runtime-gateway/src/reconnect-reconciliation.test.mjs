import { describe, expect, test } from 'bun:test'
import { InMemoryRuntimeCommandRepository } from '@control-plane/domain'
import {
  RecordingGatewayMetrics,
  RuntimeCommandDeliveryService,
  RuntimeReconnectReconciliationService,
} from './index.js'

const nodeId = 'rnr_01JABCDEF0123456789ABCDEFG'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'

describe('Runtime Gateway reconnect reconciliation', () => {
  test('redelivers queued and provably unacknowledged commands after restart', async () => {
    const fixture = await createFixture([record('A', 'queued'), record('B', 'dispatched', 4)])
    const result = await fixture.service.reconcile(hello(3, []), source())
    expect(result.redelivered).toBe(2)
    expect(fixture.sent).toHaveLength(2)
    expect(fixture.sent.map(({ commandId: sentCommandId }) => sentCommandId)).toEqual([
      commandId('A'),
      commandId('B'),
    ])
  })

  test('reuses cloud terminal outcomes and applies retained node terminal outcomes once', async () => {
    const fixture = await createFixture([
      record('A', 'succeeded', 1),
      record('B', 'acknowledged', 2),
    ])
    const result = await fixture.service.reconcile(
      hello(2, [outcome('A', 'succeeded'), outcome('B', 'failed')]),
      source()
    )
    expect(result).toMatchObject({ reused: 1, appliedTerminal: 1, redelivered: 0 })
    expect(fixture.applied.map(({ command }) => command.commandId)).toEqual([commandId('B')])
    expect(fixture.reconciled).toContain(executionId('B'))
  })

  test('makes acknowledged-without-outcome and unknown-ledger states explicit', async () => {
    const fixture = await createFixture([
      record('A', 'acknowledged', 1),
      record('C', 'acknowledged', 2),
    ])
    const result = await fixture.service.reconcile(
      hello(2, [outcome('Z', 'unknown'), outcome('C', 'unknown')]),
      source()
    )
    expect(result.manualIntervention).toBe(3)
    expect(result.redelivered).toBe(0)
    expect(fixture.manualInterventions).toEqual([
      {
        executionId: executionId('C'),
        commandId: commandId('C'),
        reason: 'unknown_retained_outcome',
      },
      {
        executionId: executionId('A'),
        commandId: commandId('A'),
        reason: 'acknowledged_without_outcome',
      },
    ])
  })

  test('does not resume expired, revoked, or capability-incompatible commands', async () => {
    const fixture = await createFixture(
      [record('A', 'queued', undefined, '2026-08-25T11:59:00.000Z'), record('B', 'queued')],
      { invalid: new Set([commandId('B')]) }
    )
    const result = await fixture.service.reconcile(hello(0, []), source())
    expect(result).toMatchObject({ expired: 1, invalid: 1, redelivered: 0 })
    expect(fixture.sent).toEqual([])
    expect(fixture.manualInterventions).toEqual([
      {
        executionId: executionId('B'),
        commandId: commandId('B'),
        reason: 'capability_changed',
      },
    ])
  })

  test('fails closed for wrong scope, payload conflicts, and duplicate retained outcomes', async () => {
    const fixture = await createFixture([record('A', 'acknowledged', 1)])
    await expect(
      fixture.service.reconcile(hello(1, []), {
        ...source(),
        workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG',
      })
    ).rejects.toMatchObject({ code: 'RECONNECT_SCOPE_MISMATCH' })
    await expect(
      fixture.service.reconcile(
        hello(1, [{ ...outcome('A', 'running'), payloadHash: `sha256:${'b'.repeat(64)}` }]),
        source()
      )
    ).rejects.toMatchObject({ code: 'RECONNECT_OUTCOME_CONFLICT' })
    await expect(
      fixture.service.reconcile(
        hello(1, [outcome('A', 'running'), outcome('A', 'running')]),
        source()
      )
    ).rejects.toThrow()
  })
})

async function createFixture(records, options = {}) {
  const repository = new InMemoryRuntimeCommandRepository()
  for (const value of records) await repository.create(value)
  const sent = []
  const metrics = new RecordingGatewayMetrics()
  const now = () => new Date('2026-08-25T12:00:00.000Z')
  const delivery = new RuntimeCommandDeliveryService({
    repository,
    sender: { send: async (envelope) => sent.push(envelope) },
    metrics,
    now,
  })
  const applied = []
  const reconciled = []
  const manualInterventions = []
  return {
    sent,
    applied,
    reconciled,
    manualInterventions,
    service: new RuntimeReconnectReconciliationService({
      repository,
      delivery,
      metrics,
      now,
      validator: {
        validate: async (command) =>
          options.invalid?.has(command.commandId)
            ? { valid: false, reason: 'capability_changed' }
            : { valid: true },
      },
      outcomes: { apply: async (command, retained) => applied.push({ command, retained }) },
      executions: {
        reconcile: async (id) => reconciled.push(id),
        requireManualIntervention: async (input) => manualInterventions.push(input),
      },
    }),
  }
}

function record(letter, status, lastSequence, expiresAt = '2026-08-25T12:05:00.000Z') {
  const delivered = status !== 'queued'
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(status)
  const acknowledged = status === 'acknowledged'
  return {
    commandId: commandId(letter),
    executionId: executionId(letter),
    attemptId: `att_01J${letter}BCDEF0123456789ABCDEFG`,
    nodeId,
    runtimeConnectionId: `rtc_01J${letter}BCDEF0123456789ABCDEFG`,
    workspaceId,
    idempotencyKey: `runtime-command:${letter.repeat(20)}`,
    payloadHash: `sha256:${'a'.repeat(64)}`,
    commandEnvelope: commandEnvelope(letter, expiresAt),
    issuedAt: '2026-08-25T11:55:00.000Z',
    expiresAt,
    status,
    version: 1,
    deliveryAttempts: delivered ? 1 : 0,
    ...(delivered
      ? {
          lastChannelGeneration: 1,
          lastSequence,
          firstDispatchedAt: '2026-08-25T11:56:00.000Z',
          lastDispatchedAt: '2026-08-25T11:56:00.000Z',
        }
      : {}),
    ...(acknowledged
      ? {
          acknowledgementReference: `ack:1:${lastSequence}`,
          acknowledgementDisposition: 'accepted',
          acknowledgedAt: '2026-08-25T11:57:00.000Z',
        }
      : {}),
    ...(terminal
      ? {
          resultReference: 'art_01JABCDEF0123456789ABCDEFG',
          resultStatus: status,
          resultRecordedAt: '2026-08-25T11:58:00.000Z',
        }
      : {}),
    createdAt: '2026-08-25T11:55:00.000Z',
    updatedAt: '2026-08-25T11:58:00.000Z',
  }
}

function hello(lastAcknowledgedSequence, retainedCommandOutcomes) {
  return {
    type: 'hello',
    schemaVersion: 1,
    protocolVersion: { major: 1, minor: 3 },
    sequence: 0,
    nodeId,
    workspaceId,
    traceId: 'trc_01JABCDEF0123456789ABCDEFG',
    sentAt: '2026-08-25T12:00:00.000Z',
    channelGeneration: 2,
    supportedVersions: [{ major: 1, minor: 3 }],
    lastAcknowledgedSequence,
    retainedCommandOutcomes,
  }
}

function outcome(letter, status) {
  return {
    commandId: commandId(letter),
    payloadHash: `sha256:${'a'.repeat(64)}`,
    status,
    observedAt: '2026-08-25T11:59:00.000Z',
    ...(status === 'succeeded'
      ? {
          result: {
            artifact: {
              artifactId: 'art_01JABCDEF0123456789ABCDEFG',
              digest: `sha256:${'c'.repeat(64)}`,
              mediaType: 'application/json',
              sizeBytes: 1,
            },
          },
        }
      : {}),
  }
}

function source() {
  return {
    nodeId,
    workspaceId,
    gatewayInstanceId: 'gateway-b',
    connectionId: 'connection-2',
    channelGeneration: 2,
    protocolVersion: { major: 1, minor: 3 },
    connectedAt: '2026-08-25T12:00:00.000Z',
    lastHeartbeatAt: '2026-08-25T12:00:00.000Z',
  }
}
function commandId(letter) {
  return `cmd_01J${letter}BCDEF0123456789ABCDEFG`
}
function executionId(letter) {
  return `exe_01J${letter}BCDEF0123456789ABCDEFG`
}
function commandEnvelope(letter, expiresAt) {
  return {
    type: 'command',
    schemaVersion: 1,
    protocolVersion: { major: 1, minor: 3 },
    sequence: 1,
    nodeId,
    workspaceId,
    traceId: 'trc_01JABCDEF0123456789ABCDEFG',
    sentAt: '2026-08-25T11:55:00.000Z',
    channelGeneration: 1,
    commandId: commandId(letter),
    idempotencyKey: `runtime-command:${letter.repeat(20)}`,
    payloadHash: `sha256:${'a'.repeat(64)}`,
    issuedAt: '2026-08-25T11:55:00.000Z',
    expiresAt,
    family: 'runtime',
    operation: 'runtime.execute',
    driver: { family: 'reference-runtime', version: '1.0.0' },
    runtimeConnectionId: `rtc_01J${letter}BCDEF0123456789ABCDEFG`,
    executionId: executionId(letter),
    attemptId: `att_01J${letter}BCDEF0123456789ABCDEFG`,
    requiredCapabilities: ['runtime.execute'],
    payload: { version: 1, parameters: {} },
  }
}
