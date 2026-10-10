import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { evaluateRuntimeEligibility } from '../packages/runtime-sdk/src/eligibility.ts'
import { WorkflowJobStore } from '../packages/workflow-runtime/src/embedded-job-store.ts'

/**
 * Issue #1025 (M17.02.2) — fencing half, restricted to what package tests do
 * not already pin. Lease-token rules, the recovery-chain branch guard, the
 * cancellation identity/replay rules, portable-import rollback, and the
 * exact-instance topology guard are owned by:
 * - packages/workflow-runtime/src/embedded-job-store.test.mjs
 * - packages/domain/src/execution-cancellation-command.test.mjs
 * - packages/profile-portability/src/index.test.mjs
 * - packages/profile-adapters/src/index.test.mjs
 * and are not repeated here.
 *
 * This file adds the rollback-input binding and reconnect-eligibility fencing
 * that no package test pins:
 * - `WorkflowJobStore` rollback continuation admission binds the parent's exact
 *   input and checkpoint (`WORKFLOW_RECOVERY_PARENT_*`).
 * - `evaluateRuntimeEligibility` reconnect revalidation for reconnecting,
 *   expired, revoked-grant, missing-grant, and expired-snapshot candidates.
 * Channel-generation fencing is not driven here. Its acceptance evidence is the
 * real PostgreSQL proof in `packages/database/src/integration.test.mjs`, which
 * drives the canonical repository and inventory unit of work over separate
 * physical sessions (`fences a superseded channel owner across physical reconnects
 * and admits one inventory effect per generation`).
 *
 * Deterministic: disposable temp directories only, no network, no Pi, no
 * production recovery, no Postgres instance.
 */

const baseInstant = '2026-10-09T12:00:00.000Z'

const executionInput = {
  executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  workflowId: 'wfl_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  deadlineAt: '2026-10-09T13:00:00.000Z',
  executionPlan: { planId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV', steps: [] },
}

const executionId = executionInput.executionId
const checkpointId = 'ckpt-rollback-v1'
const recoveryId = 'recover-ckpt-v1-0001'

function recoveryKey(id) {
  return `${executionId}:graph-recovery:${id}`
}

async function withJobStore(run) {
  const directory = await mkdtemp(join(tmpdir(), 'profile-recovery-rollback-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'queue.sqlite') })
  try {
    await provider.migrate()
    await run(new WorkflowJobStore(provider))
  } finally {
    try {
      provider.close({ checkpoint: true })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}

describe('WorkflowJobStore rollback continuation fencing (recovery graph)', () => {
  async function completedParent(store) {
    await store.enqueue({ workflowKey: executionId, input: executionInput, at: baseInstant })
    const [claim] = await store.claimDue({
      owner: 'attempt-owner-1',
      leaseMs: 60_000,
      now: baseInstant,
      limit: 5,
    })
    await store.complete({
      workflowKey: executionId,
      owner: 'attempt-owner-1',
      token: claim.lease.token,
      outcome: { executionId, status: 'reconciliation_required', graphCheckpointId: checkpointId },
      at: baseInstant,
    })
  }

  test('a parent continued without an explicit parent key is ambiguous to any further continuation', async () => {
    await withJobStore(async (jobStore) => {
      await completedParent(jobStore)
      expect(
        await jobStore.enqueue({
          workflowKey: recoveryKey(recoveryId),
          input: executionInput,
          recovery: { recoveryId, checkpointId },
          at: baseInstant,
        })
      ).toMatchObject({ outcome: 'created' })
      // The legacy child named no parent key, so a later explicit continuation
      // of the same checkpoint is fenced as ambiguous — never silently branched.
      await expect(
        jobStore.enqueue({
          workflowKey: recoveryKey('recover-ckpt-v1-0002'),
          input: executionInput,
          recovery: {
            recoveryId: 'recover-ckpt-v1-0002',
            checkpointId,
            parentWorkflowKey: executionId,
          },
          at: baseInstant,
        })
      ).rejects.toThrow(/^WORKFLOW_RECOVERY_PARENT_AMBIGUOUS$/)
    })
  })

  test('exact input binding: the continuation must carry the parent input and checkpoint verbatim', async () => {
    await withJobStore(async (jobStore) => {
      await completedParent(jobStore)

      // Mutated rollback input is rejected, not silently adopted.
      await expect(
        jobStore.enqueue({
          workflowKey: recoveryKey(recoveryId),
          input: {
            ...executionInput,
            workflowId: 'wfl_01ARZ3NDEKTSV4RRFFQ69G5FAV'.slice(0, -1) + 'X',
          },
          recovery: { recoveryId, checkpointId, parentWorkflowKey: executionId },
          at: baseInstant,
        })
      ).rejects.toThrow(/^WORKFLOW_RECOVERY_PARENT_MISMATCH$/)

      // A different target checkpoint cannot hijack the rollback.
      await expect(
        jobStore.enqueue({
          workflowKey: recoveryKey(recoveryId),
          input: executionInput,
          recovery: {
            recoveryId,
            checkpointId: 'ckpt-rollback-v2',
            parentWorkflowKey: executionId,
          },
          at: baseInstant,
        })
      ).rejects.toThrow(/^WORKFLOW_RECOVERY_PARENT_MISMATCH$/)

      // A parent that has not reached reconciliation_required cannot be continued.
      await jobStore.enqueue({
        workflowKey: `${executionId}-2`,
        input: executionInput,
        at: baseInstant,
      })
      await expect(
        jobStore.enqueue({
          workflowKey: `${executionId}-2:graph-recovery:${recoveryId}`,
          input: executionInput,
          recovery: { recoveryId, checkpointId, parentWorkflowKey: `${executionId}-2` },
          at: baseInstant,
        })
      ).rejects.toThrow(/^WORKFLOW_RECOVERY_PARENT_MISMATCH$/)
      expect(await jobStore.get(recoveryKey(recoveryId))).toBeUndefined()
    })
  })
})

describe('evaluateRuntimeEligibility reconnect revalidation (packages/runtime-sdk)', () => {
  const connectionId = 'rtc_01JABCDEF0123456789ABCDEFG'

  function input(overrides = {}) {
    const base = {
      eligibilityVersion: 1,
      evaluatedAt: '2026-10-09T12:00:30.000Z',
      executionPlan: {
        executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
        contentDigest: `sha256:${'a'.repeat(64)}`,
        runtimeRequirements: [{ capability: 'stream.output', necessity: 'required' }],
      },
      candidate: {
        family: 'pi',
        nodeStatus: 'online',
        connection: {
          runtimeConnectionId: connectionId,
          identityDigest: `sha256:${'1'.repeat(64)}`,
          connectionType: 'managed_local',
          runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFG',
          runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
          location: 'local_device',
          opaqueNativeRef: 'nref_01JABCDEF0123456789ABCDEFG',
          adapterVersion: '1.0.0',
          driverVersion: '1.0.0',
          harnessVersion: '1.0.0',
          protocolVersion: '1.0.0',
          status: 'connected',
          health: 'healthy',
          availabilityState: 'healthy',
          capabilities: [{ name: 'stream.output', support: 'supported' }],
          capabilitySnapshotVersion: 1,
          capabilitySnapshotObservedAt: '2026-10-09T12:00:00.000Z',
          capabilitySnapshotExpiresAt: '2026-10-09T12:01:00.000Z',
          capabilityVerification: 'verified',
          compatibilityState: 'compatible',
          limitations: [],
          diagnostics: [],
          lastDiscoveredAt: '2026-10-09T12:00:00.000Z',
          lastHeartbeatAt: '2026-10-09T12:00:00.000Z',
          lastHealthCheckAt: '2026-10-09T12:00:00.000Z',
          version: 2,
          createdAt: '2026-10-09T11:00:00.000Z',
          updatedAt: '2026-10-09T12:00:00.000Z',
        },
      },
      policy: {
        snapshot: {
          policyId: 'workspace-standard',
          version: 3,
          digest: `sha256:${'b'.repeat(64)}`,
        },
        allowedFamilies: ['pi', 'acp'],
        allowedLocations: ['local_device'],
        deniedRuntimeConnectionIds: [],
        requireVerifiedCapabilities: true,
        security: { status: 'allowed' },
      },
      localProjectGrant: { required: true, status: 'granted', grantRef: 'grant:project-1' },
      entitlement: { status: 'allowed', class: 'workspace' },
      preference: { runtimeConnectionId: connectionId, family: 'pi' },
    }
    return { ...base, ...overrides }
  }

  function withConnection(overrides) {
    return input({
      candidate: {
        ...input().candidate,
        connection: { ...input().candidate.connection, ...overrides },
      },
    })
  }

  function reasonCodes(decision) {
    return decision.reasons.map((reason) => reason.code)
  }

  test('a currently granted runtime is eligible before reconnect', () => {
    const decision = evaluateRuntimeEligibility(input())
    expect(decision.eligible).toBe(true)
    expect(reasonCodes(decision)).toEqual([])
  })

  test('a reconnecting or expired connection fails grant revalidation with typed reasons', () => {
    const reconnecting = evaluateRuntimeEligibility(
      withConnection({ availabilityState: 'reconnecting' })
    )
    expect(reconnecting.eligible).toBe(false)
    expect(reasonCodes(reconnecting)).toContain('RUNTIME_OFFLINE')

    const expired = evaluateRuntimeEligibility(
      withConnection({ status: 'expired', health: 'unavailable' })
    )
    expect(expired.eligible).toBe(false)
    expect(reasonCodes(expired)).toContain('RUNTIME_EXPIRED')
  })

  test('a revoked or missing local project grant fails reconnect revalidation', () => {
    const revokedGrant = evaluateRuntimeEligibility(
      input({
        localProjectGrant: { required: true, status: 'revoked', grantRef: 'grant:project-1' },
      })
    )
    expect(revokedGrant.eligible).toBe(false)
    expect(reasonCodes(revokedGrant)).toContain('LOCAL_PROJECT_GRANT_REVOKED')

    const missingGrant = evaluateRuntimeEligibility(
      input({
        localProjectGrant: { required: true, status: 'missing', grantRef: 'grant:project-1' },
      })
    )
    expect(missingGrant.eligible).toBe(false)
    expect(reasonCodes(missingGrant)).toContain('LOCAL_PROJECT_GRANT_MISSING')
  })

  test('an expired capability snapshot fails revalidation even while the connection looks healthy', () => {
    const staleSnapshot = evaluateRuntimeEligibility(
      withConnection({ capabilitySnapshotExpiresAt: '2026-10-09T12:00:00.000Z' })
    )
    expect(staleSnapshot.eligible).toBe(false)
    expect(reasonCodes(staleSnapshot)).toContain('CAPABILITY_SNAPSHOT_STALE')
  })
})
