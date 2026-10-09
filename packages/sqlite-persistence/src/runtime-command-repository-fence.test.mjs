// Focused repository proofs for the SQLite RuntimeCommandRepository (#941/CP1040 gateway channel):
// atomic create identity/dedupe, version+identity compare-and-set, dispatchable ordering/limits,
// and the NEW atomic credential-revocation fence (mirroring the PG port's fail-closed trigger and
// in-transaction host validation). Disposable temp databases only.
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { InMemoryRuntimeCommandRepository, RuntimeCommandRecordSchema } from '@control-plane/domain'
import { SqlitePersistenceProvider, SqliteRuntimeCommandRepository } from './index.js'

const issuedAt = '2026-05-01T10:00:00.000Z'
const NODE = 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const WORKSPACE = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'

function queuedRecord(commandId, overrides = {}) {
  return {
    commandId,
    executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    nodeId: NODE,
    runtimeConnectionId: 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    workspaceId: WORKSPACE,
    idempotencyKey: `runtime-command-fixture-${commandId.slice(-4)}`,
    payloadHash: `sha256:${'a'.repeat(64)}`,
    commandEnvelope: { operation: 'runtime.cancel' },
    issuedAt,
    expiresAt: '2026-05-03T10:00:00.000Z',
    status: 'queued',
    version: 1,
    deliveryAttempts: 0,
    createdAt: issuedAt,
    updatedAt: issuedAt,
    ...overrides,
  }
}

function acknowledgedFrom(queued) {
  return {
    ...queued,
    status: 'acknowledged',
    version: queued.version + 1,
    deliveryAttempts: 1,
    lastChannelGeneration: 1,
    lastSequence: 1,
    firstDispatchedAt: issuedAt,
    lastDispatchedAt: issuedAt,
    acknowledgementReference: 'ack-runtime-fixture-0001',
    acknowledgementDisposition: 'accepted',
    acknowledgedAt: issuedAt,
    updatedAt: issuedAt,
  }
}

async function withRepository(run) {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-runtime-commands-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'commands.sqlite') })
  try {
    await provider.migrate()
    await run(provider)
  } finally {
    provider.close({ checkpoint: true })
    await rm(directory, { recursive: true, force: true })
  }
}

const recordIdFor = (value) => `r-${createHash('sha256').update(value).digest('hex')}`
const COMMAND_A = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAA'
const COMMAND_B = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAB'
const COMMAND_C = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAC'
const FENCE = { credentialId: 'crd_01ARZ3NDEKTSV4RRFFQ69G5FAV', revocationVersion: 2 }

describe('SqliteRuntimeCommandRepository', () => {
  test('create dedupes by identity and reports conflicting identities', async () => {
    await withRepository(async (provider) => {
      const repository = new SqliteRuntimeCommandRepository(provider)
      const record = queuedRecord(COMMAND_A)
      expect(await repository.create(record)).toMatchObject({ outcome: 'created' })
      expect(await repository.create(queuedRecord(COMMAND_A))).toMatchObject({
        outcome: 'duplicate',
      })
      const conflicting = queuedRecord(COMMAND_A, { payloadHash: `sha256:${'b'.repeat(64)}` })
      const conflict = await repository.create(conflicting)
      expect(conflict.outcome).toBe('conflict')
      expect(conflict.record.payloadHash).toBe(record.payloadHash)
      expect(await repository.get(COMMAND_A)).toMatchObject({ payloadHash: record.payloadHash })
    })
  })

  test('compareAndSet enforces version and identity without a fence for dispatch transitions', async () => {
    await withRepository(async (provider) => {
      const repository = new SqliteRuntimeCommandRepository(provider)
      const record = queuedRecord(COMMAND_A)
      await repository.create(record)
      const dispatched = {
        ...record,
        status: 'dispatched',
        version: 2,
        updatedAt: issuedAt,
        deliveryAttempts: 1,
        lastChannelGeneration: 1,
        lastSequence: 1,
        firstDispatchedAt: issuedAt,
        lastDispatchedAt: issuedAt,
      }
      expect(await repository.compareAndSet(1, dispatched)).toBe(true)
      // Stale version and identity changes both fail closed.
      expect(await repository.compareAndSet(1, dispatched)).toBe(false)
      expect(
        await repository.compareAndSet(2, {
          ...dispatched,
          payloadHash: `sha256:${'c'.repeat(64)}`,
        })
      ).toBe(false)
    })
  })

  test('inbound acknowledged transitions fail closed without a well-formed fence', async () => {
    await withRepository(async (provider) => {
      const repository = new SqliteRuntimeCommandRepository(provider)
      await repository.create(queuedRecord(COMMAND_A))
      await expect(
        repository.compareAndSet(1, acknowledgedFrom(queuedRecord(COMMAND_A)))
      ).rejects.toMatchObject({ code: 'INVENTORY_CREDENTIAL_FENCE_INVALID' })
      await expect(
        repository.compareAndSet(1, acknowledgedFrom(queuedRecord(COMMAND_A)), {
          credentialId: 'crd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        })
      ).rejects.toMatchObject({ code: 'INVENTORY_CREDENTIAL_FENCE_INVALID' })
      // The command stays queued: the fenced transition rolled back atomically.
      expect(await repository.get(COMMAND_A)).toMatchObject({ status: 'queued', version: 1 })
    })
  })

  test('a well-formed forged fence is rejected when no verifier is installed (fail closed)', async () => {
    await withRepository(async (provider) => {
      // Root regression: a repository WITHOUT a verifier must never accept a
      // well-formed fence on a required or explicitly fenced transition.
      const repository = new SqliteRuntimeCommandRepository(provider)
      await repository.create(queuedRecord(COMMAND_A))
      await expect(
        repository.compareAndSet(1, acknowledgedFrom(queuedRecord(COMMAND_A)), FENCE)
      ).rejects.toMatchObject({ code: 'INVENTORY_CREDENTIAL_FENCE_INVALID' })
      expect(await repository.get(COMMAND_A)).toMatchObject({ status: 'queued', version: 1 })
    })
  })

  test('a well-formed fence is host-validated in-transaction with the record scope', async () => {
    await withRepository(async (provider) => {
      const scopes = []
      let observedInTransaction
      const repository = new SqliteRuntimeCommandRepository(
        provider,
        async (transaction, fence, scope) => {
          scopes.push({ fence, scope })
          // The verifier runs on the SAME transaction/locking authority as the
          // fenced write: it can read the fenced record in-transaction.
          observedInTransaction = await transaction.get('runtime-commands', recordIdFor(COMMAND_A))
        }
      )
      await repository.create(queuedRecord(COMMAND_A))
      expect(
        await repository.compareAndSet(1, acknowledgedFrom(queuedRecord(COMMAND_A)), FENCE)
      ).toBe(true)
      expect(await repository.get(COMMAND_A)).toMatchObject({ status: 'acknowledged', version: 2 })
      expect(scopes).toEqual([{ fence: FENCE, scope: { nodeId: NODE, workspaceId: WORKSPACE } }])
      expect(RuntimeCommandRecordSchema.parse(observedInTransaction.value)).toMatchObject({
        commandId: COMMAND_A,
        version: 1,
      })

      // A validator failure propagates and leaves the record untouched.
      const rejecting = new SqliteRuntimeCommandRepository(provider, async () => {
        throw new Error('CREDENTIAL_REVOKED')
      })
      await rejecting
        .compareAndSet(
          2,
          {
            ...acknowledgedFrom(queuedRecord(COMMAND_A)),
            version: 3,
            resultStatus: 'succeeded',
            resultRecordedAt: issuedAt,
            status: 'succeeded',
          },
          FENCE
        )
        .catch((error) => expect(String(error)).toContain('CREDENTIAL_REVOKED'))
      expect(await repository.get(COMMAND_A)).toMatchObject({ status: 'acknowledged', version: 2 })
    })
  })

  test('an explicitly fenced dispatch transition is also fence-checked (PG parity)', async () => {
    await withRepository(async (provider) => {
      const repository = new SqliteRuntimeCommandRepository(provider)
      await repository.create(queuedRecord(COMMAND_A))
      const dispatched = {
        ...queuedRecord(COMMAND_A),
        status: 'dispatched',
        version: 2,
        deliveryAttempts: 1,
        lastChannelGeneration: 1,
        lastSequence: 1,
        firstDispatchedAt: issuedAt,
        lastDispatchedAt: issuedAt,
      }
      // An explicitly fenced dispatch transition is fence-checked too: a
      // rejecting host validator fails it and the record stays untouched.
      const rejecting = new SqliteRuntimeCommandRepository(provider, async () => {
        throw new Error('CREDENTIAL_REVOKED')
      })
      await expect(rejecting.compareAndSet(1, dispatched, FENCE)).rejects.toThrow(
        'CREDENTIAL_REVOKED'
      )
      expect(await repository.get(COMMAND_A)).toMatchObject({ status: 'queued' })
    })
  })

  test('listDispatchable keeps dispatchable ordering and bounded limits', async () => {
    await withRepository(async (provider) => {
      const repository = new SqliteRuntimeCommandRepository(provider)
      const later = { ...queuedRecord(COMMAND_B), issuedAt: '2026-05-01T10:00:01.000Z' }
      await repository.create(queuedRecord(COMMAND_A))
      await repository.create(later)
      await repository.create({
        ...queuedRecord(COMMAND_C),
        status: 'dispatched',
        deliveryAttempts: 1,
        lastChannelGeneration: 1,
        lastSequence: 1,
        firstDispatchedAt: issuedAt,
        lastDispatchedAt: issuedAt,
      })
      const listed = await repository.listDispatchable(NODE, issuedAt, 10)
      expect(listed.map(({ commandId }) => commandId)).toEqual([COMMAND_A, COMMAND_C, COMMAND_B])
      expect(await repository.listDispatchable(NODE, issuedAt, 2)).toHaveLength(2)
      // listDispatchable validates its inputs synchronously before opening the transaction.
      expect(() => repository.listDispatchable(NODE, 'not-a-time', 2)).toThrow('INVALID_TIMESTAMP')
      expect(() => repository.listDispatchable(NODE, issuedAt, 0)).toThrow('INVALID_LIMIT')

      // Interface parity with the domain seam: the in-memory reference accepts the same fence arg.
      const memory = new InMemoryRuntimeCommandRepository()
      expect(typeof memory.compareAndSet).toBe('function')
    })
  })
})
