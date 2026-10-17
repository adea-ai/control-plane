// Shared-provider proof for the secure ACP device route (#1023/#1040): two device endpoints over ONE
// scoped durable store on the real SQLite PersistenceProvider, the persistence the Local profile runs
// in production. Each endpoint loads persisted fence state once, so a peer endpoint's durable
// revocation or generation advance must still fence replay, publication, and inventory on the
// endpoint whose in-process mirror has not seen it.
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlitePersistenceProvider } from '../packages/sqlite-persistence/src/provider.ts'
import {
  PersistenceProviderAcpRemoteDeviceStateStore,
  acpRemoteDeviceStateScope,
} from '../packages/acp-adapter/src/acp-remote-device-state.ts'
import { SecureAcpDeviceEndpoint } from '../packages/acp-adapter/src/acp-remote-transport.ts'
import {
  ACP_REMOTE_SUITE,
  canonicalJson,
  utf8,
} from '../packages/acp-adapter/src/acp-remote-crypto.ts'
import {
  commandIds,
  createSecureFixture,
  ids,
  runtimeCommand,
  sealRawCommand,
} from '../packages/acp-adapter/src/acp-remote-fixtures.mjs'

const RUNTIME_SESSION = 'runtime.session'
const REVOKED_AT = '2026-08-25T12:00:10.000Z'
const RETURN_KEY_ID = 'ret_000000000000000000000000000000f1'
const INVENTORY_WARM = 'inv_0123456789abcdef0123456789abcdef'
const INVENTORY_LATER = 'inv_fedcba9876543210fedcba9876543210'

/** Seals a runtime command as the controller does for one delivery under a fixed return key. */
function sealFor(fixture, command) {
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
      returnKeyId: RETURN_KEY_ID,
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

/** Two endpoints over one SQLite provider file, both scoped to the same authenticated route. */
async function withSharedProvider(run, wrapStoreA = (store) => store) {
  const directory = await mkdtemp(join(tmpdir(), 'acp-shared-provider-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await provider.migrate()
    const fixture = await createSecureFixture()
    const scope = acpRemoteDeviceStateScope(fixture.route)
    const endpointA = endpointOver(
      fixture,
      wrapStoreA(new PersistenceProviderAcpRemoteDeviceStateStore(provider, scope))
    )
    const endpointB = endpointOver(
      fixture,
      new PersistenceProviderAcpRemoteDeviceStateStore(provider, scope)
    )
    await run({ fixture, endpointA, endpointB, provider })
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

describe('two endpoints over one shared SQLite provider fence each other', () => {
  test('a new command after a peer revocation is refused by the durable claim before any effect', async () => {
    await withSharedProvider(async ({ fixture, endpointA, endpointB }) => {
      expect(await endpointA.handleInventory(INVENTORY_WARM)).toMatchObject({ kind: 'inventory' })
      await endpointB.applyRevocation(fixture.controller.revoke(REVOKED_AT))

      const sealed = await sealFor(fixture, runtimeCommand({ commandId: commandIds.first }))
      expect(await endpointA.handleCommand(sealed)).toMatchObject({
        kind: 'denial',
        reason: 'device_revoked',
      })
      expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
    })
  })

  test('a peer revocation fences replay of a recorded command on the endpoint with a stale mirror', async () => {
    await withSharedProvider(async ({ fixture, endpointA, endpointB }) => {
      const sealed = await sealFor(fixture, runtimeCommand({ commandId: commandIds.first }))
      expect(await endpointA.handleCommand(sealed)).toMatchObject({ kind: 'exchange' })

      await endpointB.applyRevocation(fixture.controller.revoke(REVOKED_AT))
      expect(endpointA.isRevoked()).toBe(false)

      expect(await endpointA.handleCommand(sealed)).toMatchObject({
        kind: 'denial',
        reason: 'device_revoked',
      })
      expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
    })
  })

  test('a peer generation advance withholds replay of an older recorded command on the stale endpoint as unknown', async () => {
    await withSharedProvider(async ({ fixture, endpointA, endpointB }) => {
      const older = await sealFor(
        fixture,
        runtimeCommand({ commandId: commandIds.first, channelGeneration: 1 })
      )
      expect(await endpointA.handleCommand(older)).toMatchObject({ kind: 'exchange' })

      const newer = await sealFor(
        fixture,
        runtimeCommand({ commandId: commandIds.second, channelGeneration: 2 })
      )
      expect(await endpointB.handleCommand(newer)).toMatchObject({ kind: 'exchange' })

      // The older command ran, so its superseded redelivery is an unknown outcome, not a terminal
      // "nothing executed" stale refusal, and no output is released.
      expect(await endpointA.handleCommand(older)).toMatchObject({
        kind: 'denial',
        reason: 'response_unknown',
      })
      expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(2)
    })
  })

  test('a peer revocation landing during execution refuses publication and keeps the effect recorded once', async () => {
    await withSharedProvider(async ({ fixture, endpointA, endpointB }) => {
      const originalDispatch = fixture.executor.dispatch.bind(fixture.executor)
      fixture.executor.dispatch = async (command) => {
        const exchange = await originalDispatch(command)
        // The peer revokes durably while this endpoint's effect is in flight; its mirror stays active.
        await endpointB.applyRevocation(fixture.controller.revoke(REVOKED_AT))
        return exchange
      }
      const sealed = await sealFor(fixture, runtimeCommand({ commandId: commandIds.first }))

      expect(await endpointA.handleCommand(sealed)).toMatchObject({
        kind: 'denial',
        reason: 'device_revoked',
      })
      expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
      // The redelivery replays nothing and repeats no effect.
      expect(await endpointA.handleCommand(sealed)).toMatchObject({
        kind: 'denial',
        reason: 'device_revoked',
      })
      expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
    })
  })

  test('a peer revocation fences inventory on an endpoint that already loaded its mirror', async () => {
    await withSharedProvider(async ({ fixture, endpointA, endpointB }) => {
      expect(await endpointA.handleInventory(INVENTORY_WARM)).toMatchObject({ kind: 'inventory' })
      await endpointB.applyRevocation(fixture.controller.revoke(REVOKED_AT))

      expect(await endpointA.handleInventory(INVENTORY_LATER)).toMatchObject({
        kind: 'denial',
        reason: 'device_revoked',
      })
    })
  })

  test('a peer revocation landing while inventory is produced stops the signed reply', async () => {
    await withSharedProvider(async ({ fixture, endpointA, endpointB }) => {
      expect(await endpointA.handleInventory(INVENTORY_WARM)).toMatchObject({ kind: 'inventory' })
      const originalInventory = fixture.executor.inventory.bind(fixture.executor)
      fixture.executor.inventory = async () => {
        const envelope = await originalInventory()
        await endpointB.applyRevocation(fixture.controller.revoke(REVOKED_AT))
        return envelope
      }

      expect(await endpointA.handleInventory(INVENTORY_LATER)).toMatchObject({
        kind: 'denial',
        reason: 'device_revoked',
      })
    })
  })

  test('a cached publication fails closed as state_unavailable when the shared store is closed', async () => {
    await withSharedProvider(async ({ fixture, endpointA, provider }) => {
      const sealed = await sealFor(fixture, runtimeCommand({ commandId: commandIds.first }))
      expect(await endpointA.handleCommand(sealed)).toMatchObject({ kind: 'exchange' })

      provider.close()
      expect(await endpointA.handleCommand(sealed)).toMatchObject({
        kind: 'denial',
        reason: 'state_unavailable',
      })
      expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
    })
  })
})

/** A barrier a test opens by hand: `reached` settles when the parked call arrives, `release` frees it. */
function barrier() {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let announce
  const reached = new Promise((resolve) => {
    announce = resolve
  })
  return { gate, release, reached, announce }
}

/** Endpoint A's store: the first `claim` parks BEFORE reaching the shared store. */
function parkBeforeFirstClaim(inner, point) {
  let armed = true
  return {
    loadFence: (...args) => inner.loadFence(...args),
    applyRevocation: (...args) => inner.applyRevocation(...args),
    countLedger: (...args) => inner.countLedger(...args),
    readLedger: (...args) => inner.readLedger(...args),
    claim: async (...args) => {
      if (armed) {
        armed = false
        point.announce()
        await point.gate
      }
      return inner.claim(...args)
    },
    advanceGeneration: (...args) => inner.advanceGeneration(...args),
    recordOutcome: (...args) => inner.recordOutcome(...args),
    abandonClaim: (...args) => inner.abandonClaim(...args),
  }
}

/** Endpoint A's store: the first ledger read misses, then parks before the pipeline sees the miss. */
function parkAfterFirstLedgerMiss(inner, point) {
  let armed = true
  return {
    loadFence: (...args) => inner.loadFence(...args),
    applyRevocation: (...args) => inner.applyRevocation(...args),
    countLedger: (...args) => inner.countLedger(...args),
    readLedger: async (...args) => {
      const record = await inner.readLedger(...args)
      if (armed) {
        armed = false
        point.announce()
        await point.gate
      }
      return record
    },
    claim: (...args) => inner.claim(...args),
    advanceGeneration: (...args) => inner.advanceGeneration(...args),
    recordOutcome: (...args) => inner.recordOutcome(...args),
    abandonClaim: (...args) => inner.abandonClaim(...args),
  }
}

describe('a semantic command that another endpoint executed is never refused as "nothing ran"', () => {
  const sealGeneration = (fixture, commandId, channelGeneration) =>
    sealFor(fixture, runtimeCommand({ commandId, channelGeneration }))

  for (const [label, park] of [
    ['before its claim', parkBeforeFirstClaim],
    ['between its initial ledger miss and its current fence read', parkAfterFirstLedgerMiss],
  ]) {
    test(`endpoint A paused ${label} reports response_unknown after endpoint B ran the command`, async () => {
      const point = barrier()
      await withSharedProvider(
        async ({ fixture, endpointA, endpointB }) => {
          const generationOne = await sealGeneration(fixture, commandIds.first, 1)
          const generationTwo = await sealGeneration(fixture, commandIds.first, 2)
          const pending = endpointA.handleCommand(generationOne)
          await point.reached

          // The peer accepts the same semantic command at the newer generation and executes it.
          expect(await endpointB.handleCommand(generationTwo)).toMatchObject({ kind: 'exchange' })
          expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
          point.release()

          // A's fence now refuses generation 1, but the command DID execute: the controller must not be
          // told the terminal, non-retryable "nothing ran" stale refusal, and no output is released.
          expect(await pending).toMatchObject({ kind: 'denial', reason: 'response_unknown' })
          expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)

          // A distinct command that never executed still gets the plain refusal.
          const neverRan = await sealGeneration(fixture, commandIds.second, 1)
          expect(await endpointA.handleCommand(neverRan)).toMatchObject({
            kind: 'denial',
            reason: 'stale_channel_generation',
          })
          expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
        },
        (store) => park(store, point)
      )
    })

    test(`endpoint A paused ${label} reports outcome_uncertain while endpoint B's effect is still pending`, async () => {
      const point = barrier()
      const effect = barrier()
      await withSharedProvider(
        async ({ fixture, endpointA, endpointB }) => {
          const originalDispatch = fixture.executor.dispatch.bind(fixture.executor)
          fixture.executor.dispatch = async (command) => {
            effect.announce()
            await effect.gate
            return originalDispatch(command)
          }
          const generationOne = await sealGeneration(fixture, commandIds.first, 1)
          const generationTwo = await sealGeneration(fixture, commandIds.first, 2)
          const pending = endpointA.handleCommand(generationOne)
          await point.reached

          const peer = endpointB.handleCommand(generationTwo)
          await effect.reached
          point.release()

          // The peer's claim is durable but its effect has not finished: its outcome is unknown.
          expect(await pending).toMatchObject({ kind: 'denial', reason: 'outcome_uncertain' })
          effect.release()
          expect(await peer).toMatchObject({ kind: 'exchange' })
          expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
        },
        (store) => park(store, point)
      )
    })
  }
})
