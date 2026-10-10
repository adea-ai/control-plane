// Production credential-authority proofs for the SQLite-profile runtime-command repository
// (#1047): the actual production factory (createSqliteRuntimeCommandRepository, called by
// apps/runtime-gateway/src/composition.ts for store.backend !== 'postgres') consults the SAME
// runtime-node credential source the channel authenticator trusts. Proves a valid admitted ACK,
// revoked rejection, stale-generation rejection (version-aware authorities), and retained
// fail-closed behavior when no authority is supplied. Disposable temp databases only; no live
// credentials or settings.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { SyntheticRuntimeNodeIdentityAuthority } from './synthetic-node-identity.ts'
import { createSqliteRuntimeCommandRepository } from './composition.ts'

const ISSUED_AT = '2026-05-01T10:00:00.000Z'
const NODE_ID = 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const WORKSPACE_ID = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'

function queuedRecord(commandId) {
  return {
    commandId,
    executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    nodeId: NODE_ID,
    runtimeConnectionId: 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    workspaceId: WORKSPACE_ID,
    idempotencyKey: `runtime-command-fixture-${commandId.slice(-4)}`,
    payloadHash: `sha256:${'a'.repeat(64)}`,
    commandEnvelope: { operation: 'runtime.cancel' },
    issuedAt: ISSUED_AT,
    expiresAt: '2026-05-03T10:00:00.000Z',
    status: 'queued',
    version: 1,
    deliveryAttempts: 0,
    createdAt: ISSUED_AT,
    updatedAt: ISSUED_AT,
  }
}

function acknowledgedFrom(queued) {
  return {
    ...queued,
    status: 'acknowledged',
    version: 2,
    deliveryAttempts: 1,
    lastChannelGeneration: 1,
    lastSequence: 1,
    firstDispatchedAt: ISSUED_AT,
    lastDispatchedAt: ISSUED_AT,
    acknowledgementReference: 'ack-runtime-fixture-authority',
    acknowledgementDisposition: 'accepted',
    acknowledgedAt: ISSUED_AT,
    updatedAt: ISSUED_AT,
  }
}

async function withProvider(run) {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-fence-authority-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'commands.sqlite') })
  try {
    await provider.migrate()
    await run(provider)
  } finally {
    provider.close({ checkpoint: true })
    await rm(directory, { recursive: true, force: true })
  }
}

const FENCE = { credentialId: 'rgc_01ARZ3NDEKTSV4RRFFQ69G5FAV', revocationVersion: 1 }

describe('SQLite-profile runtime-command credential authority at the production factory', () => {
  test('a valid credential admits the ACK transition; revocation rejects the next one', async () => {
    await withProvider(async (provider) => {
      const authority = new SyntheticRuntimeNodeIdentityAuthority({
        audience: 'runtime-gateway',
        issuer: 'https://control-plane.test',
      })
      const device = authority.registerNode({ nodeId: NODE_ID, workspaceId: WORKSPACE_ID })
      const { claims } = authority.issueCredential(device, { channelGeneration: 1 })
      const fence = {
        credentialId: claims.credentialId,
        revocationVersion: claims.revocationVersion,
      }
      const repository = createSqliteRuntimeCommandRepository(provider, authority.validationPort())

      // Positive: a live credential admits the fenced inbound ACK transition.
      const first = queuedRecord('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAA')
      await repository.create(first)
      expect(await repository.compareAndSet(1, acknowledgedFrom(first), fence)).toBe(true)
      expect(await repository.get(first.commandId)).toMatchObject({
        status: 'acknowledged',
        version: 2,
      })

      // Revoked: the same authority rejects the next fenced transition, unchanged row.
      authority.revokeCredential(claims.credentialId)
      const second = queuedRecord('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAB')
      await repository.create(second)
      await expect(
        repository.compareAndSet(1, acknowledgedFrom(second), fence)
      ).rejects.toMatchObject({ code: 'INVENTORY_CREDENTIAL_FENCE_INVALID' })
      expect(await repository.get(second.commandId)).toMatchObject({ status: 'queued', version: 1 })
    })
  })

  test('stale-generation fences reject through version-aware authorities', async () => {
    await withProvider(async (provider) => {
      // A version-aware authority (PG-style): a fence behind the credential's current
      // revocationVersion is stale and must reject.
      const staleAware = {
        verify: async () => {
          throw new Error('NOT_USED')
        },
        isRevoked: async (credentialId, revocationVersion) =>
          credentialId === FENCE.credentialId && revocationVersion < 2,
        consumeCredential: async () => 'consumed',
        subscribeRevocations: () => () => {},
      }
      const repository = createSqliteRuntimeCommandRepository(provider, staleAware)
      const queued = queuedRecord('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAC')
      await repository.create(queued)
      await expect(
        repository.compareAndSet(1, acknowledgedFrom(queued), FENCE)
      ).rejects.toMatchObject({ code: 'INVENTORY_CREDENTIAL_FENCE_INVALID' })
      expect(await repository.get(queued.commandId)).toMatchObject({ status: 'queued', version: 1 })
      // A current-version fence from the same authority is admitted.
      const fresh = queuedRecord('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAD')
      await repository.create(fresh)
      expect(
        await repository.compareAndSet(1, acknowledgedFrom(fresh), {
          credentialId: FENCE.credentialId,
          revocationVersion: 2,
        })
      ).toBe(true)
    })
  })

  test('an absent authority keeps the fail-closed default', async () => {
    await withProvider(async (provider) => {
      const repository = createSqliteRuntimeCommandRepository(provider)
      const queued = queuedRecord('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAE')
      await repository.create(queued)
      await expect(
        repository.compareAndSet(1, acknowledgedFrom(queued), FENCE)
      ).rejects.toMatchObject({ code: 'INVENTORY_CREDENTIAL_FENCE_INVALID' })
      expect(await repository.get(queued.commandId)).toMatchObject({ status: 'queued', version: 1 })
    })
  })
})
