// Delivery semantics of the secure ACP device route: what the controller is told once a command has
// (or has not) reached the device. A denial the device or controller reports after an effect may have
// run must never read as "nothing ran", and a per-delivery refusal before dispatch must never be
// stored as the command's permanent outcome.
import { describe, expect, test } from 'bun:test'
import { InMemoryAcpRemoteDeviceStateStore } from './acp-remote-device-state.ts'
import { commandIds, createSecureFixture, ids, runtimeCommand } from './acp-remote-fixtures.mjs'

const RUNTIME_SESSION = 'runtime.session'

const captured = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error })
  )

const iso = (clock) => clock.current.toISOString()

describe('controller reports a delivered command as delivered', () => {
  test('a wire that goes offline after the reply exists does not turn it into device_offline', async () => {
    const fixture = await createSecureFixture()
    fixture.wire.holdCommands()
    const pending = captured(
      fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.first }))
    )
    await fixture.wire.whenHeld(1)
    await fixture.wire.releaseHeld()
    // The device executed and replied; only now does the transport report the wire as down.
    fixture.wire.setOnline(false)
    const settled = await pending

    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
    expect(settled.error?.code).not.toBe('RUNTIME_NODE_OFFLINE')
  })

  test('the wire going offline while the command is in flight reports an unknown outcome, never undelivered', async () => {
    const fixture = await createSecureFixture()
    fixture.wire.holdCommands()
    const pending = captured(
      fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.first }))
    )
    await fixture.wire.whenHeld(1)
    // The reply is already produced when the wire is observed offline.
    fixture.wire.setOnline(false)
    await fixture.wire.releaseHeld()
    const settled = await pending

    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
    // Either the exchange is delivered or a retryable unknown outcome is reported; `device_offline`
    // (callers read it as "definitely never delivered") is the one answer that is false.
    expect(settled.error?.code).not.toBe('RUNTIME_NODE_OFFLINE')
    expect(settled.error?.details?.reason).not.toBe('device_offline')
  })
})

describe('a publication fence that trips after the effect ran is not reported as a pre-effect denial', () => {
  function expireDuringExecution(fixture) {
    const dispatch = fixture.executor.dispatch.bind(fixture.executor)
    fixture.executor.dispatch = async (command) => {
      const exchange = await dispatch(command)
      // The delivery window closes while the effect runs.
      fixture.clock.current = new Date(fixture.clock.current.getTime() + 61_000)
      return exchange
    }
  }

  test('window expiry during execution surfaces as a retryable unknown outcome, not command_expired', async () => {
    const fixture = await createSecureFixture()
    expireDuringExecution(fixture)

    const settled = await captured(
      fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.first }))
    )

    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
    expect(settled.error).toMatchObject({
      code: 'RUNTIME_NODE_RESPONSE_UNKNOWN',
      retryable: true,
    })
    expect(settled.error.code).not.toBe('RUNTIME_GATEWAY_COMMAND_EXPIRED')
  })

  test('the retry on the same command identity replays the recorded outcome without a second effect', async () => {
    const fixture = await createSecureFixture()
    expireDuringExecution(fixture)
    await captured(fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.first })))
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)

    // The controller retries with a fresh window; the device holds the recorded outcome.
    const retried = await fixture.controller.dispatch(
      runtimeCommand({ commandId: commandIds.first, issuedAt: iso(fixture.clock) })
    )

    expect(retried.ack).toBeDefined()
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })

  test('revocation after the effect is still reported as revoked', async () => {
    const fixture = await createSecureFixture()
    const dispatch = fixture.executor.dispatch.bind(fixture.executor)
    fixture.executor.dispatch = async (command) => {
      const exchange = await dispatch(command)
      await fixture.device.applyRevocation(fixture.controller.revoke('2026-08-25T12:00:10.000Z'))
      return exchange
    }

    const settled = await captured(
      fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.first }))
    )

    expect(settled.error).toMatchObject({ code: 'RUNTIME_NODE_REVOKED', retryable: false })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })
})

describe('a per-delivery refusal before dispatch is not the command’s permanent outcome', () => {
  test('an expiry that lands between claim and dispatch releases the claim and a fresh window runs once', async () => {
    const inner = new InMemoryAcpRemoteDeviceStateStore()
    const clockHolder = { current: undefined }
    const fixture = await createSecureFixture({
      stateStore: new Proxy(inner, {
        get(target, property) {
          if (property !== 'claim') {
            const value = Reflect.get(target, property)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return async (...args) => {
            const result = await target.claim(...args)
            if (clockHolder.armed) {
              clockHolder.armed = false
              clockHolder.current.current = new Date(clockHolder.current.current.getTime() + 61_000)
            }
            return result
          }
        },
      }),
    })
    clockHolder.current = fixture.clock
    clockHolder.armed = true

    const first = await captured(
      fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.first }))
    )
    expect(first.error).toMatchObject({ code: 'RUNTIME_GATEWAY_COMMAND_EXPIRED' })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
    // Nothing is left behind that could replay the expiry.
    expect(await inner.readLedger(commandIds.first)).toBeUndefined()

    const retried = await fixture.controller.dispatch(
      runtimeCommand({ commandId: commandIds.first, issuedAt: iso(fixture.clock) })
    )
    expect(retried.ack).toBeDefined()
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })
})

describe('the replay ledger recovers from capacity once windows close', () => {
  test('a full ledger refuses a new command while windows are open, then prunes closed windows', async () => {
    const store = new InMemoryAcpRemoteDeviceStateStore()
    const fixture = await createSecureFixture({ stateStore: store, replayLedgerCapacity: 2 })
    const send = (commandId) =>
      captured(
        fixture.controller.dispatch(
          runtimeCommand({
            commandId,
            issuedAt: iso(fixture.clock),
          })
        )
      )

    expect((await send(commandIds.first)).error).toBeUndefined()
    expect((await send(commandIds.second)).error).toBeUndefined()
    expect(await store.countLedger()).toBe(2)
    const third = commandIds.third
    expect((await send(third)).error).toMatchObject({
      code: 'RUNTIME_NODE_REPLAY_LEDGER_FULL',
    })

    // Both windows (60s) and the skew bound have closed.
    fixture.clock.current = new Date(fixture.clock.current.getTime() + 10 * 60_000)
    expect((await send(third)).error).toBeUndefined()
    expect(await store.countLedger()).toBeLessThanOrEqual(2)
    expect(await store.readLedger(third)).toMatchObject({ outcome: { kind: 'exchange' } })
  })
})
