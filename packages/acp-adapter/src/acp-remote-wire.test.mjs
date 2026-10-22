import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import {
  createQueuedRuntimeCommandRecord,
  runtimeCommandRecordsShareIdentity,
} from '@control-plane/domain'
import { GatewayCommandEnvelopeSchema } from '@control-plane/runtime-gateway-protocol'
import {
  GRANT_REF,
  NOW,
  commandIds,
  createSecureFixture,
  ids,
  routeRecord,
  runtimeCommand,
} from './acp-remote-fixtures.mjs'
import { ReferenceAcpDriver, ReferenceAcpGatewayTransport } from './gateway.ts'
import { handleAcpRemoteCarrierCommand } from './acp-remote-device-agent.ts'
import {
  ACP_REMOTE_SEALED_PAYLOAD_KEY,
  readSealedCarrierPayload,
  readSealedHeaderProjection,
} from './acp-remote-sealed-frame.ts'
import { SecureAcpRemoteTransport } from './acp-remote-transport.ts'
import { ACP_REMOTE_SEALED_OPERATION, createGatewayOwnedAcpRemoteWire } from './acp-remote-wire.ts'

/**
 * The production controller wire, exercised end to end over a faithful carrier: the wire carries
 * the controller's opaque sealed command through a gateway channel that CANNOT read it, the device
 * agent answers it, and the sealed reply comes back as the carrier command's single per-command
 * result artifact.
 *
 * Everything here is synthetic and offline. No network device, no native session, no provider and
 * no credential is involved.
 */

const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Stable identifier factory: one identity maps to one opaque id, forever. */
const idFactory = (prefix) => {
  const assigned = new Map()
  let index = 0
  return (identity) => {
    const existing = assigned.get(identity)
    if (existing !== undefined) return existing
    let suffix = ''
    let value = index
    index += 1
    for (let position = 0; position < 26; position += 1) {
      suffix = ID_ALPHABET[value % 32] + suffix
      value = Math.floor(value / 32)
    }
    const id = `${prefix}_${suffix}`
    assigned.set(identity, id)
    return id
  }
}

const artifactStore = () => {
  const stored = new Map()
  return {
    stored,
    put: async ({ key, body, contentType, metadata }) => {
      const sha256 = createHash('sha256').update(body).digest('hex')
      const descriptor = {
        key,
        size: body.byteLength,
        contentType,
        sha256: `sha256:${sha256}`,
        metadata,
      }
      stored.set(key, { ...descriptor, body })
      return descriptor
    },
    read: (key) => {
      const entry = stored.get(key)
      if (entry === undefined) throw new Error('ARTIFACT_MISSING')
      return JSON.parse(new TextDecoder().decode(entry.body))
    },
  }
}

/** A gateway channel that relays the carrier without reading the sealed command it carries. */
const relayChannel = ({ device, artifacts, generation, inventory, onDispatch }) => ({
  currentChannelGeneration: () => generation(),
  pushedInventory: async () => inventory(),
  dispatchSealed: async ({ command }) => {
    onDispatch?.(command)
    // The gateway forwards the carrier payload; only the DEVICE reads the sealed command.
    const result = await handleAcpRemoteCarrierCommand(
      { device, artifacts: { put: artifacts.put } },
      command
    )
    void result
    return artifacts.read(`runtime-results/${command.attemptId}/result.json`)
  },
})

const countingFixture = async () => {
  const driver = new ReferenceAcpDriver({
    now: () => NOW,
    scenario: 'complete',
    nativeSessions: [{ sessionId: 'native-session-1', title: 'Secure session' }],
    sessionReplay: true,
  })
  driver.setGrantState(GRANT_REF, 'granted')
  const base = new ReferenceAcpGatewayTransport({
    driver,
    now: () => NOW,
    nodeId: ids.nodeId,
    workspaceId: ids.workspaceId,
    runtimeConnectionId: ids.runtimeConnectionId,
    runtimeOpaqueRef: ids.runtimeOpaqueRef,
  })
  let dispatches = 0
  const fixture = await createSecureFixture({
    executor: {
      dispatch: async (input) => {
        dispatches += 1
        return base.dispatch(input)
      },
      inventory: async (input) => base.inventory(input),
    },
  })
  return { ...fixture, dispatches: () => dispatches }
}

const wireFor = ({ route, channel, now = () => new Date(NOW) }) =>
  createGatewayOwnedAcpRemoteWire({
    channel,
    route,
    commandId: idFactory('cmd'),
    attemptId: idFactory('att'),
    executionId: ids.executionId,
    traceId: ids.traceId,
    now,
  })

const controllerFor = ({ route, wire, signingKey, now = () => new Date(NOW) }) =>
  new SecureAcpRemoteTransport({
    route,
    wire,
    controller: { keyId: route.controllerKeyId, signingKey },
    grantState: () => 'granted',
    now,
  })

test('carries an opaque sealed command through the gateway and returns the sealed reply', async () => {
  const fixture = await countingFixture()
  const artifacts = artifactStore()
  const carriers = []
  const wire = wireFor({
    route: fixture.route,
    channel: relayChannel({
      device: fixture.device,
      artifacts,
      generation: () => 1,
      inventory: async () => ({ inventory: {}, channelGeneration: 1 }),
      onDispatch: (command) => carriers.push(command),
    }),
  })
  const controller = controllerFor({
    route: fixture.route,
    wire,
    signingKey: fixture.keys.controllerSigning,
  })

  const exchange = await controller.dispatch(runtimeCommand({ commandId: commandIds.first }))
  expect(exchange.ack.disposition).toBe('accepted')
  expect(exchange.result?.status).toBe('succeeded')

  // The carrier carries exactly one opaque key: the gateway learns the route and the timing, and
  // never the command body.
  expect(carriers).toHaveLength(1)
  const carrier = GatewayCommandEnvelopeSchema.parse(carriers[0])
  expect(carrier.operation).toBe(ACP_REMOTE_SEALED_OPERATION)
  expect(carrier.family).toBe('runtime')
  expect(Object.keys(carrier.payload.parameters)).toEqual([ACP_REMOTE_SEALED_PAYLOAD_KEY])
  expect(typeof carrier.payload.parameters[ACP_REMOTE_SEALED_PAYLOAD_KEY]).toBe('string')
  expect(JSON.stringify(carrier)).not.toContain('session.list')
  expect(JSON.stringify(carrier)).not.toContain('action')

  // The sealed command the device received is the one the controller sealed.
  const sealed = readSealedCarrierPayload(carrier.payload)
  const header = readSealedHeaderProjection(sealed)
  expect(header.commandId).toBe(commandIds.first)
  expect(header.nodeId).toBe(ids.nodeId)
  expect(fixture.dispatches()).toBe(1)
})

test('the reply travels as the carrier attempt single per-command result artifact', async () => {
  const fixture = await countingFixture()
  const artifacts = artifactStore()
  const carriers = []
  const wire = wireFor({
    route: fixture.route,
    channel: relayChannel({
      device: fixture.device,
      artifacts,
      generation: () => 1,
      inventory: async () => ({ inventory: {}, channelGeneration: 1 }),
      onDispatch: (command) => carriers.push(command),
    }),
  })
  const controller = controllerFor({
    route: fixture.route,
    wire,
    signingKey: fixture.keys.controllerSigning,
  })
  await controller.dispatch(runtimeCommand({ commandId: commandIds.first }))
  const carrier = carriers[0]
  const key = `runtime-results/${carrier.attemptId}/result.json`
  expect(artifacts.stored.has(key)).toBe(true)
  expect(artifacts.stored.get(key).metadata).toEqual({ attempt: carrier.attemptId })
  expect(artifacts.stored.get(key).contentType).toBe('application/json')
  expect(artifacts.stored.size).toBe(1)
})

test('a retried command keeps one carrier identity so the relay deduplicates it', async () => {
  const fixture = await countingFixture()
  const artifacts = artifactStore()
  const carriers = []
  const wire = wireFor({
    route: fixture.route,
    channel: relayChannel({
      device: fixture.device,
      artifacts,
      generation: () => 1,
      inventory: async () => ({ inventory: {}, channelGeneration: 1 }),
      onDispatch: (command) => carriers.push(command),
    }),
  })
  const controller = controllerFor({
    route: fixture.route,
    wire,
    signingKey: fixture.keys.controllerSigning,
  })
  const command = runtimeCommand({ commandId: commandIds.first })
  await controller.dispatch(command)
  await controller.dispatch(command)

  // Same inner command -> same carrier identity. A relay that already delivered that identity
  // must not deliver it twice, and the device's replay ledger returns the recorded outcome.
  expect(carriers).toHaveLength(2)
  expect(carriers[0].commandId).toBe(carriers[1].commandId)
  expect(carriers[0].attemptId).toBe(carriers[1].attemptId)
  expect(carriers[0].idempotencyKey).toBe(carriers[1].idempotencyKey)

  // The carrier is the gateway's command identity, and the gateway's durable command
  // repository compares the FULL envelope. A retry that rebuilt the carrier -- a new
  // sequence, new timestamps, a newly sealed payload -- would be recorded as a DIFFERENT
  // command and refused as a payload mismatch, so the retry has to carry the same envelope.
  expect(carriers[0].sequence).toBe(carriers[1].sequence)
  expect(carriers[0].issuedAt).toBe(carriers[1].issuedAt)
  expect(carriers[0].expiresAt).toBe(carriers[1].expiresAt)
  expect(carriers[0].payloadHash).toBe(carriers[1].payloadHash)
  expect(carriers[0]).toEqual(carriers[1])

  // The inner effect is NOT repeated: the device's replay ledger answers the retry from
  // its recorded outcome, so the executor ran once for the two deliveries.
  expect(fixture.dispatches()).toBe(1)

  // The return-key binding is NOT weakened: the reply the retry opened is sealed to the
  // return key of the command, and the controller opened it with that key.
  expect(carriers[0].payload.parameters).toEqual(carriers[1].payload.parameters)

  // The retried carrier is ONE command to the gateway's durable command identity rule,
  // which is the rule the real repository enforces.
  const first = createQueuedRuntimeCommandRecord(carriers[0], NOW)
  const second = createQueuedRuntimeCommandRecord(carriers[1], NOW)
  expect(runtimeCommandRecordsShareIdentity(first, second)).toBe(true)
})

test('a still-valid command keeps its seal when a later command is dispatched', async () => {
  // The seal cache evicts CLOSED commands. Dispatching A, then B with a later expiry, must not
  // evict A while A is still live: the retry of A would be resealed into a different carrier,
  // which the durable command repository refuses as a different command.
  const fixture = await countingFixture()
  const artifacts = artifactStore()
  const carriers = []
  const wire = wireFor({
    route: fixture.route,
    channel: relayChannel({
      device: fixture.device,
      artifacts,
      generation: () => 1,
      inventory: async () => ({ inventory: {}, channelGeneration: 1 }),
      onDispatch: (command) => carriers.push(command),
    }),
  })
  const controller = controllerFor({
    route: fixture.route,
    wire,
    signingKey: fixture.keys.controllerSigning,
  })

  const first = runtimeCommand({ commandId: commandIds.first })
  const second = runtimeCommand({ commandId: commandIds.second })
  await controller.dispatch(first)
  await controller.dispatch(second)
  // The retry of the FIRST command reuses its carrier: the same durable identity and the
  // same envelope, so the gateway records it as one command.
  await controller.dispatch(first)

  const firstCarriers = carriers.filter((carrier) => carrier.commandId === carriers[0].commandId)
  expect(firstCarriers).toHaveLength(2)
  expect(firstCarriers[0]).toEqual(firstCarriers[1])
  expect(
    runtimeCommandRecordsShareIdentity(
      createQueuedRuntimeCommandRecord(firstCarriers[0], NOW),
      createQueuedRuntimeCommandRecord(firstCarriers[1], NOW)
    )
  ).toBe(true)
})

test('concurrent identical dispatches seal once and carry one carrier', async () => {
  // Two concurrent dispatches of the same command must not both miss the seal cache and seal
  // it twice: two seals of one command are two different carriers, and the durable command
  // repository refuses the second as a different command.
  const fixture = await countingFixture()
  const artifacts = artifactStore()
  const carriers = []
  const wire = wireFor({
    route: fixture.route,
    channel: relayChannel({
      device: fixture.device,
      artifacts,
      generation: () => 1,
      inventory: async () => ({ inventory: {}, channelGeneration: 1 }),
      onDispatch: (command) => carriers.push(command),
    }),
  })
  const controller = controllerFor({
    route: fixture.route,
    wire,
    signingKey: fixture.keys.controllerSigning,
  })

  const command = runtimeCommand({ commandId: commandIds.first })
  const [first, second] = await Promise.all([
    controller.dispatch(command),
    controller.dispatch(command),
  ])
  expect(first.ack.disposition).toBe('accepted')
  expect(second.ack.disposition).toBe('accepted')
  // The concurrent duplicates converged on ONE carrier: both attempts present the same
  // durable identity and the same envelope, so the gateway records one command.
  expect(carriers).toHaveLength(2)
  expect(carriers[0]).toEqual(carriers[1])
  expect(
    runtimeCommandRecordsShareIdentity(
      createQueuedRuntimeCommandRecord(carriers[0], NOW),
      createQueuedRuntimeCommandRecord(carriers[1], NOW)
    )
  ).toBe(true)
  // ONE effect: the device's replay ledger answered the duplicate.
  expect(fixture.dispatches()).toBe(1)
})

test('an unreachable device is a typed offline denial and never a reroute', async () => {
  const fixture = await countingFixture()
  const wire = wireFor({
    route: fixture.route,
    channel: {
      currentChannelGeneration: () => undefined,
      pushedInventory: async () => ({ inventory: {}, channelGeneration: 1 }),
      dispatchSealed: async () => {
        throw new Error('CHANNEL_PRESENT')
      },
    },
  })
  const controller = controllerFor({
    route: fixture.route,
    wire,
    signingKey: fixture.keys.controllerSigning,
  })
  expect(wire.connectionState()).toBe('offline')
  await expect(controller.dispatch(runtimeCommand())).rejects.toMatchObject({
    code: 'RUNTIME_NODE_OFFLINE',
    details: { reason: 'device_offline', fallback: 'none' },
  })
  expect(fixture.dispatches()).toBe(0)
})

test('a dispatch error is an unknown outcome, never a proof of non-delivery', async () => {
  const fixture = await countingFixture()
  let generation = 1
  const wire = wireFor({
    route: fixture.route,
    channel: {
      currentChannelGeneration: () => generation,
      pushedInventory: async () => ({ inventory: {}, channelGeneration: 1 }),
      dispatchSealed: async () => {
        generation = undefined
        throw new Error('ACP_REMOTE_GATEWAY_CHANNEL_OFFLINE')
      },
    },
  })
  const controller = controllerFor({
    route: fixture.route,
    wire,
    signingKey: fixture.keys.controllerSigning,
  })
  // The dispatch failed and the channel is gone, but a failed dispatch does not
  // prove the command was never delivered: the write may have landed before the
  // channel went away. The caller must read an unknown outcome and retry the
  // SAME command identity, not an offline denial.
  await expect(controller.dispatch(runtimeCommand())).rejects.toMatchObject({
    code: 'RUNTIME_NODE_RESPONSE_UNKNOWN',
    details: { reason: 'response_unknown', fallback: 'none' },
  })
})

test('a command that executed before the channel disconnected is an unknown outcome', async () => {
  const fixture = await countingFixture()
  const artifacts = artifactStore()
  let generation = 1
  const wire = wireFor({
    route: fixture.route,
    channel: {
      currentChannelGeneration: () => generation,
      pushedInventory: async () => ({ inventory: {}, channelGeneration: 1 }),
      dispatchSealed: async ({ command }) => {
        // The command EXECUTED on the device...
        await handleAcpRemoteCarrierCommand(
          { device: fixture.device, artifacts: { put: artifacts.put } },
          command
        )
        // ...and only then did the channel disconnect.
        generation = undefined
        throw new Error('ACP_REMOTE_GATEWAY_CHANNEL_OFFLINE')
      },
    },
  })
  const controller = controllerFor({
    route: fixture.route,
    wire,
    signingKey: fixture.keys.controllerSigning,
  })
  await expect(controller.dispatch(runtimeCommand())).rejects.toMatchObject({
    code: 'RUNTIME_NODE_RESPONSE_UNKNOWN',
    details: { reason: 'response_unknown', fallback: 'none' },
  })
  // The effect ran: the device recorded the reply artifact for the carrier's
  // attempt, so the outcome is genuinely unknown rather than never delivered.
  expect(artifacts.stored.size).toBe(1)
})

test('a revoked route never reaches the relay', async () => {
  const fixture = await countingFixture()
  const revoked = await routeRecord({ status: 'revoked', revokedAt: NOW })
  let dispatched = 0
  const wire = wireFor({
    route: revoked,
    channel: {
      currentChannelGeneration: () => 1,
      pushedInventory: async () => ({ inventory: {}, channelGeneration: 1 }),
      dispatchSealed: async () => {
        dispatched += 1
        return {}
      },
    },
  })
  const controller = controllerFor({
    route: revoked,
    wire,
    signingKey: fixture.keys.controllerSigning,
  })
  await expect(controller.dispatch(runtimeCommand())).rejects.toMatchObject({
    code: 'RUNTIME_NODE_REVOKED',
    details: { reason: 'device_revoked', fallback: 'none' },
  })
  expect(dispatched).toBe(0)
})

test('the wire refuses a command sealed for another channel generation', async () => {
  const fixture = await countingFixture()
  let dispatched = 0
  const wire = wireFor({
    route: fixture.route,
    channel: {
      currentChannelGeneration: () => 2,
      pushedInventory: async () => ({ inventory: {}, channelGeneration: 2 }),
      dispatchSealed: async () => {
        dispatched += 1
        return {}
      },
    },
  })
  const controller = controllerFor({
    route: fixture.route,
    wire,
    signingKey: fixture.keys.controllerSigning,
  })
  // The inner command was sealed for channel generation 1 while the channel now holds 2. The
  // command is definitely NOT delivered, so the caller must not treat it as an unknown outcome.
  await expect(controller.dispatch(runtimeCommand())).rejects.toMatchObject({
    code: 'RUNTIME_NODE_OFFLINE',
    details: { reason: 'device_offline', fallback: 'none' },
  })
  expect(dispatched).toBe(0)
})

test('the wire refuses a command whose validity window has closed', async () => {
  const fixture = await countingFixture()
  const artifacts = artifactStore()
  let dispatched = 0
  const wire = wireFor({
    route: fixture.route,
    channel: relayChannel({
      device: fixture.device,
      artifacts,
      generation: () => 1,
      inventory: async () => ({ inventory: {}, channelGeneration: 1 }),
      onDispatch: () => {
        dispatched += 1
      },
    }),
    now: () => new Date(Date.parse(NOW) + 120_000),
  })
  const controller = controllerFor({
    route: fixture.route,
    wire,
    signingKey: fixture.keys.controllerSigning,
    now: () => new Date(Date.parse(NOW) + 120_000),
  })
  await expect(controller.dispatch(runtimeCommand())).rejects.toMatchObject({
    code: 'RUNTIME_GATEWAY_COMMAND_EXPIRED',
  })
  expect(dispatched).toBe(0)
  expect(fixture.dispatches()).toBe(0)
})

test('the device agent refuses a carrier that redirects the sealed command to another route', async () => {
  const fixture = await countingFixture()
  const artifacts = artifactStore()
  const carriers = []
  const wire = wireFor({
    route: fixture.route,
    channel: relayChannel({
      device: fixture.device,
      artifacts,
      generation: () => 1,
      inventory: async () => ({ inventory: {}, channelGeneration: 1 }),
      onDispatch: (command) => carriers.push(command),
    }),
  })
  const controller = controllerFor({
    route: fixture.route,
    wire,
    signingKey: fixture.keys.controllerSigning,
  })
  await controller.dispatch(runtimeCommand())
  const carrier = carriers[0]
  const redirected = { ...carrier, nodeId: 'rnr_01JZZZZZZ0123456789ABCDEFG' }
  await expect(
    handleAcpRemoteCarrierCommand(
      { device: fixture.device, artifacts: { put: artifacts.put } },
      redirected
    )
  ).rejects.toThrow('ACP_REMOTE_CARRIER_BINDING_MISMATCH')
  expect(fixture.dispatches()).toBe(1)
})

test('the device agent refuses a carrier for another operation', async () => {
  const fixture = await countingFixture()
  const artifacts = artifactStore()
  await expect(
    handleAcpRemoteCarrierCommand(
      { device: fixture.device, artifacts: { put: artifacts.put } },
      runtimeCommand()
    )
  ).rejects.toThrow('ACP_REMOTE_CARRIER_OPERATION_UNSUPPORTED')
})

test('a stale pushed inventory is denied instead of published', async () => {
  const fixture = await countingFixture()
  const wire = wireFor({
    route: fixture.route,
    channel: {
      currentChannelGeneration: () => 2,
      pushedInventory: async () => ({ inventory: {}, channelGeneration: 1 }),
      dispatchSealed: async () => ({}),
    },
  })
  const controller = controllerFor({
    route: fixture.route,
    wire,
    signingKey: fixture.keys.controllerSigning,
  })
  await expect(controller.inventory()).rejects.toMatchObject({
    code: 'RUNTIME_NODE_STALE',
    details: { reason: 'device_stale', fallback: 'none' },
  })
})
