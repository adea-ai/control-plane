import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ControlApiFixtures } from '@control-plane/contracts'
import { ExecutionSchema, ExecutionAttemptSchema, InteractionService } from '@control-plane/domain'
import { FakeMemoryProviderWriter, MemoryWriteError } from '@control-plane/memory-writeback'
import { SqliteMemoryWriteProposalRepository } from '@control-plane/sqlite-persistence'
import { LocalControlPlaneComposition } from './composition.ts'

const now = new Date(Date.now() - 1_000).toISOString()
const later = new Date().toISOString()
const input = {
  proposalId: 'mwp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  providerId: 'ctp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  connectionId: 'ctc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  workspaceId: ControlApiFixtures.executionAcceptance.request.workspaceId,
  scopeDigest: `sha256:${'a'.repeat(64)}`,
  memoryType: 'preference',
  content: 'A bounded preference',
  contentDigest: `sha256:${createHash('sha256').update('A bounded preference').digest('hex')}`,
  retention: 'project',
  dedupeHint: 'composed-preference',
  provenance: {
    sourceExecutionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    sourceAttemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    confidence: 0.9,
    importance: 0.8,
    sensitivity: 'internal',
    evidenceRefs: [],
    artifactRefs: [],
  },
}
const policy = {
  mode: 'approval_required',
  maximumBytes: 1024,
  allowedSensitivities: ['internal'],
  approvalPrincipalIds: ['svc_agent-hq'],
}
const approval = {
  interactionId: 'int_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  requestedAt: now,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}
const key = (id) => `r-${createHash('sha256').update(id).digest('hex')}`
async function seedOwner(persistence) {
  const acceptance = ControlApiFixtures.executionAcceptance.request
  await persistence.transaction(async (transaction) => {
    await transaction.put({
      namespace: 'executions',
      id: key(input.provenance.sourceExecutionId),
      value: ExecutionSchema.parse({
        executionId: input.provenance.sourceExecutionId,
        state: 'queued',
        version: 2,
        correlation: {
          workspaceId: input.workspaceId,
          projectId: acceptance.projectId,
          taskId: acceptance.payload.taskId,
          agentId: acceptance.payload.agentId,
          requestId: acceptance.requestId,
        },
        executionPlan: acceptance.payload.executionPlan,
        attemptCount: 1,
        latestAttemptId: input.provenance.sourceAttemptId,
        acceptedAt: now,
        queuedAt: later,
        createdAt: now,
        updatedAt: later,
      }),
    })
    await transaction.put({
      namespace: 'execution-attempts',
      id: key(input.provenance.sourceAttemptId),
      value: ExecutionAttemptSchema.parse({
        attemptId: input.provenance.sourceAttemptId,
        executionId: input.provenance.sourceExecutionId,
        sequence: 1,
        state: 'queued',
        version: 1,
        acceptedAt: now,
        queuedAt: later,
        createdAt: now,
        updatedAt: later,
      }),
    })
  })
}
for (const profile of ['local', 'hosted-simple']) {
  test(`${profile} composes disabled memory writes without starting a runtime`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cp-m11-memory-compose-'))
    let composition
    try {
      composition = new LocalControlPlaneComposition({ dataDirectory: directory, profile })
      await expect(composition.memoryWrites.propose(input, approval)).rejects.toMatchObject({
        code: 'MEMORY_WRITE_DISABLED',
      })
    } finally {
      composition?.persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
  test(`${profile} composed memory approval reopens SQLite and recovers an uncertain provider effect without another write`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cp-m11-memory-compose-'))
    let composition
    const writer = new FakeMemoryProviderWriter(
      input.providerId,
      input.connectionId,
      input.workspaceId,
      input.scopeDigest,
      { writeCommit: true, idempotentStatus: false },
      'timeout_after'
    )
    let writes = 0
    const write = writer.write.bind(writer)
    writer.write = async (request) => {
      writes++
      return write(request)
    }
    const operations = []
    const authority = {
      authorize: async (_scope, operation) => {
        operations.push(operation)
        if (operation === 'write' && !writer.capabilities.writeCommit)
          throw new MemoryWriteError('MEMORY_WRITE_AUTHORITY_DENIED')
      },
    }
    try {
      composition = new LocalControlPlaneComposition({
        dataDirectory: directory,
        profile,
        memoryWriteback: { policy, provider: writer, authority },
      })
      await composition.persistence.migrate()
      await seedOwner(composition.persistence)
      const pending = await composition.memoryWrites.propose(input, approval)
      expect(await composition.interactions.get(pending.approvalInteractionId)).toBeDefined()
      await new InteractionService(composition.interactions).respond({
        interactionId: pending.approvalInteractionId,
        executionId: input.provenance.sourceExecutionId,
        attemptId: input.provenance.sourceAttemptId,
        responseId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        action: 'approve',
        respondingPrincipalId: 'svc_agent-hq',
        expectedVersion: 1,
        respondedAt: later,
      })
      await composition.memoryWrites.applyApproval(pending.proposalId, later)
      await expect(
        composition.memoryWrites.commit(pending.proposalId, later)
      ).rejects.toMatchObject({ code: 'MEMORY_WRITE_AMBIGUOUS' })
      expect(
        (
          await new SqliteMemoryWriteProposalRepository(composition.persistence).get(
            pending.proposalId
          )
        ).state
      ).toBe('reconciliation_required')
      composition.persistence.close()
      writer.capabilities.writeCommit = false
      writer.capabilities.idempotentStatus = true
      composition = new LocalControlPlaneComposition({
        dataDirectory: directory,
        profile,
        memoryWriteback: { policy: { ...policy, mode: 'disabled' }, provider: writer, authority },
      })
      await composition.persistence.migrate()
      expect((await composition.memoryWrites.commit(pending.proposalId, later)).outcome.code).toBe(
        'reconciled'
      )
      expect(writes).toBe(1)
      expect(writer.records.size).toBe(1)
      expect(operations).toEqual(['proposal', 'write', 'status'])
    } finally {
      composition?.persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}
