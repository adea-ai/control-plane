import { describe, expect, test } from 'bun:test'
import { createEnrolledSecureAcpRemoteTransport } from './acp-remote-composition.ts'
import { AcpRemoteUndeliveredError } from './acp-remote-transport.ts'
import { createSecureFixture, runtimeCommand } from './acp-remote-fixtures.mjs'

const FINAL_AUTHORITY_READ = 4

// Parks the authority read made immediately before the send, so the test can change local state
// while that await is suspended and then let the read succeed.
function deferFinalAuthorityRead(fixture) {
  let reads = 0
  let release
  const parked = new Promise((resolve) => {
    release = resolve
  })
  let finalReadStarted
  const started = new Promise((resolve) => {
    finalReadStarted = resolve
  })
  const controller = controllerFor(fixture, async () => {
    reads += 1
    if (reads !== FINAL_AUTHORITY_READ) return
    finalReadStarted()
    await parked
  })
  return { controller, started, release: () => release() }
}

function controllerFor(fixture, assertCurrent, isCurrent = () => true) {
  return createEnrolledSecureAcpRemoteTransport({
    route: fixture.route,
    wire: fixture.wire,
    controller: {
      keyId: fixture.route.controllerKeyId,
      signingKey: fixture.keys.controllerSigning,
    },
    grantState: () => 'granted',
    now: fixture.now,
    controllerAuthority: { assertCurrent, isCurrent },
  })
}

describe('secure ACP controller enrollment authority', () => {
  test('rechecks the enrolled signer immediately before sending a sealed command', async () => {
    const fixture = await createSecureFixture()
    let authorityReads = 0
    const controller = controllerFor(fixture, async () => {
      authorityReads += 1
      if (authorityReads >= 4) throw new Error('controller enrollment revoked')
    })

    await expect(controller.dispatch(runtimeCommand())).rejects.toThrow(
      'ACP_REMOTE_CONTROLLER_AUTHORITY_DENIED'
    )
    expect(authorityReads).toBe(4)
    expect(controller.connectionState()).toBe('offline')
    expect(() => controller.revoke('2026-08-25T12:00:30.000Z')).toThrow(
      'ACP_REMOTE_CONTROLLER_AUTHORITY_RECHECK_REQUIRED'
    )
    await expect(controller.revokeCurrent('2026-08-25T12:00:30.000Z')).rejects.toThrow(
      'ACP_REMOTE_CONTROLLER_AUTHORITY_DENIED'
    )
    expect(fixture.wire.log.some(({ direction }) => direction === 'command')).toBe(false)
  })

  test('does not publish inventory returned after the controller enrollment is revoked', async () => {
    const fixture = await createSecureFixture()
    let revoked = false
    const requestInventory = fixture.wire.requestInventory.bind(fixture.wire)
    fixture.wire.requestInventory = async (requestId) => {
      const inventory = await requestInventory(requestId)
      revoked = true
      return inventory
    }
    const controller = controllerFor(fixture, async () => {
      if (revoked) throw new Error('controller enrollment revoked')
    })

    await expect(controller.inventory()).rejects.toThrow('ACP_REMOTE_CONTROLLER_AUTHORITY_DENIED')
    expect(controller.connectionState()).toBe('offline')
  })

  test('a reconnected wire stays offline until the current authority check passes', async () => {
    const fixture = await createSecureFixture()
    let enrolled = true
    const controller = controllerFor(fixture, async () => {
      if (!enrolled) throw new Error('controller enrollment revoked')
    })

    await expect(controller.inventory()).resolves.toBeTruthy()
    expect(controller.connectionState()).toBe('online')
    fixture.wire.setOnline(false)
    expect(controller.connectionState()).toBe('offline')
    fixture.wire.setOnline(true)
    enrolled = false
    // The synchronous cached view still says current, but reconnect needs a fresh durable result.
    expect(controller.connectionState()).toBe('offline')
    await expect(controller.inventory()).rejects.toThrow('ACP_REMOTE_CONTROLLER_AUTHORITY_DENIED')
    expect(controller.connectionState()).toBe('offline')

    enrolled = true
    await expect(controller.inventory()).resolves.toBeTruthy()
    expect(controller.connectionState()).toBe('online')
    await expect(controller.revokeCurrent('2026-08-25T12:00:30.000Z')).resolves.toMatchObject({
      kind: 'device_revocation',
      controllerKeyId: fixture.route.controllerKeyId,
    })
  })

  test('a wire failure latches offline even if reconnect happens before state is polled', async () => {
    const fixture = await createSecureFixture()
    let enrolled = true
    const controller = controllerFor(fixture, async () => {
      if (!enrolled) throw new Error('controller enrollment revoked')
    })

    await expect(controller.inventory()).resolves.toBeTruthy()
    expect(controller.connectionState()).toBe('online')

    fixture.wire.setOnline(false)
    await expect(controller.inventory()).rejects.toThrow()
    fixture.wire.setOnline(true)
    enrolled = false

    // The offline operation was observed, but no connectionState poll saw the disconnect.
    // A stale positive authority cache must not make the reconnected wire visible as online.
    expect(controller.connectionState()).toBe('offline')
    await expect(controller.inventory()).rejects.toThrow('ACP_REMOTE_CONTROLLER_AUTHORITY_DENIED')
    expect(controller.connectionState()).toBe('offline')

    enrolled = true
    await expect(controller.inventory()).resolves.toBeTruthy()
    expect(controller.connectionState()).toBe('online')
  })

  test('a command delivery disconnect latches offline until current authority is rechecked', async () => {
    const fixture = await createSecureFixture()
    let enrolled = true
    const controller = controllerFor(fixture, async () => {
      if (!enrolled) throw new Error('controller enrollment revoked')
    })

    await expect(controller.inventory()).resolves.toBeTruthy()
    expect(controller.connectionState()).toBe('online')

    fixture.wire.sendCommand = async () => {
      fixture.wire.setOnline(false)
      throw new AcpRemoteUndeliveredError()
    }
    await expect(controller.dispatch(runtimeCommand())).rejects.toThrow()
    fixture.wire.setOnline(true)
    enrolled = false

    // The stale synchronous cache must not restore visibility after an observed delivery failure.
    expect(controller.connectionState()).toBe('offline')
    await expect(controller.dispatch(runtimeCommand())).rejects.toThrow(
      'ACP_REMOTE_CONTROLLER_AUTHORITY_DENIED'
    )
  })

  describe('state that changes while the final authority read is suspended', () => {
    test('a send proceeds exactly once when nothing changed during the final read', async () => {
      const fixture = await createSecureFixture()
      const { controller, started, release } = deferFinalAuthorityRead(fixture)

      const pending = controller.dispatch(runtimeCommand())
      await started
      expect(fixture.wire.commandAttempts()).toBe(0)
      release()

      await expect(pending).resolves.toBeTruthy()
      expect(fixture.wire.commandAttempts()).toBe(1)
    })

    test('a local revocation during the final read sends nothing', async () => {
      const fixture = await createSecureFixture()
      const { controller, started, release } = deferFinalAuthorityRead(fixture)

      const pending = controller.dispatch(runtimeCommand())
      const outcome = pending.then(
        () => ({ settled: 'resolved' }),
        (error) => ({ settled: 'rejected', error })
      )
      await started
      await controller.revokeCurrent('2026-08-25T12:00:10.000Z')
      release()

      const result = await outcome
      expect(result.settled).toBe('rejected')
      expect(result.error).toMatchObject({ code: 'RUNTIME_NODE_REVOKED' })
      expect(fixture.wire.commandAttempts()).toBe(0)
    })

    test('an abort during the final read sends nothing', async () => {
      const fixture = await createSecureFixture()
      const { controller, started, release } = deferFinalAuthorityRead(fixture)
      const abort = new AbortController()

      const pending = controller.dispatch(runtimeCommand(), abort.signal)
      const outcome = pending.then(
        () => ({ settled: 'resolved' }),
        (error) => ({ settled: 'rejected', error })
      )
      await started
      abort.abort()
      release()

      const result = await outcome
      expect(result.settled).toBe('rejected')
      expect(result.error).toMatchObject({ code: 'RUNTIME_GATEWAY_TIMEOUT' })
      expect(fixture.wire.commandAttempts()).toBe(0)
    })

    test('command expiry during the final read sends nothing', async () => {
      const fixture = await createSecureFixture()
      const { controller, started, release } = deferFinalAuthorityRead(fixture)

      const pending = controller.dispatch(runtimeCommand())
      const outcome = pending.then(
        () => ({ settled: 'resolved' }),
        (error) => ({ settled: 'rejected', error })
      )
      await started
      // The default command window is 60 seconds from NOW; the route stays valid until 13:00.
      fixture.clock.current = new Date('2026-08-25T12:02:00.000Z')
      release()

      const result = await outcome
      expect(result.settled).toBe('rejected')
      expect(result.error).toMatchObject({ code: 'RUNTIME_GATEWAY_COMMAND_EXPIRED' })
      expect(fixture.wire.commandAttempts()).toBe(0)
    })

    test('a wire disconnect during the final read sends nothing', async () => {
      const fixture = await createSecureFixture()
      const { controller, started, release } = deferFinalAuthorityRead(fixture)

      const pending = controller.dispatch(runtimeCommand())
      const outcome = pending.then(
        () => ({ settled: 'resolved' }),
        (error) => ({ settled: 'rejected', error })
      )
      await started
      fixture.wire.setOnline(false)
      release()

      const result = await outcome
      expect(result.settled).toBe('rejected')
      expect(result.error).toMatchObject({ code: 'RUNTIME_NODE_OFFLINE' })
      expect(fixture.wire.commandAttempts()).toBe(0)
    })
  })
})
