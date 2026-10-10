// Test-only qualification of the runtime-node credential fence composition (#1047, root-directed).
// Traced wiring (no source changed by this file):
//   - Local all-in-one: LocalControlPlaneComposition({ runtimeCommandCredentialAuthority })
//     -> local-api-composition.ts builds createRuntimeNodeCredentialFenceValidator(authority)
//     -> SqliteRuntimeCommandRepository(provider, validator). composition.runtimeCommands is the
//       real repository; absent authority keeps the fail-closed default (no verifier).
//   - Hosted gateway (SQLite store): composition.ts createSqliteRuntimeCommandRepository(provider,
//     credentialAuthority?) wraps the SAME validator around the RuntimeNodeIdentityGatewayPort the
//     channel authenticator uses; absent authority stays fail-closed.
//   - Hosted gateway (PostgreSQL store): no SQLite validator — fence enforcement lives in the
//     PG SECURITY DEFINER path with PostgresRuntimeNodeIdentityValidationPort + revocation listener
//     (identity authority required at composition, else RUNTIME_GATEWAY_IDENTITY_AUTHORITY_REQUIRED).
// Qualifications here: (a) a credential bound to a DIFFERENT workspace/node, and (b) revocation
// committing while a claim is paused after its current-authority read but before the executable
// claim commits. Fixture credentials live ONLY in this test's disposable store — no production
// credential source, SQL/roles, grants, or live accounts are created or touched.
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalControlPlaneComposition } from './composition.ts'

const issuedAt = '2026-05-01T10:00:00.000Z'
const NODE = 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const WORKSPACE = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
// The other scope: a credential issued for a different workspace AND node.
const OTHER_NODE = 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAW'
const OTHER_WORKSPACE = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW'
const COMMAND = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAA'
const CREDENTIAL = 'crd_01ARZ3NDEKTSV4RRFFQ69G5FAV'

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

/**
 * Test-only fixture credential authority (the injected Local DI seam). Credentials carry a
 * workspace/node for traceability, but — like every real implementation of the port — the
 * fence check can only be called as isRevoked(credentialId, revocationVersion): the repository
 * passes {nodeId, workspaceId} to the validator and the validator drops them.
 */
function fixtureCredentialAuthority() {
  const credentials = new Map()
  const reads = []
  let pauseAfterRead
  return {
    credentials,
    reads,
    /** Arms a one-shot pause that resolves AFTER the current-authority read returns. */
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
      return {
        reached: announced,
        release: () => release(),
      }
    },
    async isRevoked(credentialId, revocationVersion) {
      reads.push({
        credentialId,
        revocationVersion,
        argumentCount: arguments.length,
      })
      const record = credentials.get(credentialId)
      // Unknown credentials fail closed, matching a strict production authority.
      if (record === undefined) return true
      const staleVersion =
        revocationVersion !== undefined && revocationVersion !== record.revocationVersion
      const current = record.revoked || staleVersion
      if (pauseAfterRead !== undefined) {
        const pause = pauseAfterRead
        pauseAfterRead = undefined
        await pause()
      }
      return current
    },
  }
}

async function withComposition(run) {
  const directory = await mkdtemp(join(tmpdir(), 'cp-credential-fence-'))
  const authority = fixtureCredentialAuthority()
  const composition = new LocalControlPlaneComposition({
    dataDirectory: directory,
    runtimeCommandCredentialAuthority: authority,
  })
  try {
    await composition.persistence.migrate()
    const repository = composition.runtimeCommands
    expect(repository).toBeDefined()
    await run({ composition, repository, authority })
  } finally {
    await composition.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const FENCE = { credentialId: CREDENTIAL, revocationVersion: 2 }

describe('real Local composition runtime-node credential fence', () => {
  test('(a) a non-revoked credential issued for a different workspace/node is not refused by the fence validator itself', async () => {
    await withComposition(async ({ repository, authority }) => {
      // Fixture credential belongs to ANOTHER workspace and node, is current, and is not revoked.
      authority.credentials.set(CREDENTIAL, {
        revocationVersion: 2,
        revoked: false,
        workspaceId: OTHER_WORKSPACE,
        nodeId: OTHER_NODE,
      })
      const created = await repository.create(queuedRecord(COMMAND))
      expect(created.outcome).toBe('created')

      const accepted = await repository.compareAndSet(
        1,
        acknowledgedFrom(queuedRecord(COMMAND)),
        FENCE
      )
      // DEMONSTRATED GAP (boundary trace): the repository hands the validator the command's
      // {nodeId, workspaceId} scope, but createRuntimeNodeCredentialFenceValidator drops it and
      // calls isRevoked with only the credential id and version — so the real composition
      // boundary does NOT refuse a cross-workspace/node credential; scope binding lives only in
      // the upstream channel authenticator (traced: gateway authenticateUpgrade / channel),
      // not in this repository fence.
      expect(accepted).toBe(true)
      expect(authority.reads).toHaveLength(1)
      expect(authority.reads[0]).toMatchObject({
        credentialId: CREDENTIAL,
        revocationVersion: 2,
        argumentCount: 2,
      })
      // The admitted transition is exactly one record update; nothing else changed.
      const stored = await repository.get(COMMAND)
      expect(stored).toMatchObject({ status: 'acknowledged', version: 2 })
    })
  })

  test('(b) revocation committing after the current-authority read does not stop the paused claim (order-checked only, no commit-time re-check)', async () => {
    await withComposition(async ({ repository, authority }) => {
      authority.credentials.set(CREDENTIAL, {
        revocationVersion: 2,
        revoked: false,
        workspaceId: WORKSPACE,
        nodeId: NODE,
      })
      await repository.create(queuedRecord(COMMAND))

      const gate = authority.pauseNextRead()
      const pending = repository.compareAndSet(1, acknowledgedFrom(queuedRecord(COMMAND)), FENCE)
      // The claim is paused INSIDE its current-authority read: isRevoked has already read
      // "not revoked", and the executable claim (the fenced put) has not committed yet.
      await gate.reached
      // Revocation commits now — strictly after the authority read, strictly before the put.
      authority.credentials.get(CREDENTIAL).revoked = true
      gate.release()

      // DEMONSTRATED: the claim still commits. createRuntimeNodeCredentialFenceValidator
      // discards the live transaction handle (void transaction) and performs no re-check at
      // commit time, so the boundary is ORDER-CHECKED ONLY across this window — exactly the
      // behavior its contract comment documents ("no revocation re-check exists at commit time
      // beyond this ordering guarantee").
      expect(await pending).toBe(true)
      const stored = await repository.get(COMMAND)
      expect(stored).toMatchObject({ status: 'acknowledged', version: 2 })
      expect(authority.reads).toHaveLength(1)

      // Ordering boundary that DOES hold: the next fenced transition is refused, with a
      // zero-effect failure — the record is left exactly as the first claim wrote it.
      const second = acknowledgedFrom({ ...stored, deliveryAttempts: stored.deliveryAttempts })
      await expect(repository.compareAndSet(2, second, FENCE)).rejects.toThrow(
        'INVENTORY_CREDENTIAL_FENCE_INVALID'
      )
      expect(await repository.get(COMMAND)).toMatchObject({ status: 'acknowledged', version: 2 })
      expect(authority.reads).toHaveLength(2)
    })
  })

  test('revocation committed before the claim refuses it with zero effect on the record', async () => {
    await withComposition(async ({ repository, authority }) => {
      authority.credentials.set(CREDENTIAL, {
        revocationVersion: 2,
        revoked: true,
        workspaceId: WORKSPACE,
        nodeId: NODE,
      })
      await repository.create(queuedRecord(COMMAND))

      await expect(
        repository.compareAndSet(1, acknowledgedFrom(queuedRecord(COMMAND)), FENCE)
      ).rejects.toThrow('INVENTORY_CREDENTIAL_FENCE_INVALID')
      // Zero effect: the refused claim never touched the record — still queued at version 1.
      const stored = await repository.get(COMMAND)
      expect(stored).toMatchObject({ status: 'queued', version: 1 })
      expect(await repository.listDispatchable(NODE, '2026-05-02T10:00:00.000Z', 10)).toHaveLength(
        1
      )
      expect(authority.reads).toHaveLength(1)
    })
  })

  test('a stale credential version in the fence is refused with zero effect (version-aware authority)', async () => {
    await withComposition(async ({ repository, authority }) => {
      authority.credentials.set(CREDENTIAL, {
        revocationVersion: 3,
        revoked: false,
        workspaceId: WORKSPACE,
        nodeId: NODE,
      })
      await repository.create(queuedRecord(COMMAND))
      // The fence presents revocationVersion 2 while the fixture credential is at 3.
      await expect(
        repository.compareAndSet(1, acknowledgedFrom(queuedRecord(COMMAND)), FENCE)
      ).rejects.toThrow('INVENTORY_CREDENTIAL_FENCE_INVALID')
      expect(await repository.get(COMMAND)).toMatchObject({ status: 'queued', version: 1 })
      expect(authority.reads[0]).toMatchObject({ credentialId: CREDENTIAL, revocationVersion: 2 })
    })
  })
})
