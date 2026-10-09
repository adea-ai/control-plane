import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { ControlApiFixtures } from '@control-plane/contracts'
import {
  DirectLocalRuntimeTransport,
  MockRuntimeAdapter,
  TransportedRuntimeAdapter,
} from '@control-plane/runtime-sdk'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { PostgresRuntimeChannelOwnershipRepository } from '../packages/database/src/runtime-channel-ownership-repository.ts'
import {
  DurableExecutionCancellationService,
  executionCancellationScopeKey,
} from '../packages/domain/src/execution-cancellation-command.ts'
import { evaluateRuntimeEligibility } from '../packages/runtime-sdk/src/eligibility.ts'
import { WorkflowJobStore } from '../packages/workflow-runtime/src/embedded-job-store.ts'
import { ProfileAdapterError, bindProfileRuntime } from '../packages/profile-adapters/src/index.ts'
import {
  applyPortableImport,
  exportPortableState,
  planPortableImport,
} from '../packages/profile-portability/src/migration.ts'

/**
 * Issue #1025 (M17.02.2) — fencing half: "Revalidate reconnect grants, target
 * generations and input; fence one attempt owner throughout rollback."
 *
 * Every test below exercises an EXISTING primitive, never a new engine:
 * - `WorkflowJobStore` lease tokens fence one attempt owner per job, and the
 *   recovery-parent admission (`assertRecoveryParent`) fences exactly one
 *   rollback continuation per checkpoint while binding the parent's exact
 *   retained input (packages/workflow-runtime).
 * - `evaluateRuntimeEligibility` revalidates reconnect grants and connection
 *   currency (expired/revoked/stale/reconnecting) before an execution may
 *   resume (packages/runtime-sdk).
 * - `PostgresRuntimeChannelOwnershipRepository` rejects claims at or below the
 *   current channel generation and heartbeats from a superseded channel owner
 *   (packages/database, driven through a fake transaction — deterministic,
 *   no Postgres required).
 * - `DurableExecutionCancellationService` binds the exact retained payload and
 *   replays an interrupted cancellation under its first identity
 *   (packages/domain).
 * - `applyPortableImport` rolls back an interrupted profile import and replays
 *   it idempotently (packages/profile-portability).
 * - `bindProfileRuntime` topology guards compare exact adapter/transport
 *   instances so a foreign instance can never take over the route
 *   (packages/profile-adapters, #941 baseline).
 *
 * Deterministic: disposable temp directories only, no network, no Pi, no
 * production recovery, no Postgres instance (the repository is exercised
 * through the same fake-transaction seam its own unit test uses).
 */

const baseInstant = '2026-10-09T12:00:00.000Z'
const leaseExpiredInstant = '2026-10-09T12:01:01.000Z'

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
  const path = join(directory, 'queue.sqlite')
  let provider = await open()
  async function open() {
    const next = new SqlitePersistenceProvider({ path })
    await next.migrate()
    return next
  }
  try {
    await run({
      store: () => new WorkflowJobStore(provider),
      reopen: async () => {
        provider.close({ checkpoint: true })
        provider = await open()
      },
    })
  } finally {
    provider.close({ checkpoint: true })
    await rm(directory, { recursive: true, force: true })
  }
}

describe('WorkflowJobStore lease fencing (one attempt owner, packages/workflow-runtime)', () => {
  test('a superseded lease token cannot complete, fail, or resume the job; exactly one owner lands the outcome', async () => {
    await withJobStore(async ({ store }) => {
      const jobStore = store()
      await jobStore.enqueue({ workflowKey: executionId, input: executionInput, at: baseInstant })

      const firstOwner = 'attempt-owner-1'
      const [firstClaim] = await jobStore.claimDue({
        owner: firstOwner,
        leaseMs: 60_000,
        now: baseInstant,
        limit: 5,
      })
      expect(firstClaim.lease.owner).toBe(firstOwner)
      expect(firstClaim.attempt).toBe(1)

      // The live lease admits no second attempt owner.
      expect(
        await jobStore.claimDue({
          owner: 'attempt-owner-2',
          leaseMs: 60_000,
          now: baseInstant,
          limit: 5,
        })
      ).toEqual([])

      // After the lease lapses the job is reclaimed under a NEW single-use token.
      const [secondClaim] = await jobStore.claimDue({
        owner: 'attempt-owner-2',
        leaseMs: 60_000,
        now: leaseExpiredInstant,
        limit: 5,
      })
      expect(secondClaim.lease.owner).toBe('attempt-owner-2')
      expect(secondClaim.attempt).toBe(2)

      // Every stale-token mutation of the fenced duplicate is rejected without effect.
      const stale = {
        workflowKey: executionId,
        owner: firstOwner,
        token: firstClaim.lease.token,
        at: leaseExpiredInstant,
      }
      expect(
        await jobStore.complete({ ...stale, outcome: { executionId, status: 'completed' } })
      ).toBe(false)
      expect(
        await jobStore.fail({ ...stale, error: 'fenced duplicate must not fail the job' })
      ).toBe(false)
      expect(await jobStore.markWaiting({ ...stale })).toBe(false)
      expect(
        await jobStore.renewLease({ ...stale, leaseMs: 60_000, now: leaseExpiredInstant })
      ).toBe(false)
      const afterStale = await jobStore.get(executionId)
      expect(afterStale.lease).toEqual(secondClaim.lease)
      expect(afterStale.outcome).toBeUndefined()

      // Only the current token holder lands the outcome, and its token is single-use.
      expect(
        await jobStore.complete({
          workflowKey: executionId,
          owner: 'attempt-owner-2',
          token: secondClaim.lease.token,
          outcome: { executionId, status: 'completed' },
          at: leaseExpiredInstant,
        })
      ).toBe(true)
      expect(
        await jobStore.complete({
          workflowKey: executionId,
          owner: 'attempt-owner-2',
          token: secondClaim.lease.token,
          outcome: { executionId, status: 'failed' },
          at: leaseExpiredInstant,
        })
      ).toBe(false)
      const terminal = await jobStore.get(executionId)
      expect(terminal.status).toBe('succeeded')
      expect(terminal.outcome.status).toBe('completed')
    })
  })

  test('an interrupted attempt resumes under one new owner after restart and the outcome stays consistent', async () => {
    await withJobStore(async ({ store, reopen }) => {
      const jobStore = store()
      await jobStore.enqueue({ workflowKey: executionId, input: executionInput, at: baseInstant })
      const [interrupted] = await jobStore.claimDue({
        owner: 'attempt-owner-crashed',
        leaseMs: 60_000,
        now: baseInstant,
        limit: 5,
      })

      // Simulated crash: the process and its SQLite handle die mid-attempt.
      await reopen()

      const restarted = store()
      // The abandoned lease still fences the queue until it expires.
      expect(
        await restarted.claimDue({
          owner: 'attempt-owner-2',
          leaseMs: 60_000,
          now: baseInstant,
          limit: 5,
        })
      ).toEqual([])
      const [resumed] = await restarted.claimDue({
        owner: 'attempt-owner-2',
        leaseMs: 60_000,
        now: leaseExpiredInstant,
        limit: 5,
      })
      expect(resumed.attempt).toBe(2)

      // Only the resumed token may park and resume the rollback continuation.
      expect(
        await restarted.markWaiting({
          workflowKey: executionId,
          owner: 'attempt-owner-crashed',
          token: interrupted.lease.token,
          at: leaseExpiredInstant,
        })
      ).toBe(false)
      expect(
        await restarted.markWaiting({
          workflowKey: executionId,
          owner: 'attempt-owner-2',
          token: resumed.lease.token,
          at: leaseExpiredInstant,
        })
      ).toBe(true)
      expect(
        await restarted.markRunning({
          workflowKey: executionId,
          owner: 'attempt-owner-2',
          token: resumed.lease.token,
          at: leaseExpiredInstant,
        })
      ).toBe(true)

      // A repeated effect records once and replays the recorded result.
      const firstEffect = await restarted.recordEffect(executionId, 'rollback:drain', {
        drained: true,
      })
      const repeatEffect = await restarted.recordEffect(executionId, 'rollback:drain', {
        drained: true,
      })
      expect(firstEffect.outcome).toBe('created')
      expect(repeatEffect.outcome).toBe('existing')
      expect(repeatEffect.result).toEqual(firstEffect.result)

      expect(
        await restarted.complete({
          workflowKey: executionId,
          owner: 'attempt-owner-2',
          token: resumed.lease.token,
          outcome: { executionId, status: 'completed' },
          at: leaseExpiredInstant,
        })
      ).toBe(true)

      // A second restart never reclaims terminal work.
      await reopen()
      expect(
        await store().claimDue({
          owner: 'attempt-owner-3',
          leaseMs: 60_000,
          now: '2026-10-09T13:00:00.000Z',
          limit: 5,
        })
      ).toEqual([])
      expect((await store().get(executionId)).outcome.status).toBe('completed')
    })
  })
})

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

  test('exactly one recovery job may continue a reconciliation_required parent', async () => {
    await withJobStore(async ({ store }) => {
      const jobStore = store()
      await completedParent(jobStore)

      const created = await jobStore.enqueue({
        workflowKey: recoveryKey(recoveryId),
        input: executionInput,
        recovery: { recoveryId, checkpointId, parentWorkflowKey: executionId },
        at: baseInstant,
      })
      expect(created.outcome).toBe('created')

      // A second continuation of the SAME parent is fenced: the parent is
      // already continued, so a duplicate rollback owner can never branch it.
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
      ).rejects.toThrow('WORKFLOW_RECOVERY_PARENT_ALREADY_CONTINUED')
      expect((await jobStore.get(recoveryKey(recoveryId))).recovery.checkpointId).toBe(checkpointId)
    })
  })

  test('a parent continued without an explicit parent key is ambiguous to any further continuation', async () => {
    await withJobStore(async ({ store }) => {
      const jobStore = store()
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
      ).rejects.toThrow('WORKFLOW_RECOVERY_PARENT_AMBIGUOUS')
    })
  })

  test('exact input binding: the continuation must carry the parent input and checkpoint verbatim', async () => {
    await withJobStore(async ({ store }) => {
      const jobStore = store()
      await completedParent(jobStore)

      // Mutated rollback input is rejected with the typed error, not silently adopted.
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
      ).rejects.toThrow('WORKFLOW_RECOVERY_PARENT_MISMATCH')

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
      ).rejects.toThrow('WORKFLOW_RECOVERY_PARENT_MISMATCH')

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
      ).rejects.toThrow('WORKFLOW_RECOVERY_PARENT_MISMATCH')
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

  test('a reconnecting, stale, expired, or revoked connection fails grant revalidation with typed reasons', () => {
    const reconnecting = evaluateRuntimeEligibility(
      withConnection({ availabilityState: 'reconnecting' })
    )
    expect(reconnecting.eligible).toBe(false)
    expect(reasonCodes(reconnecting)).toContain('RUNTIME_OFFLINE')

    const stale = evaluateRuntimeEligibility(withConnection({ availabilityState: 'stale' }))
    expect(stale.eligible).toBe(false)
    expect(reasonCodes(stale)).toContain('RUNTIME_STALE')

    const expired = evaluateRuntimeEligibility(
      withConnection({ status: 'expired', health: 'unavailable' })
    )
    expect(expired.eligible).toBe(false)
    expect(reasonCodes(expired)).toContain('RUNTIME_EXPIRED')

    const revoked = evaluateRuntimeEligibility(
      withConnection({
        status: 'revoked',
        health: 'unavailable',
        compatibilityState: 'revoked',
        availabilityState: 'revoked',
      })
    )
    expect(revoked.eligible).toBe(false)
    expect(reasonCodes(revoked)).toContain('RUNTIME_REVOKED')
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

describe('PostgresRuntimeChannelOwnershipRepository target-generation fencing (packages/database)', () => {
  const nodeId = 'rnr_01DRZ3NDEKTSV4RRFFQ69G5FAV'
  const workspaceId = 'wsp_01DRZ3NDEKTSV4RRFFQ69G5FAV'
  const credentialFence = { credentialId: 'rgc_01DRZ3NDEKTSV4RRFFQ69G5FAV', revocationVersion: 1 }

  function record(generation, overrides = {}) {
    return {
      nodeId,
      workspaceId,
      gatewayInstanceId: `gateway-gen-${generation}`,
      connectionId: `connection-gen-${generation}`,
      channelGeneration: generation,
      protocolVersion: { major: 1, minor: 6 },
      connectedAt: '2026-10-09T12:00:00.000Z',
      lastHeartbeatAt: '2026-10-09T12:00:00.000Z',
      ...overrides,
    }
  }

  /** Same fake-transaction seam the repository's own unit test drives. */
  function ownershipDatabase(current, fenceValid = true) {
    const writes = []
    const transaction = {
      execute: async () => [{ valid: fenceValid }],
      select: () => ({
        from() {
          return this
        },
        where() {
          return this
        },
        async limit() {
          return current === undefined ? [] : [current]
        },
      }),
      insert: () => ({
        values(value) {
          writes.push({ kind: 'insert', value })
          return { async onConflictDoUpdate() {} }
        },
      }),
      update: () => ({
        set(value) {
          writes.push({ kind: 'update', value })
          return { async where() {} }
        },
      }),
    }
    return { writes, database: { transaction: (operation) => operation(transaction) } }
  }

  function currentRow(generation) {
    const owned = record(generation)
    return { nodeId, workspaceId, generation, active: true, record: owned }
  }

  test('a claim at or below the current channel generation is rejected; only a newer generation reconnects', async () => {
    const repository = (current) =>
      new PostgresRuntimeChannelOwnershipRepository(ownershipDatabase(current).database)

    const sameGeneration = await repository(currentRow(2)).claim(record(2), credentialFence)
    expect(sameGeneration.accepted).toBe(false)
    expect(sameGeneration.previous.channelGeneration).toBe(2)

    const staleGeneration = await repository(currentRow(2)).claim(record(1), credentialFence)
    expect(staleGeneration.accepted).toBe(false)

    // The reconnecting owner must present a strictly newer generation.
    const live = ownershipDatabase(currentRow(2))
    const reconnect = await new PostgresRuntimeChannelOwnershipRepository(live.database).claim(
      record(3),
      credentialFence
    )
    expect(reconnect).toMatchObject({ accepted: true })
    expect(reconnect.previous.channelGeneration).toBe(2)
    expect(live.writes).toEqual([
      { kind: 'insert', value: expect.objectContaining({ generation: 3 }) },
    ])

    // A foreign workspace can never take the channel over, whatever generation it claims.
    await expect(
      repository(currentRow(2)).claim(
        record(9, { workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
        credentialFence
      )
    ).rejects.toThrow('RUNTIME_CHANNEL_WORKSPACE_MISMATCH')
  })

  test('a superseded channel owner cannot heartbeat, and an invalid credential fence fails closed', async () => {
    const staleRepository = new PostgresRuntimeChannelOwnershipRepository(
      ownershipDatabase(currentRow(3)).database
    )
    expect(
      await staleRepository.heartbeat(record(2, { lastHeartbeatAt: '2026-10-09T12:00:01.000Z' }))
    ).toBe(false)

    const live = ownershipDatabase(currentRow(3))
    expect(
      await new PostgresRuntimeChannelOwnershipRepository(live.database).heartbeat(
        record(3, { lastHeartbeatAt: '2026-10-09T12:00:01.000Z' }),
        credentialFence
      )
    ).toBe(true)
    expect(live.writes).toHaveLength(1)

    const fenced = ownershipDatabase(currentRow(3), false)
    expect(
      await new PostgresRuntimeChannelOwnershipRepository(fenced.database).claim(
        record(4),
        credentialFence
      )
    ).toEqual({ accepted: false })
    expect(fenced.writes).toEqual([])
  })
})

describe('DurableExecutionCancellationService input binding and replay (packages/domain)', () => {
  const request = {
    ...ControlApiFixtures.executionAcceptance.request,
    operation: 'execution.cancel',
    payload: { executionId: 'exe_01JABCDEF0123456789ABCDEFG' },
  }
  const principal = request.caller.servicePrincipalId

  function fixture() {
    const records = new Map()
    const sent = []
    let state = 'running'
    let loseAck = false
    const receipts = {
      get: async (scope) => structuredClone(records.get(executionCancellationScopeKey(scope))),
      reserve: async (value) => {
        const key = executionCancellationScopeKey(value.request)
        const existing = records.get(key)
        if (!existing) records.set(key, structuredClone(value))
        return { receipt: structuredClone(existing ?? value), inserted: !existing }
      },
      markAccepted: async (scope, at) => {
        const value = records.get(executionCancellationScopeKey(scope))
        value.acceptedAt ??= at
        return structuredClone(value)
      },
    }
    const service = () =>
      new DurableExecutionCancellationService(
        receipts,
        {
          getByExecutionId: async (queriedExecutionId) => ({
            executionId: queriedExecutionId,
            callerPrincipalId: principal,
            workspaceId: request.workspaceId,
            projectId: request.projectId,
          }),
          getExecution: async (queriedExecutionId) => ({
            executionId: queriedExecutionId,
            state,
            correlation: { workspaceId: request.workspaceId, projectId: request.projectId },
          }),
        },
        {
          cancel: async (stored) => {
            sent.push(structuredClone(stored))
            if (loseAck) throw new Error('LOST_ACK')
          },
        },
        () => '2026-10-09T12:00:00.000Z'
      )
    return {
      records,
      sent,
      service,
      setState: (value) => {
        state = value
      },
      loseAck: (value) => {
        loseAck = value
      },
    }
  }

  test('a mutated payload on a reserved identity is a typed conflict and never re-dispatches', async () => {
    const f = fixture()
    const accepted = await f.service().cancel(request, principal)
    expect(accepted.data.commandId).toBe(request.commandId)
    expect(f.sent).toHaveLength(1)

    await expect(
      f
        .service()
        .cancel(
          { ...request, payload: { executionId: 'exe_01JABCDEF0123456789ABCDEFH' } },
          principal
        )
    ).rejects.toThrow('EXECUTION_CANCELLATION_PAYLOAD_CONFLICT')
    // The conflicting command never reaches the dispatcher.
    expect(f.sent).toHaveLength(1)

    // The acknowledged repeat is a replay: the first dispatch stands alone.
    const repeat = await f.service().cancel(request, principal)
    expect(repeat.data).toMatchObject({ commandId: request.commandId, replayed: true })
    expect(f.sent).toHaveLength(1)
  })

  test('an interrupted cancellation resumes under its first identity and re-sends the stored command', async () => {
    const f = fixture()
    f.loseAck(true)
    await expect(f.service().cancel(request, principal)).rejects.toThrow('LOST_ACK')
    expect(f.records.size).toBe(1)
    expect(f.sent).toHaveLength(1)

    f.loseAck(false)
    const replay = await f
      .service()
      .cancel({ ...request, commandId: 'cmd_01JABCDEF0123456789ABCDEFH' }, principal)
    expect(replay.data).toMatchObject({
      commandId: request.commandId,
      replayed: true,
      status: 'accepted',
    })
    // The retry dispatches the RETAINED identity, never the replayed command id.
    expect(f.sent).toEqual([request, request])
  })

  test('cancellation revalidates caller, scope, and liveness on every attempt', async () => {
    const f = fixture()
    await expect(f.service().cancel(request, 'svc_impostor')).rejects.toThrow(
      'EXECUTION_CANCELLATION_CALLER_MISMATCH'
    )
    expect(f.records.size).toBe(0)

    // A brand-new scope may not claim an already-terminal execution.
    f.setState('cancelled')
    await expect(
      f.service().cancel({ ...request, idempotencyKey: 'cancel-again-after-terminal' }, principal)
    ).rejects.toThrow('EXECUTION_CANCELLATION_EXECUTION_INACTIVE')
  })
})

describe('applyPortableImport interrupted upgrade rollback (packages/profile-portability)', () => {
  const createdAt = '2026-10-09T12:00:00.000Z'

  function recordKey(record) {
    return `${record.category}:${record.logicalId}:${record.revision}`
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value))
  }

  function upgradeSource() {
    return {
      profile: 'local',
      persistence: 'sqlite',
      objectStore: 'filesystem',
      componentVersions: { workflow: 'execution-lifecycle-v1', contracts: '1.0.0' },
      snapshot: async () => ({
        records: [
          {
            category: 'project-state',
            logicalId: 'prj_01JABCDEF0123456789ABCDEFG',
            revision: 2,
            value: { objective: 'prove-rollback', provenance: 'principal://operator' },
          },
          {
            category: 'agent-profile',
            logicalId: 'apv_01JABCDEF0123456789ABCDEFG',
            revision: 1,
            value: { semanticVersion: '1.0.0', lifecycle: 'published' },
          },
          {
            category: 'selected-history',
            logicalId: 'exe_01JABCDEF0123456789ABCDEFG',
            revision: 1,
            value: { state: 'completed' },
          },
        ],
        artifacts: [],
        secretReferences: [],
      }),
    }
  }

  class MemoryDestination {
    constructor(options = {}) {
      this.profile = 'hosted-server'
      this.capabilities = new Set(options.capabilities ?? ['execution', 'artifacts'])
      this.secretProviders = new Set(['host-secure'])
      this.records = new Map()
      this.provenance = []
      this.rollbacks = 0
      this.failAfter = options.failAfter
    }

    async inspect(records) {
      return records.map((record) => {
        const existing = this.records.get(recordKey(record))
        return {
          record,
          state:
            existing === undefined
              ? 'missing'
              : existing.contentDigest === record.contentDigest
                ? 'equivalent'
                : 'conflict',
        }
      })
    }

    async begin() {
      const staged = new Map()
      let stagedProvenance
      return {
        put: async (record) => {
          if (this.failAfter !== undefined && staged.size >= this.failAfter) {
            throw new Error('SIMULATED_IMPORT_INTERRUPTION')
          }
          staged.set(recordKey(record), clone(record))
        },
        recordProvenance: async (value) => {
          stagedProvenance = clone(value)
        },
        commit: async () => {
          for (const [key, value] of staged) this.records.set(key, value)
          if (stagedProvenance !== undefined) this.provenance.push(stagedProvenance)
        },
        rollback: async () => {
          this.rollbacks += 1
          staged.clear()
        },
      }
    }
  }

  test('an interrupted upgrade rolls back to a pristine destination and replays idempotently', async () => {
    const manifest = await exportPortableState(upgradeSource(), {
      exportId: 'upgrade-local-up',
      createdAt,
    })

    const interrupted = new MemoryDestination({ failAfter: 1 })
    const interruptedPlan = await planPortableImport(manifest, interrupted)
    await expect(
      applyPortableImport(manifest, interruptedPlan, interrupted, {}, () => createdAt)
    ).rejects.toThrow('SIMULATED_IMPORT_INTERRUPTION')
    // The fenced rollback left nothing behind: no records, no provenance.
    expect(interrupted.records.size).toBe(0)
    expect(interrupted.provenance).toEqual([])
    expect(interrupted.rollbacks).toBe(1)

    const destination = new MemoryDestination()
    const plan = await planPortableImport(manifest, destination)
    expect(
      await applyPortableImport(manifest, plan, destination, {}, () => createdAt)
    ).toMatchObject({
      outcome: 'applied',
    })
    expect(destination.records.size).toBe(2)
    expect([...destination.records.keys()].toSorted()).toEqual([
      'agent-profile:apv_01JABCDEF0123456789ABCDEFG:1',
      'project-state:prj_01JABCDEF0123456789ABCDEFG:2',
    ])

    // The repeated import of the same manifest is a replay, not a second write:
    // it re-records provenance with zero records and copies nothing.
    const replayPlan = await planPortableImport(manifest, destination)
    expect(
      await applyPortableImport(manifest, replayPlan, destination, {}, () => createdAt)
    ).toMatchObject({
      outcome: 'replayed',
    })
    expect(destination.records.size).toBe(2)
    expect(destination.provenance.map((entry) => entry.recordCount)).toEqual([2, 0])
    expect(destination.provenance[0]).toMatchObject({
      sourceProfile: 'local',
      destinationProfile: 'hosted-server',
    })
  })
})

describe('bindProfileRuntime exact-instance topology fencing (packages/profile-adapters, #941)', () => {
  const component = (profile) => ({
    profile,
    start: async () => undefined,
    stop: async () => undefined,
    health: async () => ({ ready: true, component: 'fixture', version: '1.0.0' }),
  })

  const persistence = (profile, dialect) => ({
    profile,
    dialect,
    migrate: async () => undefined,
    health: async () => ({ ready: true, component: 'fixture', version: '1.0.0' }),
    transaction: async () => undefined,
    close: async () => undefined,
  })

  const composition = (profile) => ({
    profile,
    persistence: persistence(profile, 'sqlite'),
    workflow: component(profile),
    objectStore: {
      put: async () => ({}),
      get: async () => ({}),
      head: async () => ({}),
      delete: async () => undefined,
      close: async () => undefined,
    },
    secrets: {
      resolve: async () => ({}),
      health: async () => ({ ready: true, component: 'fixture', version: '1.0.0' }),
      close: async () => undefined,
    },
    coordination: { acquire: async () => undefined, close: async () => undefined },
    processes: { launch: async () => undefined, close: async () => undefined },
    discovery: { discover: async () => [] },
    observability: { write: () => undefined, close: async () => undefined },
  })

  const placement = {
    controlPlaneHostId: 'local-host',
    runtimeHostId: 'local-host',
    runtimeLocation: 'local_device',
    coLocated: true,
  }

  const guards = {
    authority: { assertCurrent: async () => undefined },
    residency: { assertCurrent: async () => undefined },
  }

  function trustedTopology(adapter, transport) {
    return {
      assertCurrent: async (_context, binding) => {
        if (binding.adapter !== adapter || binding.transport !== transport) {
          throw new ProfileAdapterError('PROFILE_RUNTIME_BINDING_MISMATCH', {
            reason: 'TRUSTED_TOPOLOGY_REJECTED',
          })
        }
      },
    }
  }

  function candidate() {
    const driver = new MockRuntimeAdapter()
    const transport = new DirectLocalRuntimeTransport(driver)
    return { adapter: new TransportedRuntimeAdapter(transport, 'mock'), transport }
  }

  const bindingInput = () => ({
    profile: 'local',
    deployment: composition('local'),
    guards,
    requiredCapabilities: [{ capability: 'stream.output', necessity: 'required' }],
  })

  test('the trusted topology binds only its exact adapter and transport instances', async () => {
    const route = candidate()
    const binding = await bindProfileRuntime({
      ...bindingInput(),
      candidate: { ...route, placement },
      topology: trustedTopology(route.adapter, route.transport),
    })
    expect(binding).toMatchObject({
      profile: 'local',
      deploymentProfile: 'local',
      transportKind: 'direct-local',
    })

    // A look-alike instance of the same kind is fenced out: topology guards
    // compare exact instances, not kinds or inspection metadata. Binding fails
    // closed at the FIRST boundary the guard rejects (before any inspection).
    const impostor = candidate()
    const rejections = []
    await bindProfileRuntime({
      ...bindingInput(),
      candidate: { ...impostor, placement },
      topology: trustedTopology(route.adapter, route.transport),
    }).catch((error) => rejections.push(error))
    expect(rejections).toHaveLength(1)
    expect(rejections[0]).toBeInstanceOf(ProfileAdapterError)
    expect(rejections[0].code).toBe('PROFILE_RUNTIME_BINDING_MISMATCH')
  })
})
