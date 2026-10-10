// Response authorization boundary for the secure ACP device route. A device reply (exchange, cached
// replay, or signed denial) is authorized by the last durable fence read that completes before the
// endpoint returns its bytes. The pre-dispatch boundary applies the same rule to the executor: a
// durable read after a successful claim decides whether dispatch happens at all. Each ordering below
// is fixed by a read plan rather than by timing, so every case is deterministic.
import { describe, expect, test } from 'bun:test'
import { ACP_REMOTE_SUITE, canonicalJson, utf8 } from './acp-remote-crypto.ts'
import { InMemoryAcpRemoteDeviceStateStore } from './acp-remote-device-state.ts'
import { SecureAcpDeviceEndpoint } from './acp-remote-transport.ts'
import {
  commandIds,
  createSecureFixture,
  ids,
  runtimeCommand,
  sealRawCommand,
} from './acp-remote-fixtures.mjs'

const RUNTIME_SESSION = 'runtime.session'
const RETURN_KEY_ID = 'ret_000000000000000000000000000000f1'
const RETRY_RETURN_KEY_ID = 'ret_000000000000000000000000000000f2'
const REVOKED_AT = '2026-08-25T12:00:10.000Z'
const INVENTORY_WARM = 'inv_0123456789abcdef0123456789abcdef'

/** Seals a runtime command as the controller does for one delivery under the given return key. */
function sealFor(fixture, command, returnKeyId = RETURN_KEY_ID) {
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
      returnKeyId,
      returnPublicKey: fixture.keys.otherRecipient.publicKey,
    },
    plaintext: utf8(canonicalJson(command)),
  })
}

/** A device endpoint over the fixture's keys and executor, persisting its fence state to `stateStore`. */
function endpointOver(fixture, stateStore) {
  return new SecureAcpDeviceEndpoint({
    route: fixture.route,
    identity: { keyId: fixture.route.deviceKeyId, signingKey: fixture.keys.deviceSigning },
    encryption: {
      keyId: fixture.route.deviceEncryptionKeyId,
      privateKey: fixture.keys.deviceRecipient.keyPair.privateKey,
      publicKey: fixture.keys.deviceRecipient.publicKey,
    },
    executor: fixture.executor,
    now: fixture.now,
    stateStore,
  })
}

/**
 * One durable store whose fence reads follow a plan. Each read consumes the next step: `before`
 * runs and is awaited ahead of the read, and `after` runs once the read's snapshot is taken. A peer
 * commit placed either way fixes its position relative to the endpoint's reads, and reads are counted
 * so each case also proves the ordering it relies on.
 */
function plannedStore() {
  const inner = new InMemoryAcpRemoteDeviceStateStore()
  let steps = []
  let reads = 0
  return {
    inner,
    store: {
      async loadFence() {
        reads += 1
        const step = steps.shift() ?? {}
        if (step.before !== undefined) await step.before()
        const fence = await inner.loadFence()
        step.after?.()
        return fence
      },
      applyRevocation: (revokedAt) => inner.applyRevocation(revokedAt),
      countLedger: () => inner.countLedger(),
      readLedger: (commandId) => inner.readLedger(commandId),
      claim: (input) => inner.claim(input),
      recordOutcome: (commandId, outcome) => inner.recordOutcome(commandId, outcome),
    },
    /** Starts the plan for the next delivery and restarts the read count. */
    plan(...next) {
      steps = [...next]
      reads = 0
    },
    readCount: () => reads,
    unconsumed: () => steps.length,
  }
}

/** The endpoint under test over the planned store, and a peer endpoint over the same durable store. */
async function boundaryRoute() {
  const planned = plannedStore()
  const fixture = await createSecureFixture()
  const device = endpointOver(fixture, planned.store)
  // The peer commits to the durable store directly; its commits are not planned reads.
  const peer = endpointOver(fixture, planned.inner)
  // The first contact loads the fence once, so every plan below starts after that load.
  await device.handleInventory(INVENTORY_WARM)
  return { fixture, planned, device, peer }
}

/** Records each executor dispatch, so a physical effect is observable at the executor boundary. */
function recordDispatches(fixture) {
  const dispatched = []
  const dispatch = fixture.executor.dispatch.bind(fixture.executor)
  fixture.executor.dispatch = (command) => {
    dispatched.push(command.commandId)
    return dispatch(command)
  }
  return dispatched
}

describe('response authorization boundary: the last durable read before bytes return', () => {
  test('a peer revocation committed after sealing and before the final read refuses the sealed reply', async () => {
    const { fixture, planned, device, peer } = await boundaryRoute()
    const sealed = await sealFor(fixture, runtimeCommand({ commandId: commandIds.first }))
    // A fresh delivery reads the fence four times: claim check, pre-dispatch check, pre-publication
    // check, final check. The commit lands just before the final check.
    planned.plan(
      {},
      {},
      {},
      { before: () => peer.applyRevocation(fixture.controller.revoke(REVOKED_AT)) }
    )

    expect(await device.handleCommand(sealed)).toMatchObject({
      kind: 'denial',
      reason: 'device_revoked',
    })
    expect(planned.readCount()).toBe(4)
    expect(planned.unconsumed()).toBe(0)
    // The effect ran once and its outcome stayed recorded; only publication was refused.
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
    expect(await planned.inner.readLedger(commandIds.first)).toMatchObject({
      outcome: { kind: 'exchange' },
    })
  })

  test('a peer revocation committed while the reply is being sealed refuses the reply', async () => {
    const { fixture, planned, device, peer } = await boundaryRoute()
    const sealed = await sealFor(fixture, runtimeCommand({ commandId: commandIds.first }))
    let revocation
    // Committed right after the pre-publication read, so it lands inside the sealing window; the
    // final read waits for that commit before it takes its snapshot.
    planned.plan(
      {},
      {},
      {
        after: () => {
          revocation = peer.applyRevocation(fixture.controller.revoke(REVOKED_AT))
        },
      },
      { before: () => revocation }
    )

    expect(await device.handleCommand(sealed)).toMatchObject({
      kind: 'denial',
      reason: 'device_revoked',
    })
    expect(planned.readCount()).toBe(4)
    expect(planned.unconsumed()).toBe(0)
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })

  test('a cached reply is not served after a peer revocation committed before the replay final read', async () => {
    const { fixture, planned, device, peer } = await boundaryRoute()
    const sealed = await sealFor(fixture, runtimeCommand({ commandId: commandIds.first }))
    const cached = await device.handleCommand(sealed)
    expect(cached).toMatchObject({ kind: 'exchange' })

    let revocation
    // A replay reads twice: the ledger-path claim check, then the pre-publication check that guards
    // the cache. The commit lands between them, so the cached bytes must not be returned.
    planned.plan(
      {
        after: () => {
          revocation = peer.applyRevocation(fixture.controller.revoke(REVOKED_AT))
        },
      },
      { before: () => revocation }
    )

    const replay = await device.handleCommand(sealed)
    expect(replay).toMatchObject({ kind: 'denial', reason: 'device_revoked' })
    expect(replay).not.toBe(cached)
    expect(planned.readCount()).toBe(2)
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })

  test('without a peer revocation a replay returns the cached reply object itself after two durable reads', async () => {
    const { fixture, planned, device } = await boundaryRoute()
    const sealed = await sealFor(fixture, runtimeCommand({ commandId: commandIds.first }))
    const cached = await device.handleCommand(sealed)

    planned.plan()
    expect(await device.handleCommand(sealed)).toBe(cached)
    expect(planned.readCount()).toBe(2)
  })

  test('a reused command id with a different identity is a command_conflict, never the cached reply', async () => {
    const { fixture, device } = await boundaryRoute()
    const original = runtimeCommand({ commandId: commandIds.first, parameters: { action: 'list' } })
    const cached = await device.handleCommand(await sealFor(fixture, original))
    expect(cached).toMatchObject({ kind: 'exchange' })

    const conflicting = runtimeCommand({
      commandId: commandIds.first,
      parameters: { action: 'list', afterSequence: 1 },
    })
    const conflict = await device.handleCommand(await sealFor(fixture, conflicting))
    expect(conflict).toMatchObject({ kind: 'denial', reason: 'command_conflict' })
    expect(conflict.header.payloadHash).toBe(conflicting.payloadHash)
    expect(conflict).not.toBe(cached)

    // The original identity still replays its recorded exchange, not the conflict.
    const replay = await device.handleCommand(await sealFor(fixture, original))
    expect(replay).toMatchObject({ kind: 'exchange' })
    expect(replay.header.payloadHash).toBe(original.payloadHash)
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
  })
})

describe('pre-dispatch boundary: the last durable read before the executor is called', () => {
  test('a peer revocation committed after the claim and before the pre-dispatch read dispatches nothing', async () => {
    const { fixture, planned, device, peer } = await boundaryRoute()
    const dispatched = recordDispatches(fixture)
    const sealed = await sealFor(fixture, runtimeCommand({ commandId: commandIds.first }))
    // Reads: the claim check, then the pre-dispatch check, which runs after the claim has committed.
    planned.plan({}, { before: () => peer.applyRevocation(fixture.controller.revoke(REVOKED_AT)) })

    expect(await device.handleCommand(sealed)).toMatchObject({
      kind: 'denial',
      reason: 'device_revoked',
    })
    expect(dispatched).toEqual([])
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
    expect(planned.readCount()).toBe(3)
    expect(planned.unconsumed()).toBe(0)
    // The claim stays recorded, now as the denial the pre-dispatch read observed.
    expect(await planned.inner.readLedger(commandIds.first)).toMatchObject({
      outcome: { kind: 'denial', reason: 'device_revoked' },
    })
  })

  test('without a peer revocation the claimed command dispatches once, after the pre-dispatch read', async () => {
    const { fixture, planned, device } = await boundaryRoute()
    const dispatched = recordDispatches(fixture)
    const sealed = await sealFor(fixture, runtimeCommand({ commandId: commandIds.first }))

    planned.plan()
    expect(await device.handleCommand(sealed)).toMatchObject({ kind: 'exchange' })
    expect(dispatched).toEqual([commandIds.first])
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
    // Reads: claim check, pre-dispatch check, pre-publication check, final check.
    expect(planned.readCount()).toBe(4)
  })

  test('a store failure at the pre-dispatch read dispatches nothing and leaves the claim unrecorded', async () => {
    const { fixture, planned, device } = await boundaryRoute()
    const dispatched = recordDispatches(fixture)
    const sealed = await sealFor(fixture, runtimeCommand({ commandId: commandIds.first }))
    planned.plan({}, { before: () => Promise.reject(new Error('STORE_UNAVAILABLE')) })

    expect(await device.handleCommand(sealed)).toMatchObject({
      kind: 'denial',
      reason: 'state_unavailable',
    })
    expect(dispatched).toEqual([])
    expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
    expect((await planned.inner.readLedger(commandIds.first))?.outcome).toBeUndefined()

    // A later delivery of the same identity, under a new return key, reads the claim as uncertain.
    const retry = await device.handleCommand(
      await sealFor(fixture, runtimeCommand({ commandId: commandIds.first }), RETRY_RETURN_KEY_ID)
    )
    expect(retry).toMatchObject({ kind: 'denial', reason: 'outcome_uncertain' })
    expect(dispatched).toEqual([])
  })
})
