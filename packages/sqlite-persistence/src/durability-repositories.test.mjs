import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  ExecutionLifecycleService,
  ProjectStateService,
  RecordingProjectStateEventPublisher,
} from '@control-plane/domain'
import { ExecutionEventService } from '@control-plane/events'
import {
  SqliteExecutionEventRepository,
  SqliteExecutionRepository,
  SqlitePersistenceProvider,
  SqliteProjectStateRepository,
  SqliteReconciliationCheckpointRepository,
  SqliteRuntimeCommandRepository,
  SqliteRuntimeInventoryCheckpointRepository,
  SqliteRuntimeEventEffectSink,
  SqliteStatePromotionProposalRepository,
} from './index.ts'

const now = '2026-08-30T12:00:00.000Z'
const ids = {
  workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  connectionId: 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
}

describe('SQLite standalone durability repositories', () => {
  test('persists promotion proposals with compare-and-set across reopen', async () => {
    await withReopen(async ({ current, reopened }) => {
      const proposal = promotionProposal()
      const repository = new SqliteStatePromotionProposalRepository(current())
      expect(await repository.insert(proposal)).toBe(true)
      expect(await repository.insert(proposal)).toBe(false)

      const approved = {
        ...proposal,
        state: 'approved',
        revision: 2,
        reviewedAt: '2026-08-30T12:01:00.000Z',
        reviewingPrincipalRef: 'principal://agent-hq/user/42',
      }
      expect(await repository.compareAndSet(1, approved)).toBe(true)
      await reopened()
      const durable = new SqliteStatePromotionProposalRepository(current())
      expect(await durable.get(proposal.proposalId)).toEqual(approved)
      expect(await durable.compareAndSet(1, { ...approved, revision: 3 })).toBe(false)
    })
  })

  test('matches the PostgreSQL project-state mutation and promotion lifecycle', async () => {
    await withReopen(async ({ current, reopened }) => {
      const createService = () =>
        new ProjectStateService(
          new SqliteProjectStateRepository(current()),
          new SqliteStatePromotionProposalRepository(current()),
          new RecordingProjectStateEventPublisher()
        )
      const scope = { workspaceId: ids.workspaceId, projectId: ids.projectId }
      const service = createService()
      await service.initialize({ ...scope, at: now })
      const mutation = {
        ...scope,
        mutationId: 'stm_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        expectedRevision: 0,
        actorPrincipalRef: 'principal://operator',
        operations: [
          {
            ...promotionProposal().operations[0],
            item: {
              ...promotionProposal().operations[0].item,
              itemId: 'psi_01ZRZ3NDEKTSV4RRFFQ69G5FAV',
              key: 'baseline',
              provenance: {
                sourceKind: 'principal',
                sourcePrincipalRef: 'principal://operator',
                artifactRefs: [],
                capturedAt: now,
              },
            },
          },
        ],
        at: '2026-08-30T12:01:00.000Z',
      }
      expect((await service.applyMutation(mutation)).applied).toBe(true)

      await reopened()
      const durable = createService()
      expect((await durable.applyMutation(mutation)).applied).toBe(false)
      expect((await durable.getHistory(scope)).map(({ revision }) => revision)).toEqual([0, 1])
      const proposal = await durable.createPromotionProposal({
        ...scope,
        ...promotionProposal(),
        baseRevision: 1,
      })
      const reviews = await Promise.allSettled([
        durable.approvePromotion({
          proposalId: proposal.proposalId,
          reviewingPrincipalRef: 'principal://reviewer-a',
          reviewedAt: '2026-08-30T12:02:00.000Z',
        }),
        durable.approvePromotion({
          proposalId: proposal.proposalId,
          reviewingPrincipalRef: 'principal://reviewer-b',
          reviewedAt: '2026-08-30T12:02:00.000Z',
        }),
      ])
      expect(reviews.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      expect(reviews.filter(({ status }) => status === 'rejected')).toHaveLength(1)
      expect(
        await durable.mergePromotion({
          proposalId: proposal.proposalId,
          mutationId: 'stm_01BRZ3NDEKTSV4RRFFQ69G5FAV',
          mergedAt: '2026-08-30T12:03:00.000Z',
        })
      ).toMatchObject({ state: 'merged', resultingProjectStateRevision: 2 })

      const rejected = await durable.createPromotionProposal(
        promotionProposal({
          proposalId: 'spp_01BRZ3NDEKTSV4RRFFQ69G5FAV',
          itemId: 'psi_01BRZ3NDEKTSV4RRFFQ69G5FAV',
          key: 'rejected-finding',
          baseRevision: 2,
        })
      )
      expect(
        await durable.rejectPromotion({
          proposalId: rejected.proposalId,
          reviewingPrincipalRef: 'principal://reviewer-a',
          reviewedAt: '2026-08-30T12:04:00.000Z',
          reason: 'not applicable',
        })
      ).toMatchObject({ state: 'rejected', reviewReason: 'not applicable' })

      const expiring = await durable.createPromotionProposal(
        promotionProposal({
          proposalId: 'spp_01CRZ3NDEKTSV4RRFFQ69G5FAV',
          itemId: 'psi_01CRZ3NDEKTSV4RRFFQ69G5FAV',
          key: 'expired-finding',
          baseRevision: 2,
          expiresAt: '2026-08-30T12:05:00.000Z',
        })
      )
      expect(
        await durable.expirePromotion(expiring.proposalId, '2026-08-30T12:05:01.000Z')
      ).toMatchObject({ state: 'expired' })

      const superseded = await durable.createPromotionProposal(
        promotionProposal({
          proposalId: 'spp_01DRZ3NDEKTSV4RRFFQ69G5FAV',
          itemId: 'psi_01DRZ3NDEKTSV4RRFFQ69G5FAV',
          key: 'old-finding',
          baseRevision: 2,
        })
      )
      const successor = await durable.createPromotionProposal(
        promotionProposal({
          proposalId: 'spp_01ERZ3NDEKTSV4RRFFQ69G5FAV',
          itemId: 'psi_01ERZ3NDEKTSV4RRFFQ69G5FAV',
          key: 'new-finding',
          baseRevision: 2,
        })
      )
      expect(
        await durable.supersedePromotion(
          superseded.proposalId,
          successor.proposalId,
          '2026-08-30T12:06:00.000Z'
        )
      ).toMatchObject({ state: 'superseded', supersededByProposalId: successor.proposalId })
    })
  })

  test('persists ordered outbox events and publication state across reopen', async () => {
    await withReopen(async ({ current, reopened }) => {
      const repository = new SqliteExecutionEventRepository(current())
      const service = new ExecutionEventService(repository)
      const event = await service.append(eventDraft())
      const failed = await service.recordPublicationFailure({
        eventId: event.eventId,
        expectedPublicationVersion: 1,
        attemptedAt: '2026-08-30T12:01:00.000Z',
        errorReference: 'delivery://agent-hq/unavailable',
      })
      expect(failed.publication).toMatchObject({ status: 'failed', version: 2 })

      await reopened()
      const durable = new SqliteExecutionEventRepository(current())
      expect(await durable.queryAfter(ids.executionId, 0, 10)).toEqual([failed])
      expect(await durable.queryPending(10, '2026-08-30T12:10:00.000Z')).toEqual([failed])
      expect(await durable.append(eventDraft())).toBeUndefined()
    })
  })

  test('round-trips event sensitivity metadata and keeps legacy events valid', async () => {
    await withReopen(async ({ current, reopened }) => {
      const repository = new SqliteExecutionEventRepository(current())
      const legacy = await repository.append(eventDraft())
      expect(legacy.sensitivity).toBeUndefined()
      expect(legacy.redaction).toBeUndefined()

      const classified = await repository.append({
        ...eventDraft('evt_01ARZ3NDEKTSV4RRFFQ69G5FAW'),
        sensitivity: 'confidential',
        redaction: 'redacted',
      })
      expect(classified).toMatchObject({ sensitivity: 'confidential', redaction: 'redacted' })

      await reopened()
      const durable = new SqliteExecutionEventRepository(current())
      expect(await durable.get(classified.eventId)).toMatchObject({
        sensitivity: 'confidential',
        redaction: 'redacted',
      })
      expect((await durable.get(legacy.eventId)).sensitivity).toBeUndefined()
    })
  })

  test('persists reconciliation decisions with observation-hash CAS across reopen', async () => {
    await withReopen(async ({ current, reopened }) => {
      const checkpoint = reconciliationCheckpoint()
      const repository = new SqliteReconciliationCheckpointRepository(current())
      expect(await repository.insert(checkpoint)).toBe(true)
      expect(await repository.insert(checkpoint)).toBe(false)
      const resolved = {
        ...checkpoint,
        state: 'resolved',
        version: 2,
        updatedAt: '2026-08-30T12:02:00.000Z',
        resolvedAt: '2026-08-30T12:02:00.000Z',
      }
      expect(await repository.compareAndSet(1, resolved)).toBe(true)

      await reopened()
      const durable = new SqliteReconciliationCheckpointRepository(current())
      expect(await durable.getByObservationHash(checkpoint.observationHash)).toEqual(resolved)
      expect(await durable.compareAndSet(1, { ...resolved, version: 3 })).toBe(false)
    })
  })

  test('persists runtime commands and inventory checkpoints across reopen', async () => {
    await withReopen(async ({ current, reopened }) => {
      const command = runtimeCommand()
      const commands = new SqliteRuntimeCommandRepository(current())
      expect((await commands.create(command)).outcome).toBe('created')
      expect((await commands.create(command)).outcome).toBe('duplicate')
      expect(
        (await commands.create({ ...command, payloadHash: `sha256:${'b'.repeat(64)}` })).outcome
      ).toBe('conflict')

      const checkpoint = runtimeInventoryCheckpoint()
      const inventory = new SqliteRuntimeInventoryCheckpointRepository(current())
      expect(await inventory.compareAndSet(undefined, checkpoint)).toBe(true)

      await reopened()
      const durableCommands = new SqliteRuntimeCommandRepository(current())
      const durableInventory = new SqliteRuntimeInventoryCheckpointRepository(current())
      expect(await durableCommands.listDispatchable(ids.nodeId, now, 10)).toEqual([command])
      expect(await durableInventory.get(ids.nodeId)).toEqual(checkpoint)
      expect(await durableInventory.compareAndSet(2, { ...checkpoint, revision: 2 })).toBe(false)
    })
  })

  test('atomically persists runtime event receipts and terminal state across reopen', async () => {
    await withReopen(async ({ current, reopened }) => {
      const executions = new SqliteExecutionRepository(current())
      const lifecycle = new ExecutionLifecycleService(executions)
      const execution = await lifecycle.createExecution(executionInput())
      await lifecycle.createAttempt({
        executionId: execution.executionId,
        attemptId: ids.attemptId,
        expectedExecutionVersion: execution.version,
        queuedAt: '2026-08-30T12:00:01.000Z',
      })
      const effects = new SqliteRuntimeEventEffectSink(current())
      const progress = {
        commandId: ids.commandId,
        eventSequence: 2,
        frameHash: 'a'.repeat(64),
        draft: {
          ...eventDraft('evt_01BRZ3NDEKTSV4RRFFQ69G5FAV'),
          payload: {
            state: 'running',
            privateKey: 'sqlite-runtime-secret-canary-9f4a',
            nested: { signingKey: 'sqlite-runtime-secret-canary-9f4a' },
          },
        },
      }
      expect(await effects.applyProgress(progress)).toMatchObject({
        outcome: 'applied',
        event: {
          payload: {
            state: 'running',
            privateKey: '[REDACTED]',
            nested: { signingKey: '[REDACTED]' },
          },
        },
      })
      expect(await effects.applyProgress(progress)).toMatchObject({ outcome: 'duplicate' })
      expect(await effects.applyProgress({ ...progress, frameHash: 'b'.repeat(64) })).toEqual({
        outcome: 'conflict',
      })
      expect(
        await effects.applyProgress({
          ...progress,
          eventSequence: 1,
          frameHash: 'c'.repeat(64),
          draft: eventDraft('evt_01CRZ3NDEKTSV4RRFFQ69G5FAV'),
        })
      ).toEqual({ outcome: 'out_of_order' })

      const currentExecution = await executions.getExecution(ids.executionId)
      const currentAttempt = await executions.getAttempt(ids.attemptId)
      const terminal = {
        commandId: ids.commandId,
        messageSequence: 3,
        frameHash: 'd'.repeat(64),
        execution: currentExecution,
        attempt: currentAttempt,
        state: 'completed',
        resultReference: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        draft: {
          ...eventDraft('evt_01DRZ3NDEKTSV4RRFFQ69G5FAV'),
          type: 'execution.completed',
          occurredAt: '2026-08-30T12:00:02.000Z',
          recordedAt: '2026-08-30T12:00:02.000Z',
        },
      }
      expect(await effects.applyTerminal(terminal)).toMatchObject({ outcome: 'applied' })

      await reopened()
      const durableEffects = new SqliteRuntimeEventEffectSink(current())
      const durableExecutions = new SqliteExecutionRepository(current())
      expect(await durableEffects.applyTerminal(terminal)).toMatchObject({ outcome: 'duplicate' })
      expect(JSON.stringify(await durableEffects.applyProgress(progress))).not.toContain(
        'sqlite-runtime-secret-canary-9f4a'
      )
      expect(await durableExecutions.getExecution(ids.executionId)).toMatchObject({
        state: 'completed',
        terminalResultRef: terminal.resultReference,
      })
      expect(await durableExecutions.getAttempt(ids.attemptId)).toMatchObject({
        state: 'completed',
        terminalResultRef: terminal.resultReference,
      })
    })
  })
})

async function withReopen(run) {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-sqlite-durability-'))
  const path = join(directory, 'control-plane.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    await run({
      current: () => provider,
      reopened: async () => {
        provider.close()
        provider = new SqlitePersistenceProvider({ path })
        await provider.migrate()
      },
    })
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

function promotionProposal(overrides = {}) {
  const {
    proposalId = 'spp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    itemId = 'psi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    key = 'finding',
    baseRevision = 0,
    expiresAt = '2026-08-31T12:00:00.000Z',
  } = overrides
  return {
    proposalId,
    workspaceId: ids.workspaceId,
    projectId: ids.projectId,
    revision: 1,
    baseRevision,
    sourceExecutionId: ids.executionId,
    operations: [
      {
        kind: 'append',
        item: {
          itemId,
          key,
          value: 'tests pass',
          sensitivity: 'internal',
          freshness: { observedAt: now },
          provenance: {
            sourceKind: 'execution',
            sourceExecutionId: ids.executionId,
            sourcePrincipalRef: 'principal://control-plane/runtime-worker',
            artifactRefs: [],
            capturedAt: now,
          },
        },
      },
    ],
    state: 'candidate',
    createdAt: now,
    expiresAt,
  }
}

function eventDraft(eventId = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV') {
  return {
    eventId,
    executionId: ids.executionId,
    type: 'execution.progressed',
    schemaVersion: 1,
    correlation: {
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      commandId: ids.commandId,
      traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    },
    payload: { progress: 25 },
    occurredAt: now,
    recordedAt: now,
    retentionExpiresAt: '2026-11-30T12:00:00.000Z',
  }
}

function executionInput() {
  return {
    executionId: ids.executionId,
    correlation: {
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    },
    executionPlan: {
      executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      contentDigest: `sha256:${'e'.repeat(64)}`,
      schemaVersion: 1,
    },
    acceptedAt: now,
    deadlineAt: '2026-08-30T13:00:00.000Z',
  }
}

function reconciliationCheckpoint() {
  return {
    checkpointId: `rcp_${'a'.repeat(32)}`,
    executionId: ids.executionId,
    commandId: ids.commandId,
    attemptId: ids.attemptId,
    pendingEventCount: 1,
    observationHash: 'b'.repeat(64),
    reason: 'terminal_undelivered',
    action: 'replay_events',
    state: 'reconciling',
    diagnostics: ['one pending event'],
    version: 1,
    checkedAt: now,
    updatedAt: now,
  }
}

function runtimeCommand() {
  return {
    commandId: ids.commandId,
    executionId: ids.executionId,
    attemptId: ids.attemptId,
    nodeId: ids.nodeId,
    runtimeConnectionId: ids.connectionId,
    workspaceId: ids.workspaceId,
    idempotencyKey: 'runtime-command:test:1',
    payloadHash: `sha256:${'a'.repeat(64)}`,
    commandEnvelope: { type: 'command', payload: { operation: 'run' } },
    issuedAt: now,
    expiresAt: '2026-08-30T12:10:00.000Z',
    status: 'queued',
    version: 1,
    deliveryAttempts: 0,
    createdAt: now,
    updatedAt: now,
  }
}

function runtimeInventoryCheckpoint() {
  return {
    runtimeNodeRefId: ids.nodeId,
    workspaceId: ids.workspaceId,
    snapshotVersion: 1,
    snapshotDigest: `sha256:${'c'.repeat(64)}`,
    observedAt: now,
    activeRuntimeRefs: ['nref_01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    revision: 1,
  }
}
