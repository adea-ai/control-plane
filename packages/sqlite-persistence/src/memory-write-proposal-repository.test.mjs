import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { ControlApiFixtures } from '@control-plane/contracts'
import { ExecutionAttemptSchema, ExecutionSchema, InteractionService } from '@control-plane/domain'
import { FakeMemoryProviderWriter, MemoryWriteService } from '@control-plane/memory-writeback'
import { SqliteInteractionRepository } from './interaction-repository.ts'
import { SqlitePersistenceProvider } from './provider.ts'
import { SqliteMemoryWriteProposalRepository } from './memory-write-proposal-repository.ts'

const now = '2026-10-03T12:00:00.000Z'
const later = '2026-10-03T12:01:00.000Z'
const proposal = {
  proposalId: 'mwp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  providerId: 'ctp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  connectionId: 'ctc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  workspaceId: ControlApiFixtures.executionAcceptance.request.workspaceId,
  scopeDigest: `sha256:${'a'.repeat(64)}`,
  memoryType: 'preference',
  content: 'Bounded preference',
  retention: 'project',
  provenance: {
    sourceExecutionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    sourceAttemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    confidence: 0.9,
    importance: 0.8,
    sensitivity: 'internal',
    evidenceRefs: [],
    artifactRefs: [],
  },
  dedupeHint: 'atomic-preference',
  contentDigest: `sha256:${createHash('sha256').update('Bounded preference').digest('hex')}`,
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
  expiresAt: '2026-10-03T13:00:00.000Z',
}

const storedId = (id) => `r-${createHash('sha256').update(id).digest('hex')}`
const acceptance = ControlApiFixtures.executionAcceptance.request

async function seedOwner(provider, executionId, attemptId) {
  const acceptedAt = '2026-09-07T00:00:00.000Z'
  const queuedAt = '2026-09-07T00:01:00.000Z'
  await provider.transaction(async (transaction) => {
    const executionKey = storedId(executionId)
    if ((await transaction.get('executions', executionKey)) === undefined)
      await transaction.put({
        namespace: 'executions',
        id: executionKey,
        value: ExecutionSchema.parse({
          executionId,
          state: 'queued',
          version: 2,
          correlation: {
            workspaceId: acceptance.workspaceId,
            projectId: acceptance.projectId,
            taskId: acceptance.payload.taskId,
            agentId: acceptance.payload.agentId,
            requestId: acceptance.requestId,
          },
          executionPlan: acceptance.payload.executionPlan,
          attemptCount: 1,
          latestAttemptId: attemptId,
          acceptedAt,
          queuedAt,
          createdAt: acceptedAt,
          updatedAt: queuedAt,
        }),
      })
    await transaction.put({
      namespace: 'execution-attempts',
      id: storedId(attemptId),
      value: ExecutionAttemptSchema.parse({
        attemptId,
        executionId,
        sequence: 1,
        state: 'queued',
        version: 1,
        acceptedAt,
        queuedAt,
        createdAt: acceptedAt,
        updatedAt: queuedAt,
      }),
    })
  })
}

function service(provider) {
  const repository = new SqliteMemoryWriteProposalRepository(provider)
  const interactions = new SqliteInteractionRepository(provider)
  const writer = new FakeMemoryProviderWriter(
    proposal.providerId,
    proposal.connectionId,
    proposal.workspaceId,
    proposal.scopeDigest
  )
  return {
    repository,
    interactions,
    writer,
    service: new MemoryWriteService({
      repository,
      interactionRepository: interactions,
      provider: writer,
      now: () => now,
    }),
  }
}
async function fixture(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'cp-memory-atomic-'))
  const path = join(directory, 'state.sqlite')
  const provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    await seedOwner(
      provider,
      proposal.provenance.sourceExecutionId,
      proposal.provenance.sourceAttemptId
    )
    await operation(provider, path)
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('SQLite concurrent approval proposals persist one linked pair across reopen', async () => {
  await fixture(async (provider, path) => {
    const context = service(provider)
    const results = await Promise.all([
      context.service.propose(proposal, policy, approval),
      context.service.propose(
        { ...proposal, proposalId: 'mwp_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
        policy,
        { ...approval, interactionId: 'int_01ARZ3NDEKTSV4RRFFQ69G5FAW' }
      ),
    ])
    expect(results[0]).toEqual(results[1])
    provider.close()
    const reopened = new SqlitePersistenceProvider({ path })
    try {
      await reopened.migrate()
      const recovered = service(reopened)
      expect(await recovered.repository.list()).toEqual([results[0]])
      expect(
        await recovered.interactions.listForAttempt(
          proposal.provenance.sourceExecutionId,
          proposal.provenance.sourceAttemptId
        )
      ).toHaveLength(1)
      const pending = await recovered.interactions.get(results[0].approvalInteractionId)
      expect(pending.prompt.detailsReference).toBe(
        `memory-write://proposal/${results[0].proposalId}`
      )
      expect(await recovered.service.propose(proposal, policy, approval)).toEqual(results[0])
    } finally {
      reopened.close()
    }
  })
})

test('SQLite rolls back a proposal when its approval interaction conflicts', async () => {
  await fixture(async (provider, path) => {
    const context = service(provider)
    await new InteractionService(context.interactions).request({
      ...approval,
      executionId: proposal.provenance.sourceExecutionId,
      attemptId: proposal.provenance.sourceAttemptId,
      kind: 'approval',
      prompt: { title: 'Different approval' },
      allowedActions: ['approve', 'deny'],
      allowedPrincipalIds: ['svc_agent-hq'],
    })
    await expect(context.service.propose(proposal, policy, approval)).rejects.toMatchObject({
      code: 'MEMORY_PROPOSAL_CONFLICT',
    })
    expect(await context.repository.list()).toEqual([])
    provider.close()
    const reopened = new SqlitePersistenceProvider({ path })
    try {
      await reopened.migrate()
      expect(await service(reopened).repository.list()).toEqual([])
    } finally {
      reopened.close()
    }
  })
})

test('SQLite rolls back both records when the transaction fails after approval insertion', async () => {
  await fixture(async (provider, path) => {
    const failing = {
      transaction: (operation) =>
        provider.transaction(async (transaction) => {
          await operation(transaction)
          throw new Error('injected-before-commit')
        }),
    }
    const context = service(failing)
    // Reads also use transactions; inject failure only into the creation operation.
    context.repository.getByDedupe = async () => undefined
    await expect(context.service.propose(proposal, policy, approval)).rejects.toThrow(
      'injected-before-commit'
    )
    provider.close()
    const reopened = new SqlitePersistenceProvider({ path })
    try {
      await reopened.migrate()
      const recovered = service(reopened)
      expect(await recovered.repository.list()).toEqual([])
      expect(await recovered.interactions.get(approval.interactionId)).toBeUndefined()
      expect(
        await recovered.interactions.listForAttempt(
          proposal.provenance.sourceExecutionId,
          proposal.provenance.sourceAttemptId
        )
      ).toEqual([])
    } finally {
      reopened.close()
    }
  })
})

test('SQLite approval creation rejects source executions from another workspace', async () => {
  await fixture(async (provider) => {
    const context = service(provider)
    const changed = { ...proposal, workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW' }
    context.writer.workspaceId = changed.workspaceId
    await expect(context.service.propose(changed, policy, approval)).rejects.toThrow(
      'MEMORY_PROPOSAL_SCOPE_MISMATCH'
    )
    expect(await context.repository.list()).toEqual([])
    expect(await context.interactions.get(approval.interactionId)).toBeUndefined()
  })
})

test('SQLite reopened committing proposals use status without repeating the provider write', async () => {
  await fixture(async (provider, path) => {
    const context = service(provider)
    const pending = await context.service.propose(proposal, policy, approval)
    await new InteractionService(context.interactions).respond({
      interactionId: pending.approvalInteractionId,
      executionId: proposal.provenance.sourceExecutionId,
      attemptId: proposal.provenance.sourceAttemptId,
      responseId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      action: 'approve',
      respondingPrincipalId: 'svc_agent-hq',
      expectedVersion: 1,
      respondedAt: later,
    })
    const approved = await context.service.applyApproval(pending.proposalId, later)
    expect(
      await context.repository.compareAndSet(approved.version, {
        ...approved,
        state: 'committing',
        version: approved.version + 1,
        updatedAt: later,
      })
    ).toBe(true)
    provider.close()
    const reopened = new SqlitePersistenceProvider({ path })
    try {
      await reopened.migrate()
      const recovered = service(reopened)
      let writes = 0
      recovered.writer.write = async () => {
        writes++
        throw new Error('unsafe-replay')
      }
      recovered.writer.status = async () => ({
        status: 'committed',
        providerMemoryRef: 'memory://confirmed-fixture',
      })
      const committed = await recovered.service.commit(pending.proposalId, later)
      expect(committed).toMatchObject({ state: 'committed', outcome: { code: 'reconciled' } })
      expect(writes).toBe(0)
      expect(await recovered.repository.compareAndSet(approved.version, approved)).toBe(false)
    } finally {
      reopened.close()
    }
  })
})
