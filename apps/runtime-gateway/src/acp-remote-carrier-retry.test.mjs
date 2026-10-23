import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AcpRemoteDeviceRouteSchema,
  SecureAcpDeviceEndpoint,
  SecureAcpRemoteTransport,
  createGatewayOwnedAcpRemoteWire,
  generateRecipientKeyPair,
  generateSigningKeyPair,
  handleAcpRemoteCarrierCommand,
} from '@control-plane/acp-adapter'
import { GatewayProtocolManifest } from '@control-plane/runtime-gateway-protocol'
import {
  SqlitePersistenceProvider,
  SqliteRuntimeCommandRepository,
  createRuntimeNodeCredentialFenceValidator,
} from '@control-plane/sqlite-persistence'
import { createAcpRemoteGatewayChannel } from './acp-remote-gateway-channel.ts'
import { RuntimeCommandDeliveryService } from './runtime-command-delivery.ts'
import { RuntimeCommandArtifactVerifier } from './runtime-artifact-verifier.ts'

/**
 * The integrated ACP remote retry path (#1238).
 *
 * The real controller transport, the real wire, the real gateway channel, the real delivery
 * service, the real durable command repository, the real device endpoint, the real reply
 * artifact and the real artifact verifier all take part, so the retry is proved end to end
 * rather than against a double. The durable repository is the real SQLite one, because the
 * full-envelope command identity it enforces is the property under test.
 *
 * The scenario exercises a valid sealed-command retry past the gateway's old 60-second carrier
 * TTL: dispatch A, advance the clock 61 seconds, dispatch B (which triggers carrier eviction),
 * then retry the exact A envelope. The retry must reuse one durable carrier envelope and recover
 * the result without rerunning either device effect.
 */

const NOW = '2026-10-21T00:00:00.000Z'

const ids = {
  nodeId: 'rnr_01JABCDEF0123456789ABCDEFG',
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  traceId: 'trc_01JABCDEF0123456789ABCDEFG',
  commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
}

const IDENTITY = 'acp:0123456789abcdef0123456789abcdef0123456789abcdef'
const PAYLOAD = { version: 1, parameters: { action: 'list' } }
const CREDENTIAL_ID = 'crd_acp_remote_carrier_retry'
const CREDENTIAL_FENCE = { credentialId: CREDENTIAL_ID, revocationVersion: 1 }

/** One identity maps to one opaque id, forever: the gateway's durable command identity. */
const idFactory = (prefix) => {
  const assigned = new Map()
  let index = 0
  return (identity) => {
    const existing = assigned.get(identity)
    if (existing !== undefined) return existing
    const id = `${prefix}_${String(index).padStart(26, '0')}`
    index += 1
    assigned.set(identity, id)
    return id
  }
}

describe('the integrated ACP remote retry path', () => {
  test('an exact sealed-command retry past the carrier TTL keeps one durable carrier and effect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'acp-remote-carrier-retry-'))
    const provider = new SqlitePersistenceProvider({ path: join(directory, 'gateway.sqlite') })
    const clock = { now: new Date(NOW) }
    try {
      await provider.migrate()
      // The durable repository fences every ACK and result transition on the node credential
      // authority, so the test plants a live credential and validates the fence in the same
      // transaction, exactly as the production authority does.
      const authority = {
        async validateCredentialFenceInTransaction(transaction, fence, scope) {
          const record = await transaction.get(
            'fixture-runtime-node-credentials',
            fence.credentialId
          )
          return (
            record !== undefined &&
            record.value.revoked === false &&
            record.value.revocationVersion === fence.revocationVersion &&
            record.value.nodeId === scope.nodeId &&
            record.value.workspaceId === scope.workspaceId
          )
        },
      }
      const repository = new SqliteRuntimeCommandRepository(
        provider,
        createRuntimeNodeCredentialFenceValidator(authority)
      )
      await provider.transaction(async (transaction) => {
        await transaction.put({
          namespace: 'fixture-runtime-node-credentials',
          id: CREDENTIAL_ID,
          value: {
            revoked: false,
            revocationVersion: 1,
            nodeId: ids.nodeId,
            workspaceId: ids.workspaceId,
          },
        })
      })
      const controllerKeys = await generateSigningKeyPair()
      const deviceKeys = await generateSigningKeyPair()
      const deviceRecipient = await generateRecipientKeyPair()
      const route = AcpRemoteDeviceRouteSchema.parse({
        nodeId: ids.nodeId,
        workspaceId: ids.workspaceId,
        runtimeConnectionId: ids.runtimeConnectionId,
        location: 'local_device',
        deviceKeyId: 'dev_sig_0000000001',
        deviceSigningPublicKey: deviceKeys.publicKey,
        deviceEncryptionKeyId: 'dev_hpke_0000000001',
        deviceEncryptionPublicKey: deviceRecipient.publicKey,
        controllerKeyId: 'ctl_sig_0000000001',
        controllerSigningPublicKey: controllerKeys.publicKey,
        status: 'active',
        validUntil: '2026-10-21T13:00:00.000Z',
      })

      // The reply artifact store the device writes and the gateway reads and verifies.
      const artifacts = new Map()
      const artifactStore = {
        async put({ key, body, contentType, metadata }) {
          const sha256 = createHash('sha256').update(body).digest('hex')
          const descriptor = {
            key,
            size: body.byteLength,
            contentType,
            sha256: `sha256:${sha256}`,
            metadata: metadata ?? {},
          }
          artifacts.set(key, { ...descriptor, body })
          return descriptor
        },
        async get(key) {
          const stored = artifacts.get(key)
          if (stored === undefined) throw new Error('ARTIFACT_MISSING')
          return stored
        },
        async head(key) {
          const stored = artifacts.get(key)
          if (stored === undefined) throw new Error('ARTIFACT_MISSING')
          const { body: _body, ...descriptor } = stored
          return descriptor
        },
        async delete(key) {
          artifacts.delete(key)
        },
        close() {},
      }

      // The device side: the real endpoint, answering through the real carrier agent.
      let effects = 0
      const device = new SecureAcpDeviceEndpoint({
        route,
        identity: { keyId: route.deviceKeyId, signingKey: deviceKeys.privateKey },
        encryption: {
          keyId: route.deviceEncryptionKeyId,
          privateKey: deviceRecipient.keyPair.privateKey,
          publicKey: deviceRecipient.publicKey,
        },
        executor: {
          async dispatch(command) {
            effects += 1
            return {
              ack: {
                type: 'ack',
                schemaVersion: 1,
                protocolVersion: command.protocolVersion,
                sequence: command.sequence,
                nodeId: command.nodeId,
                workspaceId: command.workspaceId,
                traceId: command.traceId,
                sentAt: clock.now.toISOString(),
                channelGeneration: command.channelGeneration,
                commandId: command.commandId,
                payloadHash: command.payloadHash,
                disposition: 'accepted',
              },
              progress: [],
            }
          },
          async inventory() {
            return { inventory: {}, channelGeneration: 1 }
          },
        },
        now: () => new Date(clock.now),
      })

      // The gateway side: the real delivery service over the real durable repository. The
      // sender is the node: it hands the carrier to the device, and reports the
      // acknowledgement and the result back the way the gateway's message handler does.
      const delivery = new RuntimeCommandDeliveryService({
        repository,
        sender: {
          async send(envelope) {
            const result = await handleAcpRemoteCarrierCommand(
              { device, artifacts: { put: artifactStore.put } },
              envelope
            )
            await delivery.acknowledge(
              {
                type: 'ack',
                schemaVersion: 1,
                protocolVersion: GatewayProtocolManifest.current,
                sequence: envelope.sequence,
                nodeId: ids.nodeId,
                workspaceId: ids.workspaceId,
                traceId: ids.traceId,
                sentAt: clock.now.toISOString(),
                channelGeneration: envelope.channelGeneration,
                commandId: envelope.commandId,
                payloadHash: envelope.payloadHash,
                disposition: 'accepted',
              },
              CREDENTIAL_FENCE
            )
            await delivery.recordResult(
              {
                type: 'result',
                schemaVersion: 1,
                protocolVersion: GatewayProtocolManifest.current,
                sequence: envelope.sequence,
                nodeId: ids.nodeId,
                workspaceId: ids.workspaceId,
                traceId: ids.traceId,
                sentAt: clock.now.toISOString(),
                channelGeneration: envelope.channelGeneration,
                commandId: envelope.commandId,
                payloadHash: envelope.payloadHash,
                status: 'succeeded',
                completedAt: clock.now.toISOString(),
                result: { artifact: result.result.artifact },
              },
              result.result.artifact.artifactId,
              CREDENTIAL_FENCE
            )
          },
        },
        metrics: { observe() {}, increment() {} },
        now: () => new Date(clock.now),
      })

      // The gateway channel the controller's wire rides on. The carriers are captured so the
      // durable command the retry produced can be read back from the repository.
      const carriers = []
      let sequence = 0
      const channel = createAcpRemoteGatewayChannel({
        delivery: {
          enqueue: (command) => {
            carriers.push(command)
            return delivery.enqueue(command)
          },
          deliver: (commandId, transport) => delivery.deliver(commandId, transport),
          get: (commandId) => delivery.get(commandId),
        },
        node: {
          currentChannelGeneration: () => 1,
          nextSequence: async () => (sequence += 1),
          protocolVersion: () => GatewayProtocolManifest.current,
        },
        artifacts: { get: (key) => artifactStore.get(key) },
        pushedInventory: async () => ({ inventory: {}, channelGeneration: 1 }),
        now: () => new Date(clock.now),
        sleep: async () => {},
        pollIntervalMs: 1,
        replyTimeoutMs: 5_000,
      })

      // The controller side: the real wire over the real channel, driven by the real transport.
      const wire = createGatewayOwnedAcpRemoteWire({
        channel,
        route,
        commandId: idFactory('cmd'),
        attemptId: idFactory('att'),
        executionId: ids.executionId,
        traceId: ids.traceId,
        now: () => new Date(clock.now),
      })
      const transport = new SecureAcpRemoteTransport({
        route,
        wire,
        controller: { keyId: route.controllerKeyId, signingKey: controllerKeys.privateKey },
        grantState: () => 'granted',
        now: () => new Date(clock.now),
      })

      const buildCommand = (sequenceNumber, overrides = {}) => {
        const payload = overrides.payload ?? PAYLOAD
        const issuedAt = new Date(clock.now.getTime() + sequenceNumber * 1_000).toISOString()
        return {
          type: 'command',
          schemaVersion: 1,
          protocolVersion: GatewayProtocolManifest.current,
          sequence: sequenceNumber,
          nodeId: ids.nodeId,
          workspaceId: ids.workspaceId,
          traceId: ids.traceId,
          sentAt: issuedAt,
          channelGeneration: 1,
          commandId: overrides.commandId ?? ids.commandId,
          idempotencyKey: overrides.idempotencyKey ?? IDENTITY,
          payloadHash: `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`,
          issuedAt,
          // The signed inner command remains live beyond the previous 60-second carrier TTL.
          expiresAt: new Date(Date.parse(issuedAt) + 180_000).toISOString(),
          family: 'runtime',
          operation: 'runtime.session',
          driver: { family: 'acp', version: '1.0.0' },
          runtimeConnectionId: ids.runtimeConnectionId,
          executionId: ids.executionId,
          attemptId: ids.attemptId,
          requiredCapabilities: ['session.list'],
          payload,
        }
      }

      const commandA = buildCommand(1)
      const first = await transport.dispatch(commandA)
      // Advance beyond A's former carrier expiry, then dispatch B. B forces the carrier
      // eviction pass while A's authenticated inner command remains valid.
      clock.now = new Date(Date.parse(NOW) + 61_000)
      const second = await transport.dispatch(
        buildCommand(2, {
          commandId: 'cmd_01JBBCDEF0123456789ABCDEFG',
          idempotencyKey: 'acp:fedcba9876543210fedcba9876543210fedcba9876543210',
          payload: { version: 1, parameters: { action: 'get' } },
        })
      )
      // The exact same inner command must reuse A's carrier through the real SQLite repository.
      const retryResult = await transport.dispatch(commandA)

      // Both unique commands and A's retry are answered; the durable envelope remains identical.
      expect(first.ack.disposition).toBe('accepted')
      expect(second.ack.disposition).toBe('accepted')
      expect(retryResult.ack.disposition).toBe('accepted')
      expect(carriers).toHaveLength(3)
      expect(carriers[0]).toEqual(carriers[2])
      expect(Date.parse(carriers[0].expiresAt)).toBe(Date.parse(commandA.expiresAt))

      // A and B each run once. A's retry returns the device's recorded result without another effect.
      expect(effects).toBe(2)

      // The recorded result is recoverable: A's reply artifact holds
      // the reply the controller opened, and the real verifier accepts it against the durable
      // command record.
      const retry = carriers[2]
      const record = await delivery.get(retry.commandId)
      expect(record?.status).toBe('succeeded')
      expect(record?.attemptId).toBe(retry.attemptId)
      const stored = artifacts.get(`runtime-results/${retry.attemptId}/result.json`)
      expect(stored).toBeDefined()
      expect(stored.body.byteLength).toBeGreaterThan(0)
      const verifier = new RuntimeCommandArtifactVerifier(artifactStore)
      await verifier.verify({
        command: record,
        artifact: {
          artifactId: `art_${retry.attemptId.slice(4)}`,
          digest: stored.sha256,
          mediaType: stored.contentType,
          sizeBytes: stored.size,
        },
      })
    } finally {
      // The provider holds the open database handle: it is closed BEFORE the directory is
      // removed, so the store is not deleted from under a live connection.
      try {
        provider.close()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }, 30_000)
})
