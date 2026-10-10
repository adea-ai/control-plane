// All-in-one Local credential/authority wiring proofs (#941/CP #1047): the Local control-api
// composition accepts a host-injected credential authority for runtime-command fences through its
// existing dependency-injection surface; absent authority keeps the fail-closed default. Fixture
// authorities only — no credentials are created and runtime code gains no permissive default.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  SqlitePersistenceProvider,
  SqliteRuntimeCommandRepository,
  createRuntimeNodeCredentialFenceValidator,
} from '@control-plane/sqlite-persistence'
import { LocalControlApiComposition } from './local-api-composition.ts'
import { LocalControlPlaneComposition } from './composition.ts'

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
    acknowledgementReference: 'ack-runtime-fixture-local',
    acknowledgementDisposition: 'accepted',
    acknowledgedAt: ISSUED_AT,
    updatedAt: ISSUED_AT,
  }
}

function fixtureAuthority() {
  const revoked = new Set()
  const authority = {
    revoked,
    current: 1,
    isRevoked: async (credentialId, revocationVersion) =>
      revoked.has(credentialId) || (revocationVersion ?? 1) < authority.current,
  }
  return authority
}

async function withComposition(authority, run) {
  const directory = await mkdtemp(join(tmpdir(), 'local-fence-authority-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'control-plane.sqlite') })
  try {
    await provider.migrate()
    const composition = new LocalControlApiComposition(
      provider,
      'http://127.0.0.1:9080',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      authority
    )
    await run(composition, provider)
  } finally {
    provider.close({ checkpoint: true })
    await rm(directory, { recursive: true, force: true })
  }
}

const FENCE = { credentialId: 'crd_fixture', revocationVersion: 1 }

describe('Local all-in-one credential authority for runtime-command fences', () => {
  test('an injected authority admits the ACK transition and rejects revoked and stale fences', async () => {
    const authority = fixtureAuthority()
    await withComposition(authority, async (composition) => {
      const first = queuedRecord('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAA')
      await composition.runtimeCommands.create(first)
      // Positive: live credential admits the fenced inbound ACK.
      expect(
        await composition.runtimeCommands.compareAndSet(1, acknowledgedFrom(first), FENCE)
      ).toBe(true)
      expect(await composition.runtimeCommands.get(first.commandId)).toMatchObject({
        status: 'acknowledged',
        version: 2,
      })

      // Stale-generation fence: the credential is re-issued at a newer revision,
      // so a fence behind the authority's current rejects.
      authority.current = 2
      const second = queuedRecord('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAB')
      await composition.runtimeCommands.create(second)
      await expect(
        composition.runtimeCommands.compareAndSet(1, acknowledgedFrom(second), FENCE)
      ).rejects.toMatchObject({ code: 'INVENTORY_CREDENTIAL_FENCE_INVALID' })
      expect(await composition.runtimeCommands.get(second.commandId)).toMatchObject({
        status: 'queued',
        version: 1,
      })

      // Revoked credential rejects the next fenced transition; row unchanged.
      authority.revoked.add(FENCE.credentialId)
      const third = queuedRecord('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAC')
      await composition.runtimeCommands.create(third)
      await expect(
        composition.runtimeCommands.compareAndSet(1, acknowledgedFrom(third), {
          ...FENCE,
          revocationVersion: 2,
        })
      ).rejects.toMatchObject({ code: 'INVENTORY_CREDENTIAL_FENCE_INVALID' })
      expect(await composition.runtimeCommands.get(third.commandId)).toMatchObject({
        status: 'queued',
        version: 1,
      })
    })
  })

  test('an absent authority keeps the fail-closed default at the Local composition', async () => {
    await withComposition(undefined, async (composition) => {
      const queued = queuedRecord('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAE')
      await composition.runtimeCommands.create(queued)
      await expect(
        composition.runtimeCommands.compareAndSet(1, acknowledgedFrom(queued), FENCE)
      ).rejects.toMatchObject({ code: 'INVENTORY_CREDENTIAL_FENCE_INVALID' })
      expect(await composition.runtimeCommands.get(queued.commandId)).toMatchObject({
        status: 'queued',
        version: 1,
      })
    })
  })

  test('an in-transaction authority read sees invalidation that landed first, and queued invalidation cannot admit stale authority', async () => {
    await withComposition(fixtureAuthority(), async (composition, provider) => {
      // Provider-backed authority: reads durable invalidation state through the LIVE transaction
      // handle the validator receives.
      const inTransaction = async (transaction, fence) => {
        const revoked = await transaction.get('credential-revocations', `r-${fence.credentialId}`)
        return revoked !== undefined
      }
      const validatorAuthority = {
        isRevoked: async () => false,
      }
      const repository = new SqliteRuntimeCommandRepository(
        provider,
        async (transaction, fence) => {
          if (await inTransaction(transaction, fence)) {
            throw new Error('INVENTORY_CREDENTIAL_FENCE_INVALID')
          }
          await createRuntimeNodeCredentialFenceValidator(validatorAuthority)(transaction, fence)
        }
      )
      // Half 1: invalidation that commits FIRST is visible to the in-transaction read.
      await provider.transaction(async (transaction) =>
        transaction.put({
          namespace: 'credential-revocations',
          id: `r-${FENCE.credentialId}-a`,
          value: { revokedAt: ISSUED_AT },
        })
      )
      const first = queuedRecord('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAA')
      await repository.create(first)
      // The parked proof below uses a fence whose revocation record this validator reads.
      let announce
      const reached = new Promise((resolve) => {
        announce = resolve
      })
      let release
      const barrier = new Promise((resolve) => {
        release = resolve
      })
      const parking = new SqliteRuntimeCommandRepository(provider, async (transaction, fence) => {
        announce()
        await barrier
        if (await inTransaction(transaction, fence)) {
          throw new Error('INVENTORY_CREDENTIAL_FENCE_INVALID')
        }
      })
      const second = queuedRecord('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAB')
      await parking.create(second)
      const pending = parking.compareAndSet(1, acknowledgedFrom(second), {
        credentialId: 'crd_parked',
        revocationVersion: 1,
      })
      await reached
      // Invalidating through the SAME provider cannot commit while the fenced
      // ACK transaction is held (single-writer serialization).
      let invalidationCommitted = false
      const invalidation = provider
        .transaction(async (transaction) =>
          transaction.put({
            namespace: 'credential-revocations',
            id: 'r-crd_parked',
            value: { revokedAt: ISSUED_AT },
          })
        )
        .then(() => {
          invalidationCommitted = true
        })
      release()
      expect(await pending).toBe(true)
      await invalidation
      expect(invalidationCommitted).toBe(true)
      // The invalidation applies strictly after the ACK: the NEXT fenced
      // transition for that credential is rejected — stale authority never admits.
      const fourth = queuedRecord('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAD')
      await parking.create(fourth)
      await expect(
        parking.compareAndSet(1, acknowledgedFrom(fourth), {
          credentialId: 'crd_parked',
          revocationVersion: 1,
        })
      ).rejects.toThrow('INVENTORY_CREDENTIAL_FENCE_INVALID')
      // Half 1 direct: an in-transaction read that observes a committed
      // invalidation rejects (first-landed invalidation is visible).
      const third = queuedRecord('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAC')
      await repository.create(third)
      await expect(
        repository.compareAndSet(1, acknowledgedFrom(third), {
          credentialId: `${FENCE.credentialId}-a`,
          revocationVersion: 1,
        })
      ).rejects.toThrow('INVENTORY_CREDENTIAL_FENCE_INVALID')
      void first
    })
  })

  test('the production host composition wires the injected authority end-to-end', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'local-host-composition-'))
    const authority = fixtureAuthority()
    const composition = new LocalControlPlaneComposition({
      dataDirectory: directory,
      runtimeCommandCredentialAuthority: authority,
    })
    try {
      await composition.persistence.migrate()
      const first = queuedRecord('cmd_01ARZ3NDEKTSV4RRFFQ69G5FBA')
      await composition.runtimeCommands.create(first)
      // Positive through the REAL production host composition.
      expect(
        await composition.runtimeCommands.compareAndSet(1, acknowledgedFrom(first), FENCE)
      ).toBe(true)
      // Revoked: rejected with unchanged row through the same composition.
      authority.revoked.add(FENCE.credentialId)
      const second = queuedRecord('cmd_01ARZ3NDEKTSV4RRFFQ69G5FB1')
      await composition.runtimeCommands.create(second)
      await expect(
        composition.runtimeCommands.compareAndSet(1, acknowledgedFrom(second), {
          ...FENCE,
          revocationVersion: 2,
        })
      ).rejects.toMatchObject({ code: 'INVENTORY_CREDENTIAL_FENCE_INVALID' })
      expect(await composition.runtimeCommands.get(second.commandId)).toMatchObject({
        status: 'queued',
        version: 1,
      })
    } finally {
      await composition.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
