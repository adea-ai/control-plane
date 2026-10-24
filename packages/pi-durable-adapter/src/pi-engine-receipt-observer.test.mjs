import { expect, test } from 'bun:test'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { createPiDurableEngine } from './pi-engine.ts'

const at = '2026-10-23T12:00:00.000Z'
const expiresAt = '2026-10-23T12:01:00.000Z'
const query = (overrides = {}) => ({
  sessionId: 'observer:session',
  requestId: 'cancel:one',
  requestDigest: `sha256:${'a'.repeat(64)}`,
  targetDigest: `sha256:${'b'.repeat(64)}`,
  expiresAt,
  turnKey: 'turn:one',
  inferenceId: null,
  ...overrides,
})
function deferred() {
  let resolve
  const promise = new Promise((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
async function fixture(
  use,
  { qualification = true, authority, blockedTool, readyFailure = false } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-receipt-observer-'))
  const faux = fauxProvider()
  faux.setResponses([
    blockedTool
      ? fauxAssistantMessage(
          fauxToolCall('delegate_child', { objective: 'bounded' }, { id: 'call_delegate_1' }),
          { stopReason: 'toolUse' }
        )
      : fauxAssistantMessage('A completed local answer'),
  ])
  const counters = { authority: 0, models: 0, ready: 0, closed: 0, clock: 0 }
  let clock = at
  let refuseCallbacks = false
  const engine = createPiDurableEngine({
    directory,
    model: { provider: 'faux', modelId: 'faux-1' },
    maxOutputTokens: 32,
    assertAuthority: async () => {
      counters.authority += 1
      if (refuseCallbacks) throw new Error('OBSERVER_MUST_NOT_AUTHORIZE')
      await authority?.()
    },
    withModels: async (callback) => {
      counters.models += 1
      if (refuseCallbacks) throw new Error('OBSERVER_MUST_NOT_ACCESS_MODELS')
      const models = createModels()
      models.setProvider(faux.provider)
      return callback(models)
    },
    ...(blockedTool
      ? {
          governedDelegateChild: {
            source: {
              workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
              parentExecutionId: 'exe_01JABCDEF0123456789ABCDEFG',
              parentAttemptId: 'att_01JABCDEF0123456789ABCDEFG',
              runtimeHandleId: 'pi-durable:observer',
              externalSessionId: 'observer:session',
              admittedTurnKey: 'turn:one',
            },
            assertCurrent: async () => {},
            execute: async () => {
              if (blockedTool === 'throw') throw new Error('SCRIPTED_TOOL_FAILURE')
              return {
                schemaVersion: 'pi-delegate-child-outcome/v1',
                state: 'reconciliation_required',
                toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
                reasonCode: 'PI_CHILD_OUTCOME_UNKNOWN',
              }
            },
          },
        }
      : {}),
    ...(qualification
      ? {
          nativeCancellationQualification: {
            now: () => {
              counters.clock += 1
              return clock
            },
            onOwnerReady: () => {
              counters.ready += 1
              if (readyFailure) throw new Error('SCRIPTED_READY_FAILURE')
            },
            onOwnerClosed: () => {
              counters.closed += 1
            },
          },
        }
      : {}),
  })
  try {
    await use({
      engine,
      counters,
      faux,
      expire: () => {
        clock = '2026-10-23T13:00:00.000Z'
      },
      refuseCallbacks: () => {
        refuseCallbacks = true
      },
      run: () =>
        engine.run({ sessionId: 'observer:session', requestId: 'turn:one', input: 'Question' }),
    })
  } finally {
    await engine.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('discarded native reply is observable by its existing owner without settlement, new work or expiry authorization', async () => {
  await fixture(async (f) => {
    await f.run()
    const capability = f.engine.guardedCancellation
    const pins = query()
    const prepared = await capability.prepare(pins)
    // N really commits to SQLite. Dropping its return models an unpublished reply,
    // not an executed adapter journal-publication failure or recovery consumer.
    await capability.commit(prepared)
    const inspection = await f.engine.inspect(pins.sessionId)
    const database = new DatabaseSync(f.engine.storePath(pins.sessionId), { readOnly: true })
    try {
      const version = database.prepare('PRAGMA data_version').get().data_version
      const baseline = { ...f.counters, provider: f.faux.state.callCount }
      f.expire()
      f.refuseCallbacks()
      const receipt = await capability.readReceipt(pins)
      expect(receipt).toMatchObject({
        requestId: pins.requestId,
        requestDigest: pins.requestDigest,
        metadata: { targetDigest: pins.targetDigest, turnKey: pins.turnKey, expiresAt },
      })
      expect(await capability.readReceipt(pins)).toEqual(receipt)
      expect(await capability.drainReceipt(pins)).toEqual(receipt)
      expect(await capability.drainReceipt(pins)).toEqual(receipt)
      expect(await f.engine.inspect(pins.sessionId)).toEqual(inspection)
      expect({ ...f.counters, provider: f.faux.state.callCount }).toEqual(baseline)
      expect(database.prepare('PRAGMA data_version').get().data_version).toBe(version)
      expect(f.faux.state.callCount).toBe(1)
    } finally {
      database.close()
    }
  })
})

test('historical receipt refuses wrong bindings and absent request stays absent', async () => {
  await fixture(async (f) => {
    await f.run()
    const capability = f.engine.guardedCancellation
    await capability.commit(await capability.prepare(query()))
    for (const change of [
      { requestDigest: `sha256:${'c'.repeat(64)}` },
      { targetDigest: `sha256:${'d'.repeat(64)}` },
      { expiresAt: '2026-10-23T12:02:00.000Z' },
      { turnKey: 'successor' },
      { inferenceId: 'successor' },
    ]) {
      await expect(capability.readReceipt(query(change))).rejects.toThrow(
        'PI_NATIVE_CANCELLATION_RECEIPT_BINDING_INVALID'
      )
      await expect(capability.drainReceipt(query(change))).rejects.toThrow(
        'PI_NATIVE_CANCELLATION_RECEIPT_BINDING_INVALID'
      )
    }
    expect(await capability.readReceipt(query({ requestId: 'absent' }))).toBeUndefined()
    await expect(capability.drainReceipt(query({ requestId: 'absent' }))).rejects.toThrow(
      'PI_GUARDED_ABORT_RECEIPT_MISSING'
    )
    const mutable = query()
    const reading = capability.readReceipt(mutable)
    mutable.targetDigest = `sha256:${'e'.repeat(64)}`
    expect((await reading).metadata.targetDigest).toBe(query().targetDigest)
  })
})

test('unopened and closed observers are unavailable and never create a session', async () => {
  await fixture(async (f) => {
    const capability = f.engine.guardedCancellation
    await expect(capability.readReceipt(query())).rejects.toThrow(
      'PI_NATIVE_CANCELLATION_OBSERVER_UNAVAILABLE'
    )
    await expect(capability.drainReceipt(query())).rejects.toThrow(
      'PI_NATIVE_CANCELLATION_OBSERVER_UNAVAILABLE'
    )
    await expect(access(f.engine.storePath(query().sessionId))).rejects.toThrow()
    expect(f.counters).toEqual({ authority: 0, models: 0, ready: 0, closed: 0, clock: 0 })
    await f.run()
    await capability.commit(await capability.prepare(query()))
    await expect(capability.readReceipt(query({ sessionId: 'wrong-session' }))).rejects.toThrow(
      'PI_NATIVE_CANCELLATION_OBSERVER_UNAVAILABLE'
    )
    await f.engine.close()
    const baseline = { ...f.counters }
    await expect(capability.readReceipt(query())).rejects.toThrow(
      'PI_NATIVE_CANCELLATION_OBSERVER_UNAVAILABLE'
    )
    await expect(capability.drainReceipt(query())).rejects.toThrow(
      'PI_NATIVE_CANCELLATION_OBSERVER_UNAVAILABLE'
    )
    expect(f.counters).toEqual(baseline)
  })
})

test('an opening promise is not an admitted observer owner', async () => {
  const entered = deferred()
  const release = deferred()
  await fixture(
    async (f) => {
      const opening = f.engine.inspect(query().sessionId)
      await entered.promise
      try {
        await expect(f.engine.guardedCancellation.readReceipt(query())).rejects.toThrow(
          'PI_NATIVE_CANCELLATION_OBSERVER_UNAVAILABLE'
        )
        expect(f.counters.models).toBe(0)
        expect(f.counters.ready).toBe(0)
      } finally {
        release.resolve()
      }
      await opening
    },
    {
      authority: async () => {
        entered.resolve()
        await release.promise
      },
    }
  )
})

test('ordinary production engine has no guarded observer capability', async () => {
  await fixture(
    async (f) => {
      expect(f.engine.guardedCancellation).toBeUndefined()
      expect(f.counters.ready).toBe(0)
    },
    { qualification: false }
  )
})

test.each(['reconciliation', 'throw'])(
  'a %s tool closure revokes observer ownership before global close',
  async (blockedTool) => {
    await fixture(
      async (f) => {
        await expect(f.run()).rejects.toThrow()
        expect(f.counters.ready).toBe(1)
        const baseline = { ...f.counters }
        await expect(f.engine.guardedCancellation.readReceipt(query())).rejects.toThrow(
          'PI_NATIVE_CANCELLATION_OBSERVER_UNAVAILABLE'
        )
        await expect(f.engine.guardedCancellation.drainReceipt(query())).rejects.toThrow(
          'PI_NATIVE_CANCELLATION_OBSERVER_UNAVAILABLE'
        )
        expect(f.counters).toEqual(baseline)
      },
      { blockedTool }
    )
  }
)

test('owner callback failure does not admit a historical observer', async () => {
  await fixture(
    async (f) => {
      await expect(f.engine.inspect(query().sessionId)).rejects.toThrow('SCRIPTED_READY_FAILURE')
      await expect(f.engine.guardedCancellation.readReceipt(query())).rejects.toThrow(
        'PI_NATIVE_CANCELLATION_OBSERVER_UNAVAILABLE'
      )
    },
    { readyFailure: true }
  )
})

test('closing while a native receipt read is pending refuses the stale owner', async () => {
  await fixture(async (f) => {
    await f.run()
    const capability = f.engine.guardedCancellation
    await capability.commit(await capability.prepare(query()))
    const reading = capability.readReceipt(query())
    const closing = f.engine.close()
    await expect(reading).rejects.toThrow('PI_NATIVE_CANCELLATION_OBSERVER_UNAVAILABLE')
    await closing
  })
})

test('malformed observer identity is refused before storage or authority access', async () => {
  await fixture(async (f) => {
    for (const identity of [
      query({ requestDigest: 'bad' }),
      query({ expiresAt: 'not-a-time' }),
      query({ extra: true }),
    ])
      await expect(f.engine.guardedCancellation.readReceipt(identity)).rejects.toThrow(
        'PI_NATIVE_CANCELLATION_RECEIPT_BINDING_INVALID'
      )
    expect(f.counters).toEqual({ authority: 0, models: 0, ready: 0, closed: 0, clock: 0 })
  })
})
