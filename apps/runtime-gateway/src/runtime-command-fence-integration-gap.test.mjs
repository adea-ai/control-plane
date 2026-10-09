// Production-integration gap proof for the durable runtime-command fence (#941 / CP #1047):
// production constructs SqliteRuntimeCommandRepository with ONLY the provider —
// apps/runtime-gateway/src/composition.ts:272 and
// apps/local-control-plane/src/local-api-composition.ts:140 (exposed as
// LocalControlPlaneComposition.runtimeCommands) — while the delivery service passes credentialFence
// into compareAndSet (runtime-command-delivery.ts:356). With no verifier installed, every fenced
// inbound ACK/result settlement now fails closed; these sites must inject a host verifier (the
// canonical node-credential authority for the profile) before fenced settlements can pass on
// SQLite profiles. Disposable temp databases only.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  SqlitePersistenceProvider,
  SqliteRuntimeCommandRepository,
} from '@control-plane/sqlite-persistence'

const ISSUED_AT = '2026-05-01T10:00:00.000Z'
const FENCE = { credentialId: 'crd_01ARZ3NDEKTSV4RRFFQ69G5FAV', revocationVersion: 2 }

function queuedRecord(commandId) {
  return {
    commandId,
    executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    runtimeConnectionId: 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    idempotencyKey: 'runtime-command-fixture-gap01',
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
    acknowledgementReference: 'ack-runtime-fixture-gap01',
    acknowledgementDisposition: 'accepted',
    acknowledgedAt: ISSUED_AT,
    updatedAt: ISSUED_AT,
  }
}

describe('runtime command fence production wiring (#1047)', () => {
  test('provider-only production constructions reject fenced settlements until a verifier is injected', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-runtime-commands-'))
    const provider = new SqlitePersistenceProvider({ path: join(directory, 'commands.sqlite') })
    try {
      await provider.migrate()
      // Exactly as production composes it (provider only): fenced inbound
      // settlements fail closed — the documented missing integration.
      const runtimeCommands = new SqliteRuntimeCommandRepository(provider)
      const queued = queuedRecord('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAA')
      await runtimeCommands.create(queued)
      await expect(
        runtimeCommands.compareAndSet(1, acknowledgedFrom(queued), FENCE)
      ).rejects.toMatchObject({ code: 'INVENTORY_CREDENTIAL_FENCE_INVALID' })
      expect(await runtimeCommands.get(queued.commandId)).toMatchObject({
        status: 'queued',
        version: 1,
      })

      // With a host verifier injected, the identical fenced settlement passes:
      // the gap is precisely the missing validator at the composition sites.
      const wired = new SqliteRuntimeCommandRepository(provider, async () => {})
      expect(await wired.compareAndSet(1, acknowledgedFrom(queued), FENCE)).toBe(true)
      expect(await wired.get(queued.commandId)).toMatchObject({
        status: 'acknowledged',
        version: 2,
      })
    } finally {
      provider.close({ checkpoint: true })
      await rm(directory, { recursive: true, force: true })
    }
  })
})
