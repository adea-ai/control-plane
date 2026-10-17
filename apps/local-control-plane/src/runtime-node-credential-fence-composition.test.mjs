// Test-only proof of SQLite runtime-command credential fencing through the Local composition.
// The fixture authority reads the credential record through the same PersistenceTransaction as
// the ACK write. No production credential source, SQL roles, grants, or live accounts are used.
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalControlPlaneComposition } from './composition.ts'

const issuedAt = '2026-05-01T10:00:00.000Z'
const NODE = 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const WORKSPACE = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const OTHER_NODE = 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAW'
const OTHER_WORKSPACE = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW'
const COMMAND = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAA'
const CREDENTIAL = 'crd_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const CREDENTIAL_NAMESPACE = 'fixture-runtime-node-credentials'

function queuedRecord(commandId, overrides = {}) {
  return {
    commandId,
    executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    nodeId: NODE,
    runtimeConnectionId: 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    workspaceId: WORKSPACE,
    idempotencyKey: `credential-fence-composition-${commandId.slice(-4)}`,
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
    deliveryAttempts: queued.deliveryAttempts + 1,
    lastChannelGeneration: 1,
    lastSequence: 1,
    firstDispatchedAt: issuedAt,
    lastDispatchedAt: issuedAt,
    acknowledgementReference: `ack-${queued.commandId.slice(-4)}-${queued.version}`,
    acknowledgementDisposition: 'accepted',
    acknowledgedAt: issuedAt,
    updatedAt: issuedAt,
  }
}

function fixtureCredentialAuthority() {
  const reads = []
  let pauseAfterRead
  return {
    reads,
    pauseNextRead() {
      let release
      let reached
      const released = new Promise((resolve) => {
        release = resolve
      })
      const announced = new Promise((resolve) => {
        reached = resolve
      })
      pauseAfterRead = async () => {
        reached()
        await released
      }
      return { reached: announced, release: () => release() }
    },
    async validateCredentialFenceInTransaction(transaction, fence, scope) {
      const stored = await transaction.get(CREDENTIAL_NAMESPACE, fence.credentialId)
      const credential = stored?.value
      reads.push({ credentialId: fence.credentialId, scope, credential })
      const valid =
        credential !== undefined &&
        credential.revoked === false &&
        credential.revocationVersion === fence.revocationVersion &&
        credential.nodeId === scope.nodeId &&
        credential.workspaceId === scope.workspaceId
      if (pauseAfterRead !== undefined) {
        const pause = pauseAfterRead
        pauseAfterRead = undefined
        await pause()
      }
      return valid
    },
  }
}

async function withComposition(run, authority = fixtureCredentialAuthority()) {
  const directory = await mkdtemp(join(tmpdir(), 'cp-credential-fence-'))
  const composition = new LocalControlPlaneComposition({
    dataDirectory: directory,
    runtimeCommandCredentialAuthority: authority,
  })
  try {
    await composition.persistence.migrate()
    await run({ composition, repository: composition.runtimeCommands, authority })
  } finally {
    await composition.close()
    await rm(directory, { recursive: true, force: true })
  }
}

async function putCredential(composition, credentialId, value) {
  await composition.persistence.transaction(async (transaction) => {
    const existing = await transaction.get(CREDENTIAL_NAMESPACE, credentialId)
    await transaction.put({
      namespace: CREDENTIAL_NAMESPACE,
      id: credentialId,
      ...(existing === undefined ? {} : { expectedRevision: existing.revision }),
      value,
    })
  })
}

const FENCE = { credentialId: CREDENTIAL, revocationVersion: 2 }

describe('Local composition runtime-node credential fence', () => {
  test.each([
    ['a different workspace', { workspaceId: OTHER_WORKSPACE }],
    ['a different node', { nodeId: OTHER_NODE }],
    ['a different workspace and node', { workspaceId: OTHER_WORKSPACE, nodeId: OTHER_NODE }],
  ])('rejects a credential issued for %s with no command-row update', async (_label, mismatch) => {
    await withComposition(async ({ composition, repository, authority }) => {
      await putCredential(composition, CREDENTIAL, {
        revocationVersion: 2,
        revoked: false,
        workspaceId: WORKSPACE,
        nodeId: NODE,
        ...mismatch,
      })
      const created = await repository.create(queuedRecord(COMMAND))
      expect(created.outcome).toBe('created')

      await expect(
        repository.compareAndSet(1, acknowledgedFrom(queuedRecord(COMMAND)), FENCE)
      ).rejects.toMatchObject({ code: 'INVENTORY_CREDENTIAL_FENCE_INVALID' })
      expect(await repository.get(COMMAND)).toMatchObject({ status: 'queued', version: 1 })
      expect(authority.reads[0]).toMatchObject({
        credentialId: CREDENTIAL,
        scope: { nodeId: NODE, workspaceId: WORKSPACE },
      })
    })
  })

  test('a revocation-only authority cannot authorize SQLite settlement', async () => {
    await withComposition(
      async ({ repository }) => {
        const record = queuedRecord(COMMAND)
        await repository.create(record)
        await expect(
          repository.compareAndSet(1, acknowledgedFrom(record), FENCE)
        ).rejects.toMatchObject({ code: 'INVENTORY_CREDENTIAL_FENCE_INVALID' })
        expect(await repository.get(COMMAND)).toMatchObject({ status: 'queued', version: 1 })
      },
      { isRevoked: async () => false }
    )
  })

  test('serializes revocation with the fenced ACK transaction', async () => {
    await withComposition(async ({ composition, repository, authority }) => {
      await putCredential(composition, CREDENTIAL, {
        revocationVersion: 2,
        revoked: false,
        workspaceId: WORKSPACE,
        nodeId: NODE,
      })
      await repository.create(queuedRecord(COMMAND))

      const gate = authority.pauseNextRead()
      const pending = repository.compareAndSet(1, acknowledgedFrom(queuedRecord(COMMAND)), FENCE)
      await gate.reached

      let revocationCommitted = false
      const revocation = putCredential(composition, CREDENTIAL, {
        revocationVersion: 3,
        revoked: true,
        workspaceId: WORKSPACE,
        nodeId: NODE,
      }).then(() => {
        revocationCommitted = true
      })
      gate.release()

      expect(await pending).toBe(true)
      await revocation
      expect(revocationCommitted).toBe(true)
      const acknowledged = await repository.get(COMMAND)
      expect(acknowledged).toMatchObject({ status: 'acknowledged', version: 2 })

      await expect(
        repository.compareAndSet(2, acknowledgedFrom(acknowledged), FENCE)
      ).rejects.toMatchObject({ code: 'INVENTORY_CREDENTIAL_FENCE_INVALID' })
      expect(await repository.get(COMMAND)).toMatchObject({ status: 'acknowledged', version: 2 })
    })
  })

  test('rejects revoked and stale-version credentials before changing the command', async () => {
    await withComposition(async ({ composition, repository }) => {
      for (const [commandId, credential] of [
        [COMMAND, { revocationVersion: 2, revoked: true }],
        ['cmd_01ARZ3NDEKTSV4RRFFQ69G5FAB', { revocationVersion: 3, revoked: false }],
      ]) {
        await putCredential(composition, CREDENTIAL, {
          ...credential,
          workspaceId: WORKSPACE,
          nodeId: NODE,
        })
        const record = queuedRecord(commandId)
        await repository.create(record)
        await expect(
          repository.compareAndSet(1, acknowledgedFrom(record), FENCE)
        ).rejects.toMatchObject({ code: 'INVENTORY_CREDENTIAL_FENCE_INVALID' })
        expect(await repository.get(commandId)).toMatchObject({ status: 'queued', version: 1 })
      }
    })
  })
})
