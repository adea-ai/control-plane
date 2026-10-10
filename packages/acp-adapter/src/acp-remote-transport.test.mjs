import { describe, expect, test } from 'bun:test'
import { InMemoryAcpRemoteDeviceStateStore } from './acp-remote-device-state.ts'
import { ACP_REMOTE_SUITE, canonicalJson, signingPublicKeyOf, utf8 } from './acp-remote-crypto.ts'
import { SecureAcpRemoteTransport, SecureAcpDeviceEndpoint } from './acp-remote-transport.ts'
import {
  NOW,
  VALID_UNTIL,
  clientFor,
  commandIds,
  createSecureFixture,
  ids,
  plan,
  routeRecord,
  runtimeCommand,
  sealRawCommand,
  syntheticKeys,
} from './acp-remote-fixtures.mjs'

const RUNTIME_SESSION = 'runtime.session'

/** Captures a promise outcome without leaving a rejection unhandled while the wire is still moving. */
const captured = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error })
  )

/** Device-signed refusals that actually reached the controller over the wire. */
const signedRefusals = (fixture) =>
  fixture.wire.log.filter(
    ({ direction, message }) => direction === 'response' && message.kind === 'denial'
  )

/** Seals a runtime command under one fixed return key, as a single controller delivery would. */
async function sealCommandFor(fixture, command) {
  return sealRawCommand({
    route: fixture.route,
    signingKey: fixture.keys.controllerSigning,
    header: {
      suite: ACP_REMOTE_SUITE,
      workspaceId: ids.workspaceId,
      nodeId: ids.nodeId,
      runtimeConnectionId: ids.runtimeConnectionId,
      commandId: command.commandId,
      payloadHash: command.payloadHash,
      issuedAt: command.issuedAt,
      expiresAt: command.expiresAt,
      channelGeneration: command.channelGeneration,
      controllerKeyId: fixture.route.controllerKeyId,
      recipientKeyId: fixture.route.deviceEncryptionKeyId,
      returnKeyId: 'ret_000000000000000000000000000000f1',
      returnPublicKey: fixture.keys.otherRecipient.publicKey,
    },
    plaintext: utf8(canonicalJson(command)),
  })
}

/** Flips one base64url character inside the sealed data (never a padding bit). */
function flipInside(encoded) {
  const index = 4
  const replacement = encoded[index] === 'A' ? 'B' : 'A'
  return `${encoded.slice(0, index)}${replacement}${encoded.slice(index + 1)}`
}

describe('authenticated and encrypted secure ACP device route', () => {
  test('executes an ACP run over an authenticated, encrypted device route', async () => {
    const fixture = await createSecureFixture()
    const handle = await fixture.adapter.start({
      attemptId: ids.attemptId,
      idempotencyKey: 'acp:secure:start',
      executionPlan: plan(),
    })
    const progress = []
    for await (const event of fixture.adapter.progress(handle)) progress.push(event)

    expect(progress.map(({ type }) => type)).toEqual([
      'status',
      'output',
      'interaction',
      'usage',
      'artifact',
      'status',
    ])
    expect(await fixture.adapter.status(handle)).toMatchObject({ state: 'completed' })
    expect(fixture.driver.effectCount(ids.attemptId, 'runtime.execute')).toBe(1)

    const commands = fixture.wire.log.filter(({ direction }) => direction === 'command')
    expect(commands.length).toBeGreaterThan(0)
    for (const { message } of commands) {
      expect(message.header).toMatchObject({
        suite: 'control-plane.acp-remote.v1',
        workspaceId: ids.workspaceId,
        nodeId: ids.nodeId,
        runtimeConnectionId: ids.runtimeConnectionId,
        controllerKeyId: fixture.route.controllerKeyId,
        recipientKeyId: fixture.route.deviceEncryptionKeyId,
      })
      expect(message.signature).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(message.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(JSON.stringify(message)).not.toMatch(
        /runtime\.execute|grant:project-0001|native-session-1/
      )
    }
    const responses = fixture.wire.log.filter(({ direction }) => direction === 'response')
    expect(responses.length).toBeGreaterThan(0)
    for (const { message } of responses) {
      expect(message).toMatchObject({ kind: 'exchange' })
      expect(JSON.stringify(message)).not.toContain('"progress"')
    }
  })

  test('wire traffic carries no prompt plaintext or credential canaries', async () => {
    const promptCanary = 'CANARY-PROMPT-4f1e-DO-NOT-LEAK'
    const credentialCanary = 'sk-test-canary-0000-DO-NOT-LEAK'
    const fixture = await createSecureFixture()
    const created = await fixture.client.createSession('canary-session')
    await fixture.client.request('session/prompt', {
      sessionId: created.sessionId,
      prompt: [
        { type: 'text', text: promptCanary },
        { type: 'text', text: credentialCanary },
      ],
    })

    expect(fixture.driver.effectCount(ids.attemptId, 'runtime.execute')).toBe(1)
    const observed = JSON.stringify(fixture.wire.log)
    expect(observed).not.toContain(promptCanary)
    expect(observed).not.toContain(credentialCanary)
    expect(observed).not.toContain('PRIVATE KEY')
  })

  test('commands from an untrusted controller key never reach the executor or receive a signed reply', async () => {
    const fixture = await createSecureFixture()
    // An attacker can only present a forged route copy naming its own key; the device trusts the original.
    const forgedRoute = await routeRecord({
      controllerSigningPublicKey: signingPublicKeyOf(fixture.keys.impostorSigning),
    })
    const impostor = new SecureAcpRemoteTransport({
      route: forgedRoute,
      wire: fixture.wire,
      controller: { keyId: forgedRoute.controllerKeyId, signingKey: fixture.keys.impostorSigning },
      grantState: () => 'granted',
      now: fixture.now,
    })

    await expect(
      clientFor(impostor, fixture.clock).createSession('impostor')
    ).rejects.toMatchObject({
      code: 'RUNTIME_NODE_RESPONSE_UNKNOWN',
      classification: 'unknown',
      retryable: true,
    })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
    expect(signedRefusals(fixture)).toEqual([])
  })

  test('a command sealed for a different device key is denied before any effect', async () => {
    const fixture = await createSecureFixture()
    const misdirectedRoute = await routeRecord({
      deviceEncryptionPublicKey: fixture.keys.otherRecipient.publicKey,
    })
    const misdirected = new SecureAcpRemoteTransport({
      route: misdirectedRoute,
      wire: fixture.wire,
      controller: {
        keyId: misdirectedRoute.controllerKeyId,
        signingKey: fixture.keys.controllerSigning,
      },
      grantState: () => 'granted',
      now: fixture.now,
    })

    await expect(
      clientFor(misdirected, fixture.clock).createSession('misdirected')
    ).rejects.toMatchObject({
      code: 'RUNTIME_NODE_DECRYPTION_FAILED',
      retryable: false,
    })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
  })

  test('a tampered sealed command is refused without a signed reply and before any effect', async () => {
    const fixture = await createSecureFixture()
    await fixture.client.createSession('tamper-baseline')
    const sealedCommand = fixture.wire.log.find(({ direction }) => direction === 'command').message
    const tampered = structuredClone(sealedCommand)
    tampered.ciphertext = flipInside(tampered.ciphertext)

    await expect(fixture.wire.resend(tampered)).rejects.toMatchObject({
      code: 'RUNTIME_NODE_AUTHENTICATION_FAILED',
      retryable: false,
    })
    expect(signedRefusals(fixture)).toEqual([])
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })
})

describe('offline and revoked devices never reroute', () => {
  test('offline devices are denied before wire delivery and never reroute', async () => {
    const fixture = await createSecureFixture()
    fixture.wire.setOnline(false)

    expect(fixture.controller.connectionState()).toBe('offline')
    expect(fixture.controller.fenceDecision()).toEqual({
      outcome: 'denied',
      reason: 'device_offline',
      fallback: 'none',
    })
    await expect(fixture.client.createSession('offline')).rejects.toMatchObject({
      code: 'RUNTIME_GATEWAY_UNAVAILABLE',
      retryable: true,
    })
    await expect(
      fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.first }))
    ).rejects.toMatchObject({
      code: 'RUNTIME_NODE_OFFLINE',
      retryable: true,
      details: { reason: 'device_offline', fallback: 'none' },
    })
    await expect(fixture.controller.inventory()).rejects.toMatchObject({
      code: 'RUNTIME_NODE_OFFLINE',
    })
    expect(fixture.wire.commandAttempts()).toBe(0)
    expect(fixture.wire.inventoryAttempts()).toBe(0)
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
    expect(await fixture.adapter.inspect(plan().runtimeRequirements)).toMatchObject({
      health: 'unavailable',
    })
  })

  test('revoked devices are fenced at the controller before any wire delivery', async () => {
    const fixture = await createSecureFixture()
    const notice = fixture.controller.revoke('2026-08-25T12:00:30.000Z')

    expect(notice).toMatchObject({ kind: 'device_revocation', nodeId: ids.nodeId })
    expect(fixture.controller.connectionState()).toBe('revoked')
    await expect(fixture.client.createSession('revoked')).rejects.toMatchObject({
      code: 'RUNTIME_NODE_REVOKED',
      retryable: false,
      details: { reason: 'device_revoked', fallback: 'none' },
    })
    await expect(fixture.controller.inventory()).rejects.toMatchObject({
      code: 'RUNTIME_NODE_REVOKED',
    })
    expect(fixture.wire.commandAttempts()).toBe(0)
    expect(fixture.wire.inventoryAttempts()).toBe(0)
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
  })

  test('a revocation applied at the device fences a command already in flight', async () => {
    const fixture = await createSecureFixture()
    fixture.wire.holdCommands()
    const pending = captured(fixture.client.createSession('in-flight'))
    await fixture.wire.whenHeld(1)

    const notice = fixture.controller.revoke('2026-08-25T12:00:10.000Z')
    await fixture.device.applyRevocation(notice)
    expect(fixture.device.isRevoked()).toBe(true)
    await fixture.wire.releaseHeld()

    expect(await pending).toMatchObject({
      error: { code: 'RUNTIME_NODE_REVOKED', retryable: false },
    })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
  })

  test('device-side revocation is reported as a signed denial to a controller without local state', async () => {
    const fixture = await createSecureFixture()
    await fixture.device.applyRevocation(fixture.controller.revoke('2026-08-25T12:00:10.000Z'))
    const freshController = new SecureAcpRemoteTransport({
      route: fixture.route,
      wire: fixture.wire,
      controller: {
        keyId: fixture.route.controllerKeyId,
        signingKey: fixture.keys.controllerSigning,
      },
      grantState: () => 'granted',
      now: fixture.now,
    })

    expect(freshController.connectionState()).toBe('online')
    await expect(freshController.inventory()).rejects.toMatchObject({
      code: 'RUNTIME_NODE_REVOKED',
    })
    await expect(
      freshController.dispatch(runtimeCommand({ commandId: commandIds.first }))
    ).rejects.toMatchObject({ code: 'RUNTIME_NODE_REVOKED', retryable: false })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
  })
})

describe('trust freshness and command expiry are fenced before effects', () => {
  test('a command delivered after the device trust record expires is fenced at the device', async () => {
    const fixture = await createSecureFixture({ now: '2026-08-25T12:59:59.000Z' })
    fixture.wire.holdCommands()
    const pending = captured(fixture.client.createSession('stale-at-device'))
    await fixture.wire.whenHeld(1)

    fixture.clock.current = new Date('2026-08-25T13:00:00.500Z')
    await fixture.wire.releaseHeld()

    expect(await pending).toMatchObject({ error: { code: 'RUNTIME_NODE_STALE', retryable: true } })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
  })

  test('a controller at the trust expiry boundary fences inventory and dispatch', async () => {
    const fixture = await createSecureFixture({ now: VALID_UNTIL })

    expect(fixture.controller.fenceDecision()).toEqual({
      outcome: 'denied',
      reason: 'device_stale',
      fallback: 'none',
    })
    expect(fixture.controller.connectionState()).toBe('offline')
    await expect(fixture.controller.inventory()).rejects.toMatchObject({
      code: 'RUNTIME_NODE_STALE',
    })
    await expect(
      fixture.controller.dispatch(
        runtimeCommand({ issuedAt: VALID_UNTIL, expiresAt: '2026-08-25T13:01:00.000Z' })
      )
    ).rejects.toMatchObject({ code: 'RUNTIME_NODE_STALE' })
    expect(fixture.wire.commandAttempts()).toBe(0)
    expect(fixture.wire.inventoryAttempts()).toBe(0)
  })

  test('expired commands are never sent, and in-flight expiry is fenced at the device', async () => {
    const fixture = await createSecureFixture()
    await expect(
      fixture.controller.dispatch(
        runtimeCommand({
          issuedAt: '2026-08-25T11:00:00.000Z',
          expiresAt: '2026-08-25T11:01:00.000Z',
        })
      )
    ).rejects.toMatchObject({ code: 'RUNTIME_GATEWAY_COMMAND_EXPIRED', retryable: false })
    expect(fixture.wire.commandAttempts()).toBe(0)

    fixture.wire.holdCommands()
    const pending = captured(fixture.client.createSession('expire-in-flight'))
    await fixture.wire.whenHeld(1)
    fixture.clock.current = new Date(Date.parse(NOW) + 61_000)
    await fixture.wire.releaseHeld()

    expect(await pending).toMatchObject({
      error: { code: 'RUNTIME_GATEWAY_COMMAND_EXPIRED', retryable: false },
    })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
  })
})

describe('replay and stale-message handling', () => {
  test('replayed identical commands return the recorded response without a second effect', async () => {
    const fixture = await createSecureFixture()
    await fixture.client.createSession('replay-original')
    const original = fixture.wire.log.find(({ direction }) => direction === 'command').message

    const first = await fixture.wire.resend(original)
    const second = await fixture.wire.resend(original)

    expect(first).toMatchObject({ kind: 'exchange' })
    expect(second).toEqual(first)
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })

  test('a reused command identity with different content is denied as a conflict', async () => {
    const fixture = await createSecureFixture()
    const accepted = await fixture.controller.dispatch(
      runtimeCommand({ commandId: commandIds.second, parameters: { action: 'list' } })
    )
    expect(accepted.ack.disposition).toBe('accepted')

    await expect(
      fixture.controller.dispatch(
        runtimeCommand({
          commandId: commandIds.second,
          parameters: { action: 'list', afterSequence: 1 },
        })
      )
    ).rejects.toMatchObject({ code: 'RUNTIME_GATEWAY_COMMAND_CONFLICT', retryable: false })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })

  test('stale channel generations are denied after a newer generation was accepted', async () => {
    const fixture = await createSecureFixture()
    await fixture.controller.dispatch(
      runtimeCommand({ commandId: commandIds.third, channelGeneration: 2 })
    )

    await expect(
      fixture.controller.dispatch(
        runtimeCommand({ commandId: commandIds.fourth, channelGeneration: 1 })
      )
    ).rejects.toMatchObject({ code: 'RUNTIME_GATEWAY_STALE_CHANNEL', retryable: false })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })

  test('a device response that is not bound to the command is untrusted', async () => {
    const fixture = await createSecureFixture()
    fixture.wire.tamperNextResponse((response) => ({
      ...response,
      header: { ...response.header, commandId: commandIds.fourth },
    }))

    await expect(fixture.client.createSession('tampered-response')).rejects.toMatchObject({
      code: 'RUNTIME_NODE_RESPONSE_UNTRUSTED',
      retryable: false,
    })
  })

  test('a lost response is an unknown outcome and a same-identity retry is duplicate-safe', async () => {
    const fixture = await createSecureFixture()
    const command = runtimeCommand({ commandId: commandIds.first, parameters: { action: 'list' } })
    fixture.wire.dropNextResponse()

    await expect(fixture.controller.dispatch(command)).rejects.toMatchObject({
      code: 'RUNTIME_NODE_RESPONSE_UNKNOWN',
      classification: 'unknown',
      retryable: true,
    })
    const retried = await fixture.controller.dispatch(command)

    expect(retried.ack.disposition).toBe('accepted')
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })

  test('the replay ledger fails closed at capacity instead of evicting recorded commands', async () => {
    const fixture = await createSecureFixture({ replayLedgerCapacity: 1 })
    await fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.first }))

    await expect(
      fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.second }))
    ).rejects.toMatchObject({ code: 'RUNTIME_NODE_REPLAY_LEDGER_FULL', retryable: true })
    await fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.first }))
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })
})

describe('inventory and revocation authenticity', () => {
  test('inventory is device-signed and bound to the request that asked for it', async () => {
    const fixture = await createSecureFixture()
    const envelope = await fixture.controller.inventory()
    expect(envelope.runtimeDrivers).toEqual([
      expect.objectContaining({ driverFamily: 'acp', opaqueRef: ids.runtimeOpaqueRef }),
    ])
    const earlier = fixture.wire.observedInventory()

    fixture.wire.tamperNextInventory((response) => ({
      ...response,
      envelope: { ...response.envelope, runtimeDrivers: [] },
    }))
    await expect(fixture.controller.inventory()).rejects.toMatchObject({
      code: 'RUNTIME_NODE_RESPONSE_UNTRUSTED',
    })

    // A correctly signed reply from an earlier request cannot answer a later one.
    fixture.wire.tamperNextInventory(() => structuredClone(earlier))
    await expect(fixture.controller.inventory()).rejects.toMatchObject({
      code: 'RUNTIME_NODE_RESPONSE_UNTRUSTED',
    })
  })

  test('a correctly signed inventory older than the freshness bound is stale', async () => {
    const fixture = await createSecureFixture({ deviceClockLagMs: 120_000 })
    await expect(fixture.controller.inventory()).rejects.toMatchObject({
      code: 'RUNTIME_NODE_STALE',
      retryable: true,
    })
  })

  test('revocation notices must come from the trusted controller', async () => {
    const fixture = await createSecureFixture()
    const forgedRoute = await routeRecord({
      controllerSigningPublicKey: signingPublicKeyOf(fixture.keys.impostorSigning),
    })
    const impostor = new SecureAcpRemoteTransport({
      route: forgedRoute,
      wire: fixture.wire,
      controller: { keyId: forgedRoute.controllerKeyId, signingKey: fixture.keys.impostorSigning },
      grantState: () => 'granted',
      now: fixture.now,
    })

    let failure
    try {
      await fixture.device.applyRevocation(impostor.revoke(NOW))
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: 'RUNTIME_NODE_AUTHENTICATION_FAILED' })
    expect(fixture.device.isRevoked()).toBe(false)
    await expect(fixture.client.createSession('still-active')).resolves.toMatchObject({
      sessionId: expect.stringMatching(/^nses_/),
    })
  })
})

describe('route identity bindings fail closed at construction', () => {
  test('signing and recipient keys must match the route record', async () => {
    const keys = await syntheticKeys()
    const fixture = await createSecureFixture()
    const executor = fixture.executor
    const goodIdentity = { keyId: fixture.route.deviceKeyId, signingKey: keys.deviceSigning }
    const goodEncryption = {
      keyId: fixture.route.deviceEncryptionKeyId,
      privateKey: keys.deviceRecipient.keyPair.privateKey,
      publicKey: keys.deviceRecipient.publicKey,
    }

    expect(
      () =>
        new SecureAcpDeviceEndpoint({
          route: fixture.route,
          identity: { keyId: fixture.route.deviceKeyId, signingKey: keys.impostorSigning },
          encryption: goodEncryption,
          executor,
        })
    ).toThrow('ACP_REMOTE_IDENTITY_MISMATCH')
    expect(
      () =>
        new SecureAcpDeviceEndpoint({
          route: fixture.route,
          identity: goodIdentity,
          encryption: { ...goodEncryption, publicKey: keys.otherRecipient.publicKey },
          executor,
        })
    ).toThrow('ACP_REMOTE_RECIPIENT_MISMATCH')
    expect(
      () =>
        new SecureAcpRemoteTransport({
          route: fixture.route,
          wire: fixture.wire,
          controller: { keyId: fixture.route.controllerKeyId, signingKey: keys.impostorSigning },
          grantState: () => 'granted',
          now: fixture.now,
        })
    ).toThrow('ACP_REMOTE_IDENTITY_MISMATCH')
  })
})

/** Produces sealed command bytes from a disposable producer without delivering them to the fixture under test. */
async function captureSealedCommand(overrides = {}) {
  const producer = await createSecureFixture()
  producer.wire.holdCommands()
  const pending = captured(producer.controller.dispatch(runtimeCommand(overrides)))
  await producer.wire.whenHeld(1)
  const message = structuredClone(
    producer.wire.log.find(({ direction }) => direction === 'command').message
  )
  await producer.wire.releaseHeld()
  await pending
  return message
}

describe('async authority races fail closed (parked regressions)', () => {
  test('revocation during key generation and sealing keeps the sealed command on the controller', async () => {
    const fixture = await createSecureFixture()
    const pending = captured(
      fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.first }))
    )
    // The dispatch is parked inside async key generation/sealing when revocation lands.
    fixture.controller.revoke('2026-08-25T12:00:10.000Z')

    expect(await pending).toMatchObject({
      error: { code: 'RUNTIME_NODE_REVOKED', retryable: false },
    })
    expect(fixture.wire.commandAttempts()).toBe(0)
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
  })

  test('an abort during sealing prevents the sealed command from leaving', async () => {
    const fixture = await createSecureFixture()
    const controller = new AbortController()
    const pending = captured(
      fixture.controller.dispatch(
        runtimeCommand({ commandId: commandIds.second }),
        controller.signal
      )
    )
    controller.abort()

    expect(await pending).toMatchObject({ error: { code: 'RUNTIME_GATEWAY_TIMEOUT' } })
    expect(fixture.wire.commandAttempts()).toBe(0)
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
  })

  test('revocation while an inventory request is in flight stops publication', async () => {
    const fixture = await createSecureFixture()
    const pending = captured(fixture.controller.inventory())
    fixture.controller.revoke('2026-08-25T12:00:10.000Z')

    expect(await pending).toMatchObject({ error: { code: 'RUNTIME_NODE_REVOKED' } })
  })

  test('revocation applied while a command is decrypting is fenced before the effect', async () => {
    const fixture = await createSecureFixture()
    const sealed = await captureSealedCommand({ commandId: commandIds.first })
    // Pre-warm the durable load so handleCommand parks inside HPKE decryption, not on load.
    await fixture.device.handleInventory('inv_0123456789abcdef0123456789abcdef')

    const pending = captured(fixture.device.handleCommand(sealed))
    await fixture.device.applyRevocation(fixture.controller.revoke('2026-08-25T12:00:10.000Z'))

    expect((await pending).value).toMatchObject({ kind: 'denial', reason: 'device_revoked' })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
  })

  test('revocation while inventory is being produced is fenced before the signed reply', async () => {
    const fixture = await createSecureFixture()
    // First inventory warms the durable load; the second parks inside executor inventory work.
    await fixture.device.handleInventory('inv_0123456789abcdef0123456789abcdef')
    const pending = captured(fixture.device.handleInventory('inv_fedcba9876543210fedcba9876543210'))
    await fixture.device.applyRevocation(fixture.controller.revoke('2026-08-25T12:00:10.000Z'))

    expect((await pending).value).toMatchObject({ kind: 'denial', reason: 'device_revoked' })
  })
})

describe('recorded outcomes stay gated by current authority', () => {
  test('a recorded command under a stale channel generation is denied, not re-sealed', async () => {
    const fixture = await createSecureFixture()
    await fixture.controller.dispatch(
      runtimeCommand({ commandId: commandIds.first, channelGeneration: 2 })
    )
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)

    await expect(
      fixture.controller.dispatch(
        runtimeCommand({ commandId: commandIds.first, channelGeneration: 1 })
      )
    ).rejects.toMatchObject({ code: 'RUNTIME_GATEWAY_STALE_CHANNEL', retryable: false })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })

  test('a recorded command whose sealed delivery window has expired is denied, not re-sealed', async () => {
    const fixture = await createSecureFixture()
    const sealed = await captureSealedCommand({ commandId: commandIds.third })

    const first = await fixture.device.handleCommand(structuredClone(sealed))
    expect(first).toMatchObject({ kind: 'exchange' })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)

    fixture.clock.current = new Date(Date.parse(NOW) + 61_000)
    const replay = await fixture.device.handleCommand(structuredClone(sealed))
    expect(replay).toMatchObject({ kind: 'denial', reason: 'command_expired' })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })

  test('same-identity recovery under a current window replays the recorded outcome without a second effect', async () => {
    const fixture = await createSecureFixture()
    await fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.fourth }))
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)

    // A later delivery with a fresh window but the same identity recovers the recorded outcome.
    fixture.clock.current = new Date('2026-08-25T12:05:10.000Z')
    const later = runtimeCommand({
      commandId: commandIds.fourth,
      issuedAt: '2026-08-25T12:05:00.000Z',
      expiresAt: '2026-08-25T12:06:00.000Z',
      sequence: 2,
    })
    await expect(fixture.controller.dispatch(later)).resolves.toMatchObject({
      ack: { disposition: 'accepted' },
    })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })
})

describe('edge fences: binding, executor failure, payload ceiling, state store', () => {
  const headerFor = (fixture, command) => ({
    suite: ACP_REMOTE_SUITE,
    workspaceId: ids.workspaceId,
    nodeId: ids.nodeId,
    runtimeConnectionId: ids.runtimeConnectionId,
    commandId: command.commandId,
    payloadHash: command.payloadHash,
    issuedAt: command.issuedAt,
    expiresAt: command.expiresAt,
    channelGeneration: command.channelGeneration,
    controllerKeyId: fixture.route.controllerKeyId,
    recipientKeyId: fixture.route.deviceEncryptionKeyId,
    returnKeyId: 'ret_000000000000000000000000000000f1',
    returnPublicKey: fixture.keys.otherRecipient.publicKey,
  })

  test('a correctly signed envelope whose ciphertext disagrees with its header is denied', async () => {
    const fixture = await createSecureFixture()
    const command = runtimeCommand({ commandId: commandIds.second })
    const header = { ...headerFor(fixture, command), payloadHash: `sha256:${'e'.repeat(64)}` }
    const message = await sealRawCommand({
      route: fixture.route,
      signingKey: fixture.keys.controllerSigning,
      header,
      plaintext: utf8(canonicalJson(command)),
    })

    const response = await fixture.device.handleCommand(message)
    expect(response).toMatchObject({ kind: 'denial', reason: 'binding_mismatch' })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
  })

  test('an executor failure is recorded once and replayed without re-running the effect', async () => {
    const store = new InMemoryAcpRemoteDeviceStateStore()
    let calls = 0
    const fixture = await createSecureFixture({
      stateStore: store,
      executor: {
        inventory: () => Promise.reject(new Error('INVENTORY_NOT_EXPECTED')),
        dispatch: () => {
          calls += 1
          return Promise.reject(new Error('EXECUTOR_DOWN'))
        },
      },
    })
    const sealed = await captureSealedCommand({ commandId: commandIds.first })

    const first = await fixture.device.handleCommand(structuredClone(sealed))
    expect(first).toMatchObject({ kind: 'denial', reason: 'executor_failed' })
    expect(calls).toBe(1)

    const second = await fixture.device.handleCommand(structuredClone(sealed))
    expect(second).toEqual(first)
    expect(calls).toBe(1)
    expect(await store.readLedger(commandIds.first)).toEqual({
      identity: expect.any(String),
      outcome: { kind: 'denial', reason: 'executor_failed' },
    })
  })

  test('an oversized command is refused at the controller before the wire and at the device before decryption', async () => {
    const fixture = await createSecureFixture()
    const oversized = runtimeCommand({
      commandId: commandIds.second,
      parameters: { action: 'list', padding: 'x'.repeat(1_100_000) },
    })
    await expect(fixture.controller.dispatch(oversized)).rejects.toMatchObject({
      code: 'RUNTIME_NODE_PAYLOAD_TOO_LARGE',
      retryable: false,
    })
    expect(fixture.wire.commandAttempts()).toBe(0)

    const command = runtimeCommand({ commandId: commandIds.third })
    const message = await sealRawCommand({
      route: fixture.route,
      signingKey: fixture.keys.controllerSigning,
      header: headerFor(fixture, command),
      plaintext: utf8(canonicalJson({ padding: 'y'.repeat(1_100_000) })),
    })
    const response = await fixture.device.handleCommand(message)
    expect(response).toMatchObject({ kind: 'denial', reason: 'payload_too_large' })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
  })

  test('a device state store failure fails closed as state_unavailable', async () => {
    const reject = () => Promise.reject(new Error('STORE_DOWN'))
    const brokenStore = {
      loadFence: reject,
      applyRevocation: reject,
      countLedger: reject,
      readLedger: reject,
      claim: reject,
      recordOutcome: reject,
    }
    const fixture = await createSecureFixture({ stateStore: brokenStore })

    const inventoryReply = await fixture.device.handleInventory(
      'inv_000000000000000000000000000000ab'
    )
    expect(inventoryReply).toMatchObject({ kind: 'denial', reason: 'state_unavailable' })

    const sealed = await captureSealedCommand({ commandId: commandIds.fourth })
    const response = await fixture.device.handleCommand(sealed)
    expect(response).toMatchObject({ kind: 'denial', reason: 'state_unavailable' })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
  })
})

/** Parks the next call of one state-store method so authority can change while the device awaits. */
function parkNextStoreCall(inner, method) {
  let release
  const barrier = new Promise((resolve) => {
    release = resolve
  })
  let announce
  const reached = new Promise((resolve) => {
    announce = resolve
  })
  let armed = true
  const store = {
    loadFence: (...args) => inner.loadFence(...args),
    applyRevocation: (...args) => inner.applyRevocation(...args),
    countLedger: (...args) => inner.countLedger(...args),
    readLedger: (...args) => inner.readLedger(...args),
    claim: (...args) => inner.claim(...args),
    recordOutcome: (...args) => inner.recordOutcome(...args),
  }
  store[method] = async (...args) => {
    if (armed) {
      armed = false
      announce()
      await barrier
    }
    return store[method] === undefined ? undefined : inner[method](...args)
  }
  return { store, reached, release }
}

describe('parked storage awaits re-check window and generation before every effect', () => {
  test('a command whose window expires while parked in the storage await never executes', async () => {
    const parking = parkNextStoreCall(new InMemoryAcpRemoteDeviceStateStore(), 'readLedger')
    const fixture = await createSecureFixture({ stateStore: parking.store })
    const pending = captured(
      fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.first }))
    )
    await parking.reached
    // The delivery window elapses while the device is parked inside its storage await.
    fixture.clock.current = new Date(Date.parse(NOW) + 61_000)
    parking.release()

    expect(await pending).toMatchObject({
      error: { code: 'RUNTIME_GATEWAY_COMMAND_EXPIRED', retryable: false },
    })
    expect(signedRefusals(fixture).at(-1).message.reason).toBe('command_expired')
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
  })

  test('a command superseded by a higher generation while parked in storage never executes', async () => {
    const inner = new InMemoryAcpRemoteDeviceStateStore()
    const parking = parkNextStoreCall(inner, 'readLedger')
    const fixture = await createSecureFixture({ stateStore: parking.store })
    const pending = captured(
      fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.first }))
    )
    await parking.reached
    // A newer channel generation is accepted through the durable fence while this delivery waits.
    expect(
      await inner.claim({
        commandId: commandIds.second,
        identity: 'concurrent-higher-generation',
        channelGeneration: 2,
        capacity: 1024,
      })
    ).toBe('claimed')
    parking.release()

    expect(await pending).toMatchObject({
      error: { code: 'RUNTIME_GATEWAY_STALE_CHANNEL', retryable: false },
    })
    expect(signedRefusals(fixture).at(-1).message.reason).toBe('stale_channel_generation')
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
  })
})

describe('revocation at execution, sealing, and response-opening boundaries', () => {
  test('revocation during execution records the effect once and publishes a denial', async () => {
    const fixture = await createSecureFixture()
    let releaseEffect
    const effectGate = new Promise((resolve) => {
      releaseEffect = resolve
    })
    let announceEffect
    const effectReached = new Promise((resolve) => {
      announceEffect = resolve
    })
    const originalDispatch = fixture.executor.dispatch.bind(fixture.executor)
    fixture.executor.dispatch = async (command) => {
      announceEffect()
      await effectGate
      return originalDispatch(command)
    }

    const pending = captured(
      fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.first }))
    )
    await effectReached
    await fixture.device.applyRevocation(fixture.controller.revoke('2026-08-25T12:00:10.000Z'))
    releaseEffect()

    expect(await pending).toMatchObject({
      error: { code: 'RUNTIME_NODE_REVOKED', retryable: false },
    })
    // The effect completed exactly once and its outcome stayed recorded as an exchange;
    // publication was fenced, and a redelivery replays without repeating the effect.
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
    expect(signedRefusals(fixture).at(-1).message.reason).toBe('device_revoked')
    const sealed = await captureSealedCommand({ commandId: commandIds.first })
    const replay = await fixture.device.handleCommand(sealed)
    expect(replay).toMatchObject({ kind: 'denial', reason: 'device_revoked' })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })

  test('revocation while the outcome is being recorded keeps the effect and refuses publication', async () => {
    const inner = new InMemoryAcpRemoteDeviceStateStore()
    const parking = parkNextStoreCall(inner, 'recordOutcome')
    const fixture = await createSecureFixture({ stateStore: parking.store })
    const pending = captured(
      fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.second }))
    )
    // The effect finished and the device is parked before its durable record lands.
    await parking.reached
    await fixture.device.applyRevocation(fixture.controller.revoke('2026-08-25T12:00:10.000Z'))
    parking.release()

    expect(await pending).toMatchObject({
      error: { code: 'RUNTIME_NODE_REVOKED', retryable: false },
    })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
    // The durable record keeps the real exchange outcome — revocation never rewrites it into a
    // denial, so a restart still knows the effect happened; the reply was fenced instead.
    const recorded = await inner.readLedger(commandIds.second)
    expect(recorded?.outcome).toMatchObject({ kind: 'exchange' })
    expect(signedRefusals(fixture).at(-1).message.reason).toBe('device_revoked')
    const sealed = await captureSealedCommand({ commandId: commandIds.second })
    const replay = await fixture.device.handleCommand(sealed)
    expect(replay).toMatchObject({ kind: 'denial', reason: 'device_revoked' })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })

  test('a recorded response is never re-sealed after revocation', async () => {
    const fixture = await createSecureFixture()
    const first = await fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.third }))
    expect(first.ack).toBeDefined()
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
    const sealed = structuredClone(
      fixture.wire.log.find(({ direction }) => direction === 'command').message
    )

    await fixture.device.applyRevocation(fixture.controller.revoke('2026-08-25T12:00:10.000Z'))
    const replay = await fixture.device.handleCommand(sealed)
    expect(replay).toMatchObject({ kind: 'denial', reason: 'device_revoked' })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })

  test('revocation while the reply is on the wire stops publication after the send await', async () => {
    const fixture = await createSecureFixture()
    fixture.wire.holdCommands()
    const pending = captured(
      fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.first }))
    )
    await fixture.wire.whenHeld(1)
    // Controller-local revocation only: the command already left before the revocation.
    fixture.controller.revoke('2026-08-25T12:00:10.000Z')
    await fixture.wire.releaseHeld()

    expect(await pending).toMatchObject({
      error: { code: 'RUNTIME_NODE_REVOKED', retryable: false },
    })
    expect(fixture.wire.commandAttempts()).toBe(1)
    // The device executed a command that was authorized when it was sent; the controller
    // re-fenced after the send await and never opened the reply for the caller.
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })

  test('revocation while the sealed reply is being opened stops the exchange at the controller', async () => {
    const fixture = await createSecureFixture()
    let revokeNow = () => {
      fixture.controller.revoke('2026-08-25T12:00:10.000Z')
    }
    // The reply parse reads the proxy properties synchronously after the post-send fence has
    // already passed, so revocation lands strictly between send and decrypt completion.
    fixture.wire.tamperNextResponse(
      (response) =>
        new Proxy(response, {
          get(target, property, receiver) {
            revokeNow()
            revokeNow = () => {}
            return Reflect.get(target, property, receiver)
          },
        })
    )
    const pending = captured(
      fixture.controller.dispatch(runtimeCommand({ commandId: commandIds.first }))
    )

    expect(await pending).toMatchObject({
      error: { code: 'RUNTIME_NODE_REVOKED', retryable: false },
    })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })

  describe('channel-authenticated pushed inventory (decided bounded-wait semantics)', () => {
    const channelWire = (inventory, channelGeneration = 7) => ({
      inventoryMode: 'channel-authenticated',
      currentChannelGeneration: () => channelGeneration,
      connectionState: () => 'online',
      sendCommand: async () => {
        throw new Error('SEND_NOT_EXPECTED')
      },
      requestInventory: async () => ({ inventory: await inventory(), channelGeneration }),
    })
    const controllerFor = (fixture, wire) =>
      new SecureAcpRemoteTransport({
        route: fixture.route,
        wire,
        controller: {
          keyId: fixture.route.controllerKeyId,
          signingKey: fixture.keys.controllerSigning,
        },
        grantState: () => 'granted',
        now: fixture.now,
      })

    test('accepts a channel-validated pushed inventory without a per-request device signature', async () => {
      const fixture = await createSecureFixture()
      const envelope = await fixture.controller.inventory()
      const controller = controllerFor(
        fixture,
        channelWire(() => envelope)
      )
      // No signature or request nonce is presented by the channel wire; binding and
      // freshness still apply and the inventory is returned unchanged.
      expect(await controller.inventory()).toEqual(envelope)
    })

    test('binding, freshness, and bounded-wait failures deny typed without polling', async () => {
      const fixture = await createSecureFixture()
      const envelope = await fixture.controller.inventory()

      const wrongNode = controllerFor(
        fixture,
        channelWire(() => ({ ...envelope, nodeId: 'rnr_01JBBCDEF0123456789ABCDEFG' }))
      )
      await expect(wrongNode.inventory()).rejects.toMatchObject({
        code: 'RUNTIME_NODE_RESPONSE_UNTRUSTED',
      })

      const stale = controllerFor(
        fixture,
        channelWire(() => ({ ...envelope, observedAt: '2026-08-25T11:58:00.000Z' }))
      )
      await expect(stale.inventory()).rejects.toMatchObject({
        code: 'RUNTIME_NODE_STALE',
        retryable: true,
      })

      const mismatched = controllerFor(fixture, {
        ...channelWire(() => envelope), // current generation 7
        requestInventory: async () => ({ inventory: envelope, channelGeneration: 6 }),
      })
      // The pushed inventory carries generation 6 while the authenticated channel's current
      // generation is 7 → stale.
      await expect(mismatched.inventory()).rejects.toMatchObject({
        code: 'RUNTIME_NODE_STALE',
        retryable: true,
      })
      const unbound = controllerFor(fixture, {
        ...channelWire(() => envelope),
        currentChannelGeneration: undefined,
        requestInventory: async () => ({ inventory: envelope }),
      })
      await expect(unbound.inventory()).rejects.toMatchObject({
        code: 'RUNTIME_NODE_STALE',
        retryable: true,
      })

      const timedOut = controllerFor(
        fixture,
        channelWire(() => {
          throw new Error('INVENTORY_WAIT_TIMEOUT')
        })
      )
      await expect(timedOut.inventory()).rejects.toMatchObject({
        code: 'RUNTIME_NODE_STALE',
        retryable: true,
      })
      expect(fixture.wire.inventoryAttempts()).toBe(1) // the signed fixture wire was never polled
    })
  })
})

describe('replay-ledger capacity admission is serialized with the claim', () => {
  const headerFor = (fixture, command) => ({
    suite: ACP_REMOTE_SUITE,
    workspaceId: ids.workspaceId,
    nodeId: ids.nodeId,
    runtimeConnectionId: ids.runtimeConnectionId,
    commandId: command.commandId,
    payloadHash: command.payloadHash,
    issuedAt: command.issuedAt,
    expiresAt: command.expiresAt,
    channelGeneration: command.channelGeneration,
    controllerKeyId: fixture.route.controllerKeyId,
    recipientKeyId: fixture.route.deviceEncryptionKeyId,
    returnKeyId: 'ret_000000000000000000000000000000f1',
    returnPublicKey: fixture.keys.otherRecipient.publicKey,
  })
  const sealFor = async (fixture, command) =>
    sealRawCommand({
      route: fixture.route,
      signingKey: fixture.keys.controllerSigning,
      header: headerFor(fixture, command),
      plaintext: utf8(canonicalJson(command)),
    })

  test('two distinct commands racing one capacity-1 ledger admit exactly one effect (in-memory)', async () => {
    const store = new InMemoryAcpRemoteDeviceStateStore()
    const fixture = await createSecureFixture({ stateStore: store, replayLedgerCapacity: 1 })
    // A SECOND endpoint over the same authenticated route scope and the same store: #inflight
    // cannot coalesce these — they are distinct commandIds on distinct endpoint instances.
    const peer = new SecureAcpDeviceEndpoint({
      route: fixture.route,
      identity: { keyId: fixture.route.deviceKeyId, signingKey: fixture.keys.deviceSigning },
      encryption: {
        keyId: fixture.route.deviceEncryptionKeyId,
        privateKey: fixture.keys.deviceRecipient.keyPair.privateKey,
        publicKey: fixture.keys.deviceRecipient.publicKey,
      },
      executor: fixture.executor,
      now: fixture.now,
      replayLedgerCapacity: 1,
      stateStore: store,
    })
    const [first, second] = await Promise.all([
      fixture.device.handleCommand(
        await sealFor(fixture, runtimeCommand({ commandId: commandIds.first }))
      ),
      peer.handleCommand(await sealFor(fixture, runtimeCommand({ commandId: commandIds.second }))),
    ])
    const results = [first, second]
    // Deterministic: exactly one command is admitted and executed; the other hits the bound
    // inside its own claim transaction — never a second effect or ledger entry.
    expect(results.filter((result) => result.kind === 'exchange')).toHaveLength(1)
    expect(
      results.filter((result) => result.kind === 'denial' && result.reason === 'replay_ledger_full')
    ).toHaveLength(1)
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
    expect(await store.countLedger()).toBe(1)

    // Capacity-1 ledger: the admitted command still replays from the record (no eviction),
    // and the refused command stays refused — neither path creates a second effect.
    const winner = results.find((result) => result.kind === 'exchange')
    expect(winner).toBeDefined()
    const winnerCommand =
      first.kind === 'exchange'
        ? runtimeCommand({ commandId: commandIds.first })
        : runtimeCommand({ commandId: commandIds.second })
    const replayed = await fixture.device.handleCommand(await sealFor(fixture, winnerCommand))
    expect(replayed).toMatchObject({ kind: 'exchange' })
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
    const loserCommand =
      first.kind === 'exchange'
        ? runtimeCommand({ commandId: commandIds.second })
        : runtimeCommand({ commandId: commandIds.first })
    const refusedAgain = await peer.handleCommand(await sealFor(fixture, loserCommand))
    expect(refusedAgain).toMatchObject({ kind: 'denial', reason: 'replay_ledger_full' })
    expect(await store.countLedger()).toBe(1)
  })
})

describe('cached publication is bound to the command identity', () => {
  test('a reused command id and return key with a different identity is a conflict, not the cached response', async () => {
    const fixture = await createSecureFixture()
    const original = runtimeCommand({ commandId: commandIds.first, parameters: { action: 'list' } })
    expect(
      await fixture.device.handleCommand(await sealCommandFor(fixture, original))
    ).toMatchObject({ kind: 'exchange' })

    const conflicting = runtimeCommand({
      commandId: commandIds.first,
      parameters: { action: 'list', afterSequence: 1 },
    })
    const response = await fixture.device.handleCommand(await sealCommandFor(fixture, conflicting))

    expect(response).toMatchObject({ kind: 'denial', reason: 'command_conflict' })
    expect(response.header.payloadHash).toBe(conflicting.payloadHash)
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })
})
