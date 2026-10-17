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

  test('cleanup never reopens a command: a same-command retry with a fresh window does not run again', async () => {
    const store = new InMemoryAcpRemoteDeviceStateStore()
    const fixture = await createSecureFixture({ stateStore: store, replayLedgerCapacity: 2 })
    const send = (commandId) =>
      captured(
        fixture.controller.dispatch(runtimeCommand({ commandId, issuedAt: iso(fixture.clock) }))
      )
    expect((await send(commandIds.first)).error).toBeUndefined()
    expect((await send(commandIds.second)).error).toBeUndefined()
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(2)

    // Both windows close and a third command compacts them.
    fixture.clock.current = new Date(fixture.clock.current.getTime() + 10 * 60_000)
    expect((await send(commandIds.third)).error).toBeUndefined()
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(3)
    expect(await store.countLedger()).toBe(1)

    // The controller retries the first command with a fresh window: it passes validation, but its
    // duplicate protection survived cleanup, so the effect does not run a second time.
    const retried = await send(commandIds.first)
    expect(retried.error).toMatchObject({
      code: 'RUNTIME_NODE_OUTCOME_UNCERTAIN',
      retryable: false,
    })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(3)
    // A different payload reusing a compacted command id is a conflict, never a fresh effect.
    const conflicting = await captured(
      fixture.controller.dispatch(
        runtimeCommand({
          commandId: commandIds.second,
          issuedAt: iso(fixture.clock),
          parameters: { action: 'list', changed: true },
        })
      )
    )
    expect(conflicting.error).toBeDefined()
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(3)
  })

  test('a pending (uncertain) command stays protected after cleanup and is not re-run', async () => {
    const store = new InMemoryAcpRemoteDeviceStateStore()
    const fixture = await createSecureFixture({ stateStore: store, replayLedgerCapacity: 1 })
    // The executor fails after the effect for the first command only, leaving its claim pending.
    const dispatch = fixture.executor.dispatch.bind(fixture.executor)
    let calls = 0
    fixture.executor.dispatch = async (command) => {
      calls += 1
      const exchange = await dispatch(command)
      if (calls === 1) throw new Error('EXECUTOR_FAILED_AFTER_EFFECT')
      return exchange
    }
    const send = (commandId) =>
      captured(
        fixture.controller.dispatch(runtimeCommand({ commandId, issuedAt: iso(fixture.clock) }))
      )
    expect((await send(commandIds.first)).error).toMatchObject({
      code: 'RUNTIME_NODE_OUTCOME_UNCERTAIN',
    })
    expect(await store.readLedger(commandIds.first)).toMatchObject({ identity: expect.any(String) })
    expect((await store.readLedger(commandIds.first)).outcome).toBeUndefined()

    fixture.clock.current = new Date(fixture.clock.current.getTime() + 10 * 60_000)
    expect((await send(commandIds.second)).error).toBeUndefined()
    expect(await store.countLedger()).toBe(1)
    const effectsBefore = fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)

    const retried = await send(commandIds.first)
    expect(retried.error).toMatchObject({ code: 'RUNTIME_NODE_OUTCOME_UNCERTAIN' })
    expect(calls).toBe(2)
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(effectsBefore)
  })
})

describe('an accepted delivery that is answered without a new claim still advances the generation fence', () => {
  const effects = (fixture) => fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)

  test('a higher-generation replay supersedes the older generation for a distinct command', async () => {
    const store = new InMemoryAcpRemoteDeviceStateStore()
    const fixture = await createSecureFixture({ stateStore: store })
    await fixture.controller.dispatch(
      runtimeCommand({ commandId: commandIds.first, channelGeneration: 1 })
    )
    expect(effects(fixture)).toBe(1)

    // A/gen2 is the recorded command again: served from the ledger, with no new claim.
    const replay = await fixture.controller.dispatch(
      runtimeCommand({ commandId: commandIds.first, channelGeneration: 2 })
    )
    expect(replay.ack).toBeDefined()
    expect(effects(fixture)).toBe(1)
    expect((await store.loadFence()).highestGeneration).toBe(2)

    await expect(
      fixture.controller.dispatch(
        runtimeCommand({ commandId: commandIds.second, channelGeneration: 1 })
      )
    ).rejects.toMatchObject({ code: 'RUNTIME_GATEWAY_STALE_CHANNEL', retryable: false })
    expect(effects(fixture)).toBe(1)
  })

  test('a coalesced in-flight duplicate at a higher generation advances the fence while the effect runs', async () => {
    const store = new InMemoryAcpRemoteDeviceStateStore()
    const fixture = await createSecureFixture({ stateStore: store })
    const dispatch = fixture.executor.dispatch.bind(fixture.executor)
    let entered
    const running = new Promise((resolve) => {
      entered = resolve
    })
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    fixture.executor.dispatch = async (command) => {
      entered()
      await gate
      return dispatch(command)
    }

    const first = captured(
      fixture.controller.dispatch(
        runtimeCommand({ commandId: commandIds.first, channelGeneration: 1 })
      )
    )
    await running
    const duplicate = captured(
      fixture.controller.dispatch(
        runtimeCommand({ commandId: commandIds.first, channelGeneration: 2 })
      )
    )
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await store.loadFence()).highestGeneration === 2) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect((await store.loadFence()).highestGeneration).toBe(2)
    release()
    // The generation-1 delivery was superseded while it ran, so its reply is withheld as an unknown
    // outcome; the generation-2 duplicate coalesced onto the same effect and receives it.
    expect((await first).error).toMatchObject({ code: 'RUNTIME_NODE_RESPONSE_UNKNOWN' })
    expect((await duplicate).error).toBeUndefined()
    expect(effects(fixture)).toBe(1)

    await expect(
      fixture.controller.dispatch(
        runtimeCommand({ commandId: commandIds.second, channelGeneration: 1 })
      )
    ).rejects.toMatchObject({ code: 'RUNTIME_GATEWAY_STALE_CHANNEL', retryable: false })
    expect(effects(fixture)).toBe(1)
  })

  test('a replay refused by a newer fence is withheld and does not lower or move the fence', async () => {
    const store = new InMemoryAcpRemoteDeviceStateStore()
    const fixture = await createSecureFixture({ stateStore: store })
    await fixture.controller.dispatch(
      runtimeCommand({ commandId: commandIds.first, channelGeneration: 3 })
    )
    await expect(
      fixture.controller.dispatch(
        runtimeCommand({ commandId: commandIds.first, channelGeneration: 2 })
      )
    ).rejects.toMatchObject({ code: 'RUNTIME_GATEWAY_STALE_CHANNEL', retryable: false })
    expect((await store.loadFence()).highestGeneration).toBe(3)
  })
})

describe('an executed command is never reported as expired once its reply is withheld', () => {
  const effects = (fixture) => fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)

  test('a sealed command redelivered after expiry reaches the outstanding controller as an unknown outcome', async () => {
    const fixture = await createSecureFixture()
    fixture.wire.holdCommands()
    const pending = captured(
      fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.first }))
    )
    await fixture.wire.whenHeld(1)
    const sealed = structuredClone(
      fixture.wire.log.find(({ direction }) => direction === 'command').message
    )

    // An earlier delivery of this sealed command executes; its reply never reaches the controller.
    expect(await fixture.device.handleCommand(structuredClone(sealed))).toMatchObject({
      kind: 'exchange',
    })
    expect(effects(fixture)).toBe(1)

    fixture.clock.current = new Date(fixture.clock.current.getTime() + 61_000)
    await fixture.wire.releaseHeld()

    const settled = await pending
    expect(settled.value).toBeUndefined()
    expect(settled.error).toMatchObject({ code: 'RUNTIME_NODE_RESPONSE_UNKNOWN', retryable: true })
    expect(settled.error.code).not.toBe('RUNTIME_GATEWAY_COMMAND_EXPIRED')
    expect(effects(fixture)).toBe(1)

    // The retry under a fresh window gets the recorded outcome, still without a second effect.
    const retried = await fixture.controller.dispatch(
      runtimeCommand({ commandId: commandIds.first, issuedAt: iso(fixture.clock) })
    )
    expect(retried.ack).toBeDefined()
    expect(effects(fixture)).toBe(1)
  })

  test('a pending claim stays outcome_uncertain when redelivered after expiry', async () => {
    const fixture = await createSecureFixture()
    fixture.executor.dispatch = async () => {
      throw new Error('executor failed after an unknown effect')
    }
    await captured(fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.first })))
    const sealed = fixture.wire.log.find(({ direction }) => direction === 'command').message

    fixture.clock.current = new Date(fixture.clock.current.getTime() + 61_000)
    const reply = await fixture.wire.resend(sealed)

    expect(reply).toMatchObject({ kind: 'denial', reason: 'outcome_uncertain' })
  })

  test('a command that never ran still gets command_expired after its window closes', async () => {
    const fixture = await createSecureFixture()
    fixture.wire.holdCommands()
    const pending = captured(
      fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.first }))
    )
    await fixture.wire.whenHeld(1)
    fixture.clock.current = new Date(fixture.clock.current.getTime() + 61_000)
    await fixture.wire.releaseHeld()

    expect((await pending).error).toMatchObject({
      code: 'RUNTIME_GATEWAY_COMMAND_EXPIRED',
      retryable: false,
    })
    expect(effects(fixture)).toBe(0)
  })
})
