import { describe, expect, test } from 'bun:test'
import { RuntimeCommandRecordSchema } from '@control-plane/domain'
import { observeRuntime as observeRuntimePostgres } from '../packages/database/src/reconciliation-projection.ts'
import { observeRuntime as observeRuntimeSqlite } from '../packages/sqlite-persistence/src/reconciliation-projection.ts'

// M11.7 (#192) characterization harness: the Postgres and SQLite
// reconciliation adapters carry line-for-line parallel decision logic. This
// suite drives the same logical inputs through both observeRuntime
// implementations and asserts identical observable outcomes, so the planned
// consolidation onto a storage-neutral module cannot silently change
// reconciliation semantics on either backend.

const now = '2026-09-01T12:00:00.000Z'
const resultReference = 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const attemptId = 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV'

const implementations = [
  ['postgres', observeRuntimePostgres],
  ['sqlite', observeRuntimeSqlite],
]

function runtimeRecord({ status, resultStatus, withReference = true } = {}) {
  const inFlight = status !== undefined && status !== 'queued'
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(status)
  return RuntimeCommandRecordSchema.parse({
    commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    attemptId,
    nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    runtimeConnectionId: 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    idempotencyKey: 'reconciliation-parity:runtime:1',
    payloadHash: `sha256:${'a'.repeat(64)}`,
    commandEnvelope: { operation: 'runtime.start' },
    issuedAt: now,
    expiresAt: '2026-09-01T13:00:00.000Z',
    ...(status === undefined ? {} : { status }),
    version: 3,
    deliveryAttempts: inFlight ? 1 : 0,
    ...(inFlight
      ? { lastChannelGeneration: 1, lastSequence: 1, firstDispatchedAt: now, lastDispatchedAt: now }
      : {}),
    ...(terminal
      ? {
          resultReference: withReference ? resultReference : undefined,
          resultStatus,
          resultRecordedAt: now,
        }
      : {}),
    updatedAt: now,
    createdAt: now,
  })
}

const attemptRunning = { state: 'running', updatedAt: now }
const executionRunning = { state: 'running', updatedAt: now }
const executionCompleted = { state: 'completed', updatedAt: now }
const executionReconciliation = { state: 'reconciliation_required', updatedAt: now }

describe('M11.7 reconciliation parity (characterization)', () => {
  const cases = []
  const recordCases = () => [
    undefined,
    runtimeRecord({ status: 'queued' }),
    runtimeRecord({ status: 'dispatched' }),
    runtimeRecord({ status: 'succeeded', resultStatus: 'succeeded' }),
    runtimeRecord({ status: 'failed', resultStatus: 'failed' }),
    runtimeRecord({ status: 'cancelled', resultStatus: 'cancelled' }),
    // A terminal record without a result reference must never claim success.
    runtimeRecord({ status: 'succeeded', resultStatus: 'succeeded', withReference: false }),
  ]
  const executionCases = [executionRunning, executionCompleted, executionReconciliation]

  for (const record of recordCases()) {
    for (const execution of executionCases) {
      cases.push({ record, execution })
    }
  }

  test('both storage backends observe identical runtime state', () => {
    for (const [index, { record, execution }] of cases.entries()) {
      const label = `case ${index} (status=${record?.status ?? 'none'}, execution=${execution.state})`
      const postgres = observeRuntimePostgres(record, attemptRunning, execution, undefined)
      const sqlite = observeRuntimeSqlite(record, attemptRunning, execution, undefined)
      expect(sqlite, label).toEqual(postgres)
    }
  })

  test('disconnected-connection observations are recorded per backend', () => {
    // The backends carry different connection shapes: Postgres reads
    // connection.updatedAt, SQLite reads connection.observedAt with an
    // execution-time fallback. Same logical input, per-backend transport.
    const logicalConnection = { status: 'disconnected' }
    const postgres = observeRuntimePostgres(
      runtimeRecord({ status: 'dispatched' }),
      attemptRunning,
      executionRunning,
      { ...logicalConnection, updatedAt: now }
    )
    const sqlite = observeRuntimeSqlite(
      runtimeRecord({ status: 'dispatched' }),
      attemptRunning,
      executionRunning,
      { ...logicalConnection, observedAt: undefined }
    )
    expect(postgres.status).toBe('disconnected')
    expect(sqlite.status).toBe('disconnected')
    expect(postgres.observedAt).toBe(now)
    expect(sqlite.observedAt).toBe(executionRunning.updatedAt)
  })

  test('the pinned semantic outcomes hold for both implementations', () => {
    for (const [, observe] of implementations) {
      const terminal = observe(
        runtimeRecord({ status: 'succeeded', resultStatus: 'succeeded' }),
        attemptRunning,
        executionRunning,
        undefined
      )
      expect(terminal, 'terminal runtime result converges').toMatchObject({
        status: 'completed',
        resultReference,
      })

      const lostAck = observe(
        runtimeRecord({ status: 'dispatched' }),
        attemptRunning,
        executionRunning,
        undefined
      )
      expect(
        ['running', 'waiting', 'uncertain', 'in_flight', 'pending', 'unknown'],
        `lost-ACK must not fabricate a terminal claim (got ${JSON.stringify(lostAck)})`
      ).toContain(lostAck.status)

      const absent = observe(undefined, attemptRunning, executionRunning, undefined)
      expect(absent.status, 'no runtime record means no terminal claim').not.toBe('completed')

      const referenceless = observe(
        runtimeRecord({ status: 'succeeded', resultStatus: 'succeeded', withReference: false }),
        attemptRunning,
        executionRunning,
        undefined
      )
      expect(
        referenceless.status,
        'a terminal result without its reference must be treated as unknown'
      ).not.toBe('completed')
    }
  })
})
