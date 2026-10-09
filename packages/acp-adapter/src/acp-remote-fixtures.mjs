// Disposable, deterministic fixtures for the secure ACP device route. Every key is synthetic and
// derived from a fixed seed inside this test-only module; no production enrollment, device
// credential, or native subscription material is created or read here.
import { createPrivateKey } from 'node:crypto'
import { executionConstraintFixtures } from '@control-plane/domain'
import { RemoteRuntimeGatewayTransport } from '@control-plane/runtime-sdk'
import { AcpAdapter, AcpDriver } from './index.ts'
import { AcpGatewayClient, ReferenceAcpDriver, ReferenceAcpGatewayTransport } from './gateway.ts'
import { digest, gatewayIdempotencyKey } from './acp-gateway-protocol.ts'
import {
  canonicalJson,
  deriveRecipientKeyPair,
  hpkeSeal,
  signCanonical,
  signingPublicKeyOf,
  utf8,
} from './acp-remote-crypto.ts'
import { AcpRemoteDeviceRouteSchema } from './acp-remote-fence.ts'
import {
  ACP_REMOTE_DOMAIN,
  AcpRemoteUndeliveredError,
  SecureAcpDeviceEndpoint,
  SecureAcpRemoteTransport,
} from './acp-remote-transport.ts'
import {
  GatewayCommandEnvelopeSchema,
  GatewayProtocolManifest,
} from '@control-plane/runtime-gateway-protocol'

export const NOW = '2026-08-25T12:00:00.000Z'
export const VALID_UNTIL = '2026-08-25T13:00:00.000Z'
export const GRANT_REF = 'grant:project-0001'

export const ids = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  nodeId: 'rnr_01JABCDEF0123456789ABCDEFG',
  runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  traceId: 'trc_01JABCDEF0123456789ABCDEFG',
  runtimeOpaqueRef: 'nref_01JABCDEF0123456789ABCDEFG',
}

export const commandIds = {
  first: 'cmd_01JABCDEF0123456789ABCDEFG',
  second: 'cmd_01JBBCDEF0123456789ABCDEFG',
  third: 'cmd_01JDBCDEF0123456789ABCDEFG',
  fourth: 'cmd_01JEBCDEF0123456789ABCDEFG',
}

// PKCS#8 wrapper for a 32-byte Ed25519 seed (RFC 8410).
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export function signingKeyFromSeed(seedByte) {
  const seed = Buffer.alloc(32, seedByte)
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  })
}

let syntheticKeysPromise
/** Synthetic controller, device, impostor, and recipient keys. Fixed seeds keep runs deterministic. */
export function syntheticKeys() {
  syntheticKeysPromise ??= (async () => {
    const deviceRecipient = await deriveRecipientKeyPair(Buffer.alloc(32, 0x51))
    const otherRecipient = await deriveRecipientKeyPair(Buffer.alloc(32, 0x52))
    return {
      controllerSigning: signingKeyFromSeed(0x41),
      deviceSigning: signingKeyFromSeed(0x42),
      impostorSigning: signingKeyFromSeed(0x43),
      deviceRecipient,
      otherRecipient,
    }
  })()
  return syntheticKeysPromise
}

export async function routeRecord(overrides = {}) {
  const keys = await syntheticKeys()
  return AcpRemoteDeviceRouteSchema.parse({
    workspaceId: ids.workspaceId,
    nodeId: ids.nodeId,
    runtimeConnectionId: ids.runtimeConnectionId,
    location: 'local_device',
    deviceKeyId: 'dev_sig_0000000001',
    deviceSigningPublicKey: signingPublicKeyOf(keys.deviceSigning),
    deviceEncryptionKeyId: 'dev_hpke_0000000001',
    deviceEncryptionPublicKey: keys.deviceRecipient.publicKey,
    controllerKeyId: 'ctl_sig_0000000001',
    controllerSigningPublicKey: signingPublicKeyOf(keys.controllerSigning),
    status: 'active',
    validUntil: VALID_UNTIL,
    ...overrides,
  })
}

export function plan() {
  const digestOf = (character) => `sha256:${character.repeat(64)}`
  return {
    schemaVersion: 1,
    executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
    contentDigest: digestOf('a'),
    profile: {
      profileId: 'prf_01JABCDEF0123456789ABCDEFG',
      profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
      version: 3,
      revision: 2,
      schemaVersion: 1,
      contentDigest: digestOf('b'),
    },
    skills: [],
    contextPackage: {
      contextPackageId: 'ctx_01JABCDEF0123456789ABCDEFG',
      contentDigest: digestOf('d'),
      schemaVersion: 1,
      compilerVersion: '1.0.0',
    },
    runtimeRequirements: [
      { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
      { capability: 'execution.cancel', necessity: 'required', minimumSupport: 'supported' },
    ],
    constraints: globalThis.structuredClone(executionConstraintFixtures.write),
    policySnapshot: globalThis.structuredClone(executionConstraintFixtures.write.policySnapshot),
    outputContract: { contractRef: 'contract://execution-result/v1' },
  }
}

/** Wire double between controller and device. It records every message and can inject faults. */
export class DisposableAcpRemoteWire {
  log = []
  #device
  #online = true
  #holding = false
  #held = []
  #heldWaiters = []
  #dropResponses = 0
  #tamperResponse
  #tamperInventory
  #attempts = { command: 0, inventory: 0 }

  constructor(device) {
    this.#device = device
  }

  connectionState() {
    return this.#online ? 'online' : 'offline'
  }

  setOnline(online) {
    this.#online = online
  }

  holdCommands() {
    this.#holding = true
  }

  /** Resolves once at least `count` commands are held at the wire. */
  whenHeld(count) {
    if (this.#held.length >= count) return Promise.resolve()
    return new Promise((resolve) => this.#heldWaiters.push({ count, resolve }))
  }

  async releaseHeld() {
    this.#holding = false
    const held = this.#held
    this.#held = []
    await Promise.all(
      held.map(async ({ command, resolve, reject }) => {
        try {
          resolve(await this.#deliver(command))
        } catch (error) {
          reject(error)
        }
      })
    )
  }

  dropNextResponse() {
    this.#dropResponses += 1
  }

  tamperNextResponse(mutate) {
    this.#tamperResponse = mutate
  }

  tamperNextInventory(mutate) {
    this.#tamperInventory = mutate
  }

  /** Commands the controller tried to send, including ones the wire refused. */
  commandAttempts() {
    return this.#attempts.command
  }

  inventoryAttempts() {
    return this.#attempts.inventory
  }

  commandDeliveries() {
    return this.log.filter(({ direction }) => direction === 'command').length
  }

  inventoryRequests() {
    return this.log.filter(({ direction }) => direction === 'inventory-request').length
  }

  /** Re-sends an already observed command, as a retransmitting intermediary would. */
  resend(command) {
    return this.#deliver(structuredClone(command))
  }

  async sendCommand(command) {
    this.#attempts.command += 1
    if (!this.#online) throw new AcpRemoteUndeliveredError()
    this.log.push({ direction: 'command', message: structuredClone(command) })
    if (this.#holding) {
      return new Promise((resolve, reject) => {
        this.#held.push({ command: structuredClone(command), resolve, reject })
        for (const waiter of this.#heldWaiters.filter(({ count }) => this.#held.length >= count)) {
          waiter.resolve()
        }
        this.#heldWaiters = this.#heldWaiters.filter(({ count }) => this.#held.length < count)
      })
    }
    return this.#deliver(command)
  }

  async #deliver(command) {
    const response = await this.#device.handleCommand(structuredClone(command))
    this.log.push({ direction: 'response', message: structuredClone(response) })
    if (this.#dropResponses > 0) {
      this.#dropResponses -= 1
      throw new Error('WIRE_RESPONSE_LOST')
    }
    if (this.#tamperResponse !== undefined) {
      const mutate = this.#tamperResponse
      this.#tamperResponse = undefined
      return mutate(structuredClone(response))
    }
    return response
  }

  async requestInventory(requestId) {
    this.#attempts.inventory += 1
    if (!this.#online) throw new AcpRemoteUndeliveredError()
    this.log.push({ direction: 'inventory-request', message: {} })
    const response = await this.#device.handleInventory(requestId)
    this.log.push({ direction: 'inventory', message: structuredClone(response) })
    if (this.#tamperInventory !== undefined) {
      const mutate = this.#tamperInventory
      this.#tamperInventory = undefined
      return mutate(structuredClone(response))
    }
    return structuredClone(response)
  }

  /** Replays a previously observed signed inventory response. */
  replayInventory(response) {
    return structuredClone(response)
  }

  observedInventory() {
    return this.log.filter(({ direction }) => direction === 'inventory').at(-1)?.message
  }
}

/** A complete in-process secure route: controller, wire, device endpoint, and disposable executor. */
export async function createSecureFixture(options = {}) {
  const keys = await syntheticKeys()
  const clock = { current: new Date(options.now ?? NOW) }
  const now = () => new Date(clock.current)
  const route = await routeRecord(options.route ?? {})
  const driver = new ReferenceAcpDriver({
    now: () => clock.current.toISOString(),
    scenario: options.scenario ?? 'complete',
    nativeSessions: [{ sessionId: 'native-session-1', title: 'Secure session' }],
    sessionReplay: true,
  })
  driver.setGrantState(GRANT_REF, 'granted')
  const executor =
    options.executor ??
    new ReferenceAcpGatewayTransport({
      driver,
      // A lagging device clock produces correctly signed inventory that is older than the freshness bound.
      now: () => new Date(clock.current.getTime() - (options.deviceClockLagMs ?? 0)).toISOString(),
      nodeId: ids.nodeId,
      workspaceId: ids.workspaceId,
      runtimeConnectionId: ids.runtimeConnectionId,
      runtimeOpaqueRef: ids.runtimeOpaqueRef,
    })
  const device = new SecureAcpDeviceEndpoint({
    route,
    identity: { keyId: route.deviceKeyId, signingKey: keys.deviceSigning },
    encryption: {
      keyId: route.deviceEncryptionKeyId,
      privateKey: keys.deviceRecipient.keyPair.privateKey,
      publicKey: keys.deviceRecipient.publicKey,
    },
    executor,
    now,
    ...(options.replayLedgerCapacity === undefined
      ? {}
      : { replayLedgerCapacity: options.replayLedgerCapacity }),
    ...(options.stateStore === undefined ? {} : { stateStore: options.stateStore }),
  })
  const wire = new DisposableAcpRemoteWire(device)
  const controller = new SecureAcpRemoteTransport({
    route,
    wire,
    controller: { keyId: route.controllerKeyId, signingKey: keys.controllerSigning },
    grantState: () => 'granted',
    now,
  })
  const client = clientFor(controller, clock)
  const externalIds = new Map([
    ['nses_01JABCDEF0123456789ABCDEFG', 'ses_01JABCDEF0123456789ABCDEFG'],
  ])
  const adapter = new AcpAdapter({
    transport: new RemoteRuntimeGatewayTransport(
      new AcpDriver({
        transport: client,
        adapterVersion: '1.0.0',
        externalSessionId: (sessionRef) => externalIds.get(sessionRef),
        interactionId: () => 'int_01JABCDEF0123456789ABCDEFG',
        now: () => new Date(clock.current),
      })
    ),
  })
  return { keys, clock, route, driver, executor, device, wire, controller, client, adapter, now }
}

export function clientFor(transport, clock) {
  const commandIdentities = new Map()
  let commandIndex = 0
  return new AcpGatewayClient({
    transport,
    nodeId: ids.nodeId,
    workspaceId: ids.workspaceId,
    runtimeConnectionId: ids.runtimeConnectionId,
    executionId: ids.executionId,
    attemptId: ids.attemptId,
    traceId: ids.traceId,
    runtimeOpaqueRef: ids.runtimeOpaqueRef,
    localProjectGrantRef: GRANT_REF,
    now: () => new Date(clock.current),
    commandId: (identity) => {
      if (!commandIdentities.has(identity)) {
        const suffix = '01JABCDEF0123456789ABCDEFGHJKMNPQ'.slice(commandIndex, commandIndex + 26)
        commandIdentities.set(identity, `cmd_${suffix.padEnd(26, 'A')}`)
        commandIndex += 1
      }
      return commandIdentities.get(identity)
    },
  })
}

/** Builds a runtime command envelope directly, for controller-level and replay scenarios. */
export function runtimeCommand(overrides = {}) {
  const issuedAt = overrides.issuedAt ?? NOW
  const expiresAt = overrides.expiresAt ?? new Date(Date.parse(issuedAt) + 60_000).toISOString()
  const parameters = overrides.parameters ?? { action: 'list' }
  const payload = { version: 1, parameters }
  const identity = `${overrides.commandId ?? commandIds.first}:${JSON.stringify(parameters)}`
  return GatewayCommandEnvelopeSchema.parse({
    type: 'command',
    schemaVersion: 1,
    protocolVersion: GatewayProtocolManifest.current,
    sequence: overrides.sequence ?? 1,
    nodeId: ids.nodeId,
    workspaceId: ids.workspaceId,
    traceId: ids.traceId,
    sentAt: issuedAt,
    channelGeneration: overrides.channelGeneration ?? 1,
    commandId: overrides.commandId ?? commandIds.first,
    idempotencyKey: gatewayIdempotencyKey(identity),
    payloadHash: digest(payload),
    issuedAt,
    expiresAt,
    family: 'runtime',
    operation: 'runtime.session',
    driver: { family: 'acp', version: '1.0.0' },
    runtimeConnectionId: ids.runtimeConnectionId,
    executionId: ids.executionId,
    attemptId: ids.attemptId,
    requiredCapabilities: ['session.list'],
    payload,
  })
}

/**
 * Seals an arbitrary header and plaintext exactly as the controller would, under the given signing key.
 * Used only to prove the device refuses envelopes whose cleartext header disagrees with the ciphertext.
 */
export async function sealRawCommand({ route, signingKey, header, plaintext }) {
  const sealed = await hpkeSeal({
    recipientPublicKey: route.deviceEncryptionPublicKey,
    info: ACP_REMOTE_DOMAIN.commandInfo,
    aad: utf8(canonicalJson({ domain: ACP_REMOTE_DOMAIN.commandAad, header })),
    plaintext,
  })
  const body = { header, encapsulatedKey: sealed.encapsulatedKey, ciphertext: sealed.ciphertext }
  return { ...body, signature: signCanonical(ACP_REMOTE_DOMAIN.commandSignature, body, signingKey) }
}
