import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { eq } from 'drizzle-orm'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'
import { PostgresExecutionRepository } from './execution-repository.ts'
import { PostgresMemoryWriteProposalRepository } from './memory-write-proposal-repository.ts'
import { executions, executionAttempts } from './schema/executions.ts'
import { memoryWriteProposals } from './schema/memory-write-proposals.ts'
import { delegations } from './schema/delegations.ts'
import { usageLedgerEntries } from './schema/usage-ledger.ts'
const executionId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const attemptId = 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const acceptedAt = '2026-05-01T10:00:00.000Z'
const terminalAt = '2026-05-02T10:00:00.000Z'
const retentionMs = 90 * 24 * 60 * 60 * 1_000
let isolated
const credentials = {
  administration: { role: 'administration', url: process.env.DATABASE_ADMIN_URL },
  migration: { role: 'migration', url: process.env.DATABASE_MIGRATION_URL },
  application: { role: 'application', url: process.env.DATABASE_URL },
}
async function seedOwner(database, ownerId = executionId, ownerAttemptId = attemptId) {
  await database.insert(executions).values({
    executionId: ownerId,
    state: 'completed',
    version: 2,
    workspaceId,
    projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    executionPlanDigest: `sha256:${'b'.repeat(64)}`,
    executionPlanSchemaVersion: 1,
    attemptCount: 1,
    latestAttemptId: ownerAttemptId,
    acceptedAt: new Date(acceptedAt),
    terminalAt: new Date(terminalAt),
    createdAt: new Date(acceptedAt),
    updatedAt: new Date(terminalAt),
  })
  await database.insert(executionAttempts).values({
    attemptId: ownerAttemptId,
    executionId: ownerId,
    sequence: 1,
    state: 'completed',
    version: 1,
    acceptedAt: new Date(acceptedAt),
    terminalAt: new Date(terminalAt),
    createdAt: new Date(acceptedAt),
    updatedAt: new Date(terminalAt),
  })
}
function memoryProposal(state = 'proposed') {
  return {
    proposalId: 'mwp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    providerId: 'ctp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    connectionId: 'ctc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    workspaceId,
    scopeDigest: `sha256:${'a'.repeat(64)}`,
    memoryType: 'fact',
    content: 'Retention provenance',
    retention: 'project',
    provenance: {
      sourceExecutionId: executionId,
      sourceAttemptId: attemptId,
      confidence: 0.9,
      importance: 0.8,
      sensitivity: 'internal',
      evidenceRefs: [],
      artifactRefs: [],
    },
    dedupeHint: 'retention-provenance',
    contentDigest: `sha256:${'b'.repeat(64)}`,
    state,
    version: 1,
    createdAt: acceptedAt,
    updatedAt: terminalAt,
  }
}
const retentionNow = new Date(Date.parse(terminalAt) + retentionMs + 1_000)
const retentionOptions = { policyRetainMs: retentionMs, dryRun: false }

describe.skipIf(process.env.RUN_DATABASE_INTEGRATION !== 'true')(
  'PostgreSQL memory provenance retention',
  () => {
    beforeEach(async () => {
      isolated = await createIsolatedTestDatabase(credentials)
      try {
        await isolated.migrate()
        await seedOwner(isolated.application)
      } catch (error) {
        const database = isolated
        isolated = undefined
        try {
          await database.dispose()
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Memory provenance fixture setup and cleanup failed',
            {
              cause: cleanupError,
            }
          )
        }
        throw error
      }
    }, integrationTestTimeout(60_000))
    afterEach(async () => {
      const database = isolated
      isolated = undefined
      if (database) await database.dispose()
    }, integrationTestTimeout())
    test('retains a memory proposal source and attempt across lifecycle transitions and fresh connections', async () => {
      const proposals = new PostgresMemoryWriteProposalRepository(isolated.application)
      let proposal = memoryProposal()
      await proposals.insert(proposal)
      for (const state of [
        'proposed',
        'awaiting_approval',
        'approved',
        'denied',
        'expired',
        'revoked',
        'committing',
        'committed',
        'failed',
        'reconciliation_required',
      ]) {
        const changed = { ...proposal, state, version: proposal.version + 1 }
        expect(await proposals.compareAndSet(proposal.version, changed)).toBe(true)
        proposal = changed
        await isolated.withMigrationDatabase(async (database) => {
          const result = await new PostgresExecutionRepository(database).deleteEligibleExecutions(
            retentionNow,
            retentionOptions
          )
          expect(result.deleted).toBe(0)
          expect(result.retainedByReason).toEqual({ reference_pending: 1 })
          expect(await database.select().from(executions)).toHaveLength(1)
          expect(await database.select().from(executionAttempts)).toHaveLength(1)
        })
      }
    })
    test('ordinary proposal insertion rejects mismatched or absent source ownership atomically', async () => {
      const proposals = new PostgresMemoryWriteProposalRepository(isolated.application)
      for (const change of [
        { workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
        {
          provenance: {
            ...memoryProposal().provenance,
            sourceExecutionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAW',
          },
        },
        {
          provenance: {
            ...memoryProposal().provenance,
            sourceAttemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAW',
          },
        },
      ]) {
        await expect(proposals.insert({ ...memoryProposal(), ...change })).rejects.toThrow(
          'MEMORY_PROPOSAL_SCOPE_MISMATCH'
        )
        expect(await proposals.list()).toEqual([])
      }
    })
    test('damaged provenance retains an identified source and unrelated provenance allows cleanup', async () => {
      const proposal = memoryProposal()
      await isolated.application.insert(memoryWriteProposals).values({
        proposalId: proposal.proposalId,
        workspaceId,
        dedupeHint: proposal.dedupeHint,
        state: proposal.state,
        version: 1,
        createdAt: new Date(acceptedAt),
        updatedAt: new Date(terminalAt),
        proposal: { provenance: { sourceExecutionId: executionId } },
      })
      const retention = new PostgresExecutionRepository(isolated.application)
      expect(
        (await retention.deleteEligibleExecutions(retentionNow, retentionOptions)).deleted
      ).toBe(0)
      for (const provenance of [
        { sourceAttemptId: attemptId },
        { sourceExecutionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAW', sourceAttemptId: attemptId },
      ]) {
        await isolated.application
          .update(memoryWriteProposals)
          .set({ proposal: { provenance } })
          .where(eq(memoryWriteProposals.proposalId, proposal.proposalId))
        const retained = await retention.deleteEligibleExecutions(retentionNow, retentionOptions)
        expect(retained.retainedByReason).toEqual({ reference_pending: 1 })
        expect(await isolated.application.select().from(executionAttempts)).toHaveLength(1)
      }
      await isolated.application
        .update(memoryWriteProposals)
        .set({
          proposal: { provenance: { sourceExecutionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAW' } },
        })
        .where(eq(memoryWriteProposals.proposalId, proposal.proposalId))
      expect(
        (await retention.deleteEligibleExecutions(retentionNow, retentionOptions)).deleted
      ).toBe(1)
    })
    test('memory references preserve usage funding parents and both delegation endpoints', async () => {
      const childId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAW'
      const fundingId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAX'
      const delegatedId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAY'
      for (const [ownerId, ownerAttemptId] of [
        [childId, 'att_01ARZ3NDEKTSV4RRFFQ69G5FAW'],
        [fundingId, 'att_01ARZ3NDEKTSV4RRFFQ69G5FAX'],
        [delegatedId, 'att_01ARZ3NDEKTSV4RRFFQ69G5FAY'],
      ])
        await seedOwner(isolated.application, ownerId, ownerAttemptId)
      await new PostgresMemoryWriteProposalRepository(isolated.application).insert(memoryProposal())
      await isolated.application.insert(usageLedgerEntries).values({
        entryId: 'usg_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        sequence: 1,
        workspaceId,
        executionId: childId,
        parentExecutionId: fundingId,
        kind: 'settlement',
        sourceId: 'memory-retention-fixture',
        idempotencyKey: 'memory-retention-funding',
        fundingSource: 'hq_managed',
        quantity: { unit: 'tokens', value: 0 },
        currency: 'USD',
        costMicrounits: 0,
        costExact: true,
        recordedAt: new Date(terminalAt),
      })
      await isolated.application.insert(delegations).values({
        delegationId: 'dlg_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        parentExecutionId: fundingId,
        childExecutionId: delegatedId,
        state: 'completed',
        revision: 1,
        inputDigest: `sha256:${'d'.repeat(64)}`,
        record: { parentExecutionId: fundingId, childExecutionId: delegatedId },
        acceptedAt: new Date(terminalAt),
        updatedAt: new Date(terminalAt),
      })
      const result = await new PostgresExecutionRepository(
        isolated.application
      ).deleteEligibleExecutions(retentionNow, retentionOptions)
      expect(result.deleted).toBe(0)
      expect(result.retainedByReason).toEqual({ reference_pending: 4 })
      expect(await isolated.application.select().from(executions)).toHaveLength(4)
      expect(await isolated.application.select().from(executionAttempts)).toHaveLength(4)
    })
    test('proposal transitions cannot move immutable source ownership or dedupe identity', async () => {
      const repository = new PostgresMemoryWriteProposalRepository(isolated.application)
      const proposal = memoryProposal()
      await repository.insert(proposal)
      for (const change of [
        { workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
        { dedupeHint: 'moved' },
        {
          provenance: {
            ...proposal.provenance,
            sourceExecutionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAW',
          },
        },
        {
          provenance: { ...proposal.provenance, sourceAttemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
        },
      ]) {
        await expect(
          repository.compareAndSet(1, { ...proposal, ...change, version: 2 })
        ).rejects.toThrow('MEMORY_PROPOSAL_IDENTITY_MISMATCH')
        expect(await repository.get(proposal.proposalId)).toEqual(proposal)
      }
    })
    test('retention claimed first excludes an orphan proposal after its source disappears', async () => {
      const entered = Promise.withResolvers()
      const release = Promise.withResolvers()
      const retention = new PostgresExecutionRepository(
        isolated.application
      ).deleteEligibleExecutions(retentionNow, {
        ...retentionOptions,
        journal: async () => {
          entered.resolve()
          await release.promise
        },
      })
      await entered.promise
      const repository = new PostgresMemoryWriteProposalRepository(isolated.application)
      const insertion = repository.insert(memoryProposal()).then(
        () => undefined,
        (error) => error
      )
      try {
        await isolated.waitForBlockedTransaction()
      } finally {
        release.resolve()
      }
      expect((await retention).deleted).toBe(1)
      expect((await insertion)?.message).toBe('MEMORY_PROPOSAL_SCOPE_MISMATCH')
      expect(await repository.list()).toEqual([])
    })
    test('proposal claimed first serializes retention until its durable reference is visible', async () => {
      const entered = Promise.withResolvers()
      const release = Promise.withResolvers()
      const repository = new PostgresMemoryWriteProposalRepository({
        transaction: (operation) =>
          isolated.application.transaction(async (transaction) => {
            const result = await operation(transaction)
            entered.resolve()
            await release.promise
            return result
          }),
      })
      const insertion = repository.insert(memoryProposal())
      await entered.promise
      const retention = new PostgresExecutionRepository(
        isolated.application
      ).deleteEligibleExecutions(retentionNow, retentionOptions)
      try {
        await isolated.waitForBlockedTransaction()
      } finally {
        release.resolve()
      }
      expect(await insertion).toBe(true)
      expect((await retention).retainedByReason).toEqual({ reference_pending: 1 })
      expect(await isolated.application.select().from(executions)).toHaveLength(1)
      expect(await isolated.application.select().from(executionAttempts)).toHaveLength(1)
    })
  }
)
