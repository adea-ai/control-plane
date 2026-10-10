import { expect, test } from 'bun:test'
import {
  PiDurableChildProgressScanner,
  PiDurableRetainedChildSchema,
} from './child-progress-scanner.ts'

const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const now = '2026-10-08T00:00:05.000Z'
function fixture() {
  const record = {
    identity: {
      schemaVersion: 'delegation-runtime-admission/v1',
      parentExecutionId: id('exe'),
      parentAttemptId: id('att'),
      delegationId: id('dlg'),
      childAttemptId: id('att').replace(/G$/, 'H'),
    },
    handle: {
      handleId: 'pi-durable:child-fixture',
      attemptId: id('att').replace(/G$/, 'H'),
      externalSessionId: id('ses'),
      startedAt: '2026-10-08T00:00:00.000Z',
    },
    canonicalState: 'queued',
  }
  const state = {
    active: true,
    calls: [],
    retained: [],
    events: [
      {
        handleId: record.handle.handleId,
        sequence: 1,
        occurredAt: '2026-10-08T00:00:01.000Z',
        type: 'status',
        data: { state: 'running' },
      },
      {
        handleId: record.handle.handleId,
        sequence: 2,
        occurredAt: '2026-10-08T00:00:02.000Z',
        type: 'status',
        data: { state: 'completed' },
      },
    ],
    status: {
      handle: structuredClone(record.handle),
      state: 'completed',
      observedAt: '2026-10-08T00:00:02.000Z',
      result: {
        outcome: 'completed',
        output: { text: 'Retained evidence.' },
        usage: { inputTokens: 2, outputTokens: 1, durationMs: 1 },
        artifacts: [],
      },
    },
  }
  const adapter = {
    status: async () => {
      await state.beforeStatus?.()
      return structuredClone(state.status)
    },
    async *progress() {
      for (const value of state.events) yield structuredClone(value)
    },
  }
  const scanner = new PiDurableChildProgressScanner({
    now: () => now,
    listRetainedChildren: async () => [structuredClone(record)],
    assertCurrent: async (retained) => {
      expect(retained.identity.childAttemptId).toBe(record.identity.childAttemptId)
      if (!state.active) throw new Error('private-canonical-authority')
    },
    retainTerminalResult: async (_retained, result) => {
      state.retained.push(result)
      await state.beforeRetention?.()
      return state.artifactRef ?? id('art')
    },
    bridge: {
      recordProgress: async (identity, progress) => {
        expect(identity).toEqual(record.identity)
        state.calls.push(progress)
        record.canonicalState = progress.state
        if (state.crashAfterRunning && progress.state === 'running')
          throw new Error('crash-after-committed-running')
      },
    },
  })
  return { record, state, adapter, scanner }
}

test('first terminal poll replays actual running evidence, retains result and resumes after a committed running checkpoint crash', async () => {
  const { scanner, state, adapter, record } = fixture()
  state.crashAfterRunning = true
  expect((await scanner.scan(adapter)).blocked).toHaveLength(1)
  expect(record.canonicalState).toBe('running')
  expect(state.calls).toHaveLength(1)
  expect(state.calls[0].observedAt).toBe(state.events[0].occurredAt)
  expect(state.retained).toHaveLength(0)
  state.crashAfterRunning = false
  expect((await scanner.scan(adapter)).published).toBe(1)
  expect(state.calls.map((value) => value.state)).toEqual(['running', 'completed'])
  expect(state.calls[1]).toMatchObject({
    terminalResultRef: id('art'),
    observedAt: state.status.observedAt,
  })
  expect(state.retained[0]).toEqual(state.status.result)
  expect((await scanner.scan(adapter)).published).toBe(1)
  expect(state.calls.filter((value) => value.state === 'running')).toHaveLength(1)
})

test.each(['missing', 'wrong_handle', 'reordered', 'future'])(
  'terminal-first publication denies %s progress evidence without fabricating a running checkpoint',
  async (fault) => {
    const { scanner, state, adapter } = fixture()
    if (fault === 'missing') state.events = []
    if (fault === 'wrong_handle') state.events[0].handleId = 'pi-durable:other'
    if (fault === 'reordered') state.events[1].sequence = 1
    if (fault === 'future') state.events[1].occurredAt = '2026-10-08T00:00:03.000Z'
    const outcome = await scanner.scan(adapter)
    expect(outcome.published).toBe(0)
    expect(outcome.blocked).toHaveLength(1)
    expect(state.calls).toHaveLength(0)
    expect(state.retained).toHaveLength(0)
  }
)

test.each(['status', 'retention'])(
  'authority revoked while awaiting %s cannot publish terminal output',
  async (boundary) => {
    const { scanner, state, adapter, record } = fixture()
    record.canonicalState = 'running'
    if (boundary === 'status')
      state.beforeStatus = () => {
        state.active = false
      }
    if (boundary === 'retention')
      state.beforeRetention = () => {
        state.active = false
      }
    const outcome = await scanner.scan(adapter)
    expect(outcome.published).toBe(0)
    expect(outcome.blocked).toHaveLength(1)
    expect(state.calls).toHaveLength(0)
    expect(JSON.stringify(outcome)).not.toContain('private-canonical-authority')
    state.active = true
    state.beforeStatus = undefined
    state.beforeRetention = undefined
    expect((await scanner.scan(adapter)).published).toBe(1)
    expect(state.calls).toHaveLength(1)
  }
)

test('wrong exact handle, invalid retained artifact and forged model identity fail closed', async () => {
  const { scanner, state, adapter, record } = fixture()
  state.status.handle.startedAt = '2026-10-08T00:00:01.000Z'
  expect((await scanner.scan(adapter)).blocked).toHaveLength(1)
  expect(state.calls).toHaveLength(0)
  state.status.handle.startedAt = record.handle.startedAt = '2026-10-08T00:00:00.000Z'
  record.canonicalState = 'running'
  state.artifactRef = 'model://untrusted-output'
  expect((await scanner.scan(adapter)).blocked).toHaveLength(1)
  expect(state.calls).toHaveLength(0)
  expect(
    PiDurableRetainedChildSchema.safeParse({ ...record, provider: 'model-supplied' }).success
  ).toBe(false)
  expect(
    PiDurableRetainedChildSchema.safeParse({
      ...record,
      handle: { ...record.handle, attemptId: id('att') },
    }).success
  ).toBe(false)
})

test('unknown paid inference is skipped; unsuccessful outcome publishes a bounded failure without raw runtime diagnostics', async () => {
  const { scanner, state, adapter, record } = fixture()
  state.status = { handle: record.handle, state: 'unknown', observedAt: now }
  expect((await scanner.scan(adapter)).skipped).toBe(1)
  expect(state.calls).toHaveLength(0)
  state.status = {
    ...state.status,
    state: 'failed',
    error: {
      code: 'PRIVATE_PROVIDER_ERROR',
      classification: 'runtime',
      message: 'private-provider-diagnostic',
      retryable: true,
    },
  }
  expect((await scanner.scan(adapter)).published).toBe(1)
  expect(state.calls[0].failure).toEqual({
    classification: 'runtime_error',
    code: 'PI_CHILD_RUNTIME_FAILED',
    retryable: false,
  })
  expect(JSON.stringify(state.calls)).not.toContain('private-provider')
  expect(state.retained).toHaveLength(0)
})
