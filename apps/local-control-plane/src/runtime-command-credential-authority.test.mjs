// All-in-one Local credential/authority wiring proofs (#941/CP #1047): the Local control-api
// composition accepts a host-injected credential authority for runtime-command fences through its
// existing dependency-injection surface; absent authority keeps the fail-closed default. Fixture
// authorities only — no credentials are created and runtime code gains no permissive default.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { LocalControlApiComposition } from './local-api-composition.ts'

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
    await run(composition)
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
})
