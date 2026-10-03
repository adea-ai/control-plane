import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { InMemoryInteractionRepository, InteractionService } from '@control-plane/domain'
import {
  FakeMemoryProviderWriter,
  InMemoryMemoryWriteProposalRepository,
  MemoryWriteService,
} from './index.ts'

const now = '2026-08-25T12:00:00.000Z'
const later = '2026-08-25T12:01:00.000Z'
const providerId = 'ctp_01JABCDEF0123456789ABCDEFG'
const connectionId = 'ctc_01JABCDEF0123456789ABCDEFG'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const scopeDigest = `sha256:${'a'.repeat(64)}`

describe('provider-neutral memory write proposals', () => {
  test('concurrent readers never observe an approval without its proposal', async () => {
    const context = harness(provider())
    const creation = context.service.propose(
      proposal(),
      policy({ mode: 'approval_required' }),
      approval()
    )
    const observations = []
    for (let index = 0; index < 32; index++) {
      const [request, stored] = await Promise.all([
        context.interactions.get(approval().interactionId),
        context.repository.get(proposal().proposalId),
      ])
      observations.push({ request: Boolean(request), proposal: Boolean(stored) })
    }
    await creation
    expect(observations).not.toContainEqual({ request: true, proposal: false })
    expect(observations).toContainEqual({ request: true, proposal: true })
  })

  test('concurrent approval proposals create exactly one linked interaction', async () => {
    const context = harness(provider())
    let arrivals = 0
    let release
    const bothRead = new Promise((resolve) => {
      release = resolve
    })
    context.repository.getByDedupe = async () => {
      arrivals += 1
      if (arrivals <= 2) {
        if (arrivals === 2) release()
        await bothRead
        return undefined
      }
      return (await context.repository.list())[0]
    }
    const results = await Promise.all([
      context.service.propose(proposal(), policy({ mode: 'approval_required' }), approval()),
      context.service.propose(
        proposal({ proposalId: 'mwp_01JBBCDEF0123456789ABCDEFG' }),
        policy({ mode: 'approval_required' }),
        approval({ interactionId: 'int_01JBBCDEF0123456789ABCDEFG' })
      ),
    ])
    expect(results[0]).toEqual(results[1])
    expect(await context.repository.list()).toHaveLength(1)
    const requests = await context.interactions.listForAttempt(
      results[0].provenance.sourceExecutionId,
      results[0].provenance.sourceAttemptId
    )
    expect(requests).toHaveLength(1)
    expect(requests[0].interactionId).toBe(results[0].approvalInteractionId)
  })

  test('approval creation fails closed without atomic persistence', async () => {
    const context = harness(provider())
    context.repository.insertWithApproval = undefined
    await expect(
      context.service.propose(proposal(), policy({ mode: 'approval_required' }), approval())
    ).rejects.toMatchObject({ code: 'MEMORY_APPROVAL_ATOMICITY_UNAVAILABLE' })
    expect(await context.repository.list()).toEqual([])
    expect(await context.interactions.get(approval().interactionId)).toBeUndefined()
  })

  test('rejects absent and read-only providers while ordinary execution remains independent', async () => {
    await expect(harness(undefined).service.propose(proposal(), policy())).rejects.toMatchObject({
      code: 'MEMORY_PROVIDER_ABSENT',
    })
    const readOnly = provider('success', { writeCommit: false, idempotentStatus: false })
    await expect(harness(readOnly).service.propose(proposal(), policy())).rejects.toMatchObject({
      code: 'MEMORY_PROVIDER_READ_ONLY',
    })
  })

  test('keeps proposals non-canonical and deduplicates duplicate delivery', async () => {
    const writer = provider()
    const { service, repository } = harness(writer)
    const first = await service.propose(proposal(), policy())
    const duplicate = await service.propose(proposal(), policy())
    expect(first.state).toBe('proposed')
    expect(duplicate).toEqual(first)
    expect(await repository.list()).toHaveLength(1)
    expect(writer.records.size).toBe(0)
    expect(first).not.toHaveProperty('providerMemoryRef')
    await expect(service.commit(first.proposalId, later)).rejects.toMatchObject({
      code: 'MEMORY_APPROVAL_REQUIRED',
    })
  })

  test('deduplicates only identical immutable proposal inputs, ignoring proposal identity', async () => {
    const context = harness(provider())
    const first = await context.service.propose(proposal(), policy())
    const replay = await context.service.propose(
      proposal({ proposalId: 'mwp_01JBBCDEF0123456789ABCDEFG' }),
      policy()
    )
    expect(replay).toEqual(first)

    const conflictingInputs = [
      { retention: 'session' },
      { memoryType: 'fact' },
      { provenance: { ...proposal().provenance, confidence: 0.7 } },
      { provenance: { ...proposal().provenance, evidenceRefs: ['artifact://evidence/2'] } },
    ]
    for (const changed of conflictingInputs) {
      await expect(
        context.service.propose(
          proposal({ proposalId: 'mwp_01JBBCDEF0123456789ABCDEFG', ...changed }),
          policy()
        )
      ).rejects.toMatchObject({ code: 'MEMORY_PROPOSAL_CONFLICT' })
    }

    const alternateProviderId = 'ctp_01JBBCDEF0123456789ABCDEFG'
    const alternateConnectionId = 'ctc_01JBBCDEF0123456789ABCDEFG'
    const alternateScopeDigest = `sha256:${'b'.repeat(64)}`
    const alternateProvider = new FakeMemoryProviderWriter(
      alternateProviderId,
      alternateConnectionId,
      workspaceId,
      alternateScopeDigest
    )
    const alternateService = new MemoryWriteService({
      repository: context.repository,
      interactionRepository: context.interactions,
      provider: alternateProvider,
      now: () => now,
    })
    await expect(
      alternateService.propose(
        proposal({
          proposalId: 'mwp_01JBBCDEF0123456789ABCDEFG',
          providerId: alternateProviderId,
          connectionId: alternateConnectionId,
          scopeDigest: alternateScopeDigest,
        }),
        policy()
      )
    ).rejects.toMatchObject({ code: 'MEMORY_PROPOSAL_CONFLICT' })
    expect(await context.repository.list()).toEqual([first])
  })

  test('concurrent conflicting intent cannot create a second deduplicated proposal', async () => {
    const conflicting = harness(provider())
    const outcomes = await Promise.allSettled([
      conflicting.service.propose(proposal(), policy()),
      conflicting.service.propose(
        proposal({ proposalId: 'mwp_01JBBCDEF0123456789ABCDEFG', retention: 'session' }),
        policy()
      ),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
    expect(rejected.reason).toMatchObject({ code: 'MEMORY_PROPOSAL_CONFLICT' })
    expect(await conflicting.repository.list()).toHaveLength(1)
  })

  test('concurrent identical delivery converges on the inserted dedupe winner', async () => {
    const context = harness(provider())
    const outcomes = await Promise.all([
      context.service.propose(proposal(), policy()),
      context.service.propose(proposal({ proposalId: 'mwp_01JBBCDEF0123456789ABCDEFG' }), policy()),
    ])

    expect(outcomes[0]).toEqual(outcomes[1])
    expect(await context.repository.list()).toEqual([outcomes[0]])
  })

  test('uses durable approval, denial, expiry, and revocation lifecycles', async () => {
    const approved = harness(provider())
    const pending = await approved.service.propose(
      proposal(),
      policy({ mode: 'approval_required' }),
      approval()
    )
    expect(pending.state).toBe('awaiting_approval')
    const interactions = new InteractionService(approved.interactions)
    await interactions.respond({
      interactionId: approval().interactionId,
      executionId: proposal().provenance.sourceExecutionId,
      attemptId: proposal().provenance.sourceAttemptId,
      responseId: 'cmd_01JABCDEF0123456789ABCDEFG',
      action: 'approve',
      respondingPrincipalId: 'principal:test:approver',
      expectedVersion: 1,
      respondedAt: later,
    })
    expect((await approved.service.applyApproval(pending.proposalId, later)).state).toBe('approved')
    expect((await approved.service.revoke(pending.proposalId, later)).outcome.code).toBe('revoked')

    const denied = harness(provider())
    const deniedProposal = await denied.service.propose(
      proposal({ proposalId: 'mwp_01JBBCDEF0123456789ABCDEFG', dedupeHint: 'deny' }),
      policy({ mode: 'approval_required' }),
      approval({ interactionId: 'int_01JBBCDEF0123456789ABCDEFG' })
    )
    await new InteractionService(denied.interactions).respond({
      interactionId: deniedProposal.approvalInteractionId,
      executionId: deniedProposal.provenance.sourceExecutionId,
      attemptId: deniedProposal.provenance.sourceAttemptId,
      responseId: 'cmd_01JBBCDEF0123456789ABCDEFG',
      action: 'deny',
      respondingPrincipalId: 'principal:test:approver',
      expectedVersion: 1,
      respondedAt: later,
    })
    expect((await denied.service.applyApproval(deniedProposal.proposalId, later)).state).toBe(
      'denied'
    )

    const expired = harness(provider())
    const expiredProposal = await expired.service.propose(
      proposal({ proposalId: 'mwp_01JCCDEF0123456789ABCDEFGH', dedupeHint: 'expire' }),
      policy({ mode: 'approval_required' }),
      approval({ interactionId: 'int_01JCCDEF0123456789ABCDEFGH' })
    )
    await new InteractionService(expired.interactions).expire(
      expiredProposal.approvalInteractionId,
      '2026-08-25T12:11:00.000Z'
    )
    expect(
      (await expired.service.applyApproval(expiredProposal.proposalId, '2026-08-25T12:11:00.000Z'))
        .state
    ).toBe('expired')
  })

  test('approval replay cannot revive revoked or committed proposals', async () => {
    const revokedContext = harness(provider())
    const approved = await prepareApproved(revokedContext)
    const revoked = await revokedContext.service.revoke(approved.proposalId, later)
    await expect(
      revokedContext.service.applyApproval(approved.proposalId, later)
    ).rejects.toMatchObject({ code: 'MEMORY_PROPOSAL_TERMINAL' })
    expect(await revokedContext.repository.get(approved.proposalId)).toEqual(revoked)

    const committedContext = harness(provider())
    const approvedBeforeCommit = await prepareApproved(committedContext)
    const committed = await committedContext.service.commit(approvedBeforeCommit.proposalId, later)
    await expect(
      committedContext.service.applyApproval(approvedBeforeCommit.proposalId, later)
    ).rejects.toMatchObject({ code: 'MEMORY_PROPOSAL_TERMINAL' })
    expect(await committedContext.repository.get(approvedBeforeCommit.proposalId)).toEqual(
      committed
    )
  })

  test('reapplying an already applied approval decision is idempotent', async () => {
    const context = harness(provider())
    const approved = await prepareApproved(context)
    expect(await context.service.applyApproval(approved.proposalId, later)).toEqual(approved)
    expect(await context.repository.get(approved.proposalId)).toEqual(approved)
  })

  test('commits with one stable idempotent effect and reconciles timeout-after-effect', async () => {
    const direct = harness(provider())
    const proposed = await prepareApproved(direct)
    const committed = await direct.service.commit(proposed.proposalId, later)
    expect(committed).toMatchObject({ state: 'committed', outcome: { code: 'committed' } })
    expect(await direct.service.commit(proposed.proposalId, later)).toEqual(committed)
    expect(direct.provider.records.size).toBe(1)

    const after = harness(provider('timeout_after'))
    const afterProposal = await prepareApproved(after, {
      proposalId: 'mwp_01JBBCDEF0123456789ABCDEFG',
      dedupeHint: 'after',
    })
    expect(await after.service.commit(afterProposal.proposalId, later)).toMatchObject({
      state: 'committed',
      outcome: { code: 'reconciled' },
    })
    expect(after.provider.records.size).toBe(1)
  })

  test('durably records rejection and ambiguous non-effects for reconciliation', async () => {
    const rejected = harness(provider('reject'))
    const rejectedProposal = await prepareApproved(rejected)
    await expect(rejected.service.commit(rejectedProposal.proposalId, later)).rejects.toMatchObject(
      {
        code: 'MEMORY_WRITE_REJECTED',
      }
    )
    expect((await rejected.repository.get(rejectedProposal.proposalId)).state).toBe('failed')

    const before = harness(provider('timeout_before'))
    const beforeProposal = await prepareApproved(before, {
      proposalId: 'mwp_01JBBCDEF0123456789ABCDEFG',
      dedupeHint: 'before',
    })
    await expect(before.service.commit(beforeProposal.proposalId, later)).rejects.toMatchObject({
      code: 'MEMORY_WRITE_AMBIGUOUS',
    })
    expect(await before.repository.get(beforeProposal.proposalId)).toMatchObject({
      state: 'reconciliation_required',
      outcome: { code: 'ambiguous' },
    })
    expect(before.provider.records.size).toBe(0)

    const nonIdempotent = harness(
      provider('ambiguous', { writeCommit: true, idempotentStatus: false })
    )
    let writeCount = 0
    const write = nonIdempotent.provider.write.bind(nonIdempotent.provider)
    nonIdempotent.provider.write = async (request) => {
      writeCount += 1
      return write(request)
    }
    const ambiguousProposal = await prepareApproved(nonIdempotent)
    await expect(
      nonIdempotent.service.commit(ambiguousProposal.proposalId, later)
    ).rejects.toMatchObject({ code: 'MEMORY_WRITE_AMBIGUOUS' })
    expect(await nonIdempotent.repository.get(ambiguousProposal.proposalId)).toMatchObject({
      state: 'reconciliation_required',
      outcome: { code: 'ambiguous' },
    })
    expect(writeCount).toBe(1)
    await expect(
      nonIdempotent.service.commit(ambiguousProposal.proposalId, later)
    ).rejects.toMatchObject({ code: 'MEMORY_WRITE_AMBIGUOUS' })
    expect(writeCount).toBe(1)
    expect(await nonIdempotent.repository.get(ambiguousProposal.proposalId)).toMatchObject({
      state: 'reconciliation_required',
      outcome: { code: 'ambiguous' },
    })
  })

  test('reconciles an ambiguous idempotent write through status without replaying the effect', async () => {
    const context = harness(provider('ambiguous'))
    let writeCount = 0
    const write = context.provider.write.bind(context.provider)
    context.provider.write = async (request) => {
      writeCount += 1
      return write(request)
    }
    let status = { status: 'unknown' }
    context.provider.status = async () => status
    let rejectNextTransition = false
    const compareAndSet = context.repository.compareAndSet.bind(context.repository)
    context.repository.compareAndSet = async (expectedVersion, next) => {
      if (rejectNextTransition) {
        rejectNextTransition = false
        return false
      }
      return compareAndSet(expectedVersion, next)
    }
    const prepared = await prepareApproved(context)

    await expect(context.service.commit(prepared.proposalId, later)).rejects.toMatchObject({
      code: 'MEMORY_WRITE_AMBIGUOUS',
    })
    expect(writeCount).toBe(1)
    status = { status: 'committed', providerMemoryRef: 'memory://reconciled' }
    rejectNextTransition = true

    await expect(context.service.commit(prepared.proposalId, later)).rejects.toMatchObject({
      code: 'MEMORY_PROPOSAL_CONFLICT',
    })
    expect(writeCount).toBe(1)
    expect((await context.repository.get(prepared.proposalId)).state).toBe(
      'reconciliation_required'
    )

    expect(await context.service.commit(prepared.proposalId, later)).toMatchObject({
      state: 'committed',
      outcome: { code: 'reconciled', providerMemoryRef: 'memory://reconciled' },
    })
    expect(writeCount).toBe(1)
  })

  test('reconciles a persisted committing proposal after expiry using provider status only', async () => {
    const context = harness(provider())
    const expiredAt = '2026-08-25T12:00:30.000Z'
    const prepared = await prepareApproved(context, {
      provenance: { ...proposal().provenance, expiresAt: expiredAt },
    })
    await seedCommitting(context, prepared)
    let writeCount = 0
    let statusCount = 0
    context.provider.write = async () => {
      writeCount += 1
      return { status: 'committed', providerMemoryRef: 'memory://new-write' }
    }
    context.provider.status = async () => {
      statusCount += 1
      return { status: 'committed', providerMemoryRef: 'memory://recovered' }
    }

    await expect(context.service.commit(prepared.proposalId, later)).resolves.toMatchObject({
      state: 'committed',
      outcome: { code: 'reconciled', providerMemoryRef: 'memory://recovered' },
    })
    expect(statusCount).toBe(1)
    expect(writeCount).toBe(0)
  })

  test('status-only recovery works for a read-only matching provider', async () => {
    for (const state of ['committing', 'reconciliation_required']) {
      const context = harness(provider())
      const prepared = await prepareApproved(context)
      await seedInFlight(context, prepared, state)
      context.provider.capabilities.writeCommit = false
      let statusCount = 0
      let writeCount = 0
      context.provider.status = async () => {
        statusCount += 1
        return { status: 'committed', providerMemoryRef: `memory://recovered-${state}` }
      }
      context.provider.write = async () => {
        writeCount += 1
        return { status: 'committed', providerMemoryRef: 'memory://unsafe-replay' }
      }

      await expect(context.service.commit(prepared.proposalId, later)).resolves.toMatchObject({
        state: 'committed',
        outcome: { code: 'reconciled', providerMemoryRef: `memory://recovered-${state}` },
      })
      expect(statusCount).toBe(1)
      expect(writeCount).toBe(0)
    }

    const readOnlyProvider = provider('success', { writeCommit: false, idempotentStatus: true })
    const proposalContext = harness(readOnlyProvider)
    await expect(proposalContext.service.propose(proposal(), policy())).rejects.toMatchObject({
      code: 'MEMORY_PROVIDER_READ_ONLY',
    })

    const approvedContext = harness(provider())
    const approved = await prepareApproved(approvedContext)
    approvedContext.provider.capabilities.writeCommit = false
    let freshWriteCount = 0
    approvedContext.provider.write = async () => {
      freshWriteCount += 1
      return { status: 'committed', providerMemoryRef: 'memory://not-allowed' }
    }
    await expect(approvedContext.service.commit(approved.proposalId, later)).rejects.toMatchObject({
      code: 'MEMORY_PROVIDER_READ_ONLY',
    })
    expect(await approvedContext.repository.get(approved.proposalId)).toEqual(approved)
    expect(freshWriteCount).toBe(0)
  })

  test('parks unknown, unavailable, and unsupported status for persisted commits without replay', async () => {
    const unknown = harness(provider())
    const prepared = await prepareApproved(unknown)
    await seedCommitting(unknown, prepared)
    let writeCount = 0
    let statusCount = 0
    unknown.provider.write = async () => {
      writeCount += 1
      return { status: 'committed', providerMemoryRef: 'memory://unsafe-replay' }
    }
    unknown.provider.status = async () => {
      statusCount += 1
      return { status: 'unknown' }
    }

    await expect(unknown.service.commit(prepared.proposalId, later)).rejects.toMatchObject({
      code: 'MEMORY_WRITE_AMBIGUOUS',
    })
    const parked = await unknown.repository.get(prepared.proposalId)
    expect(parked).toMatchObject({
      state: 'reconciliation_required',
      outcome: { code: 'ambiguous' },
    })
    expect(statusCount).toBe(1)
    expect(writeCount).toBe(0)

    unknown.provider.status = async () => {
      throw new Error('fixture status unavailable')
    }
    await expect(unknown.service.commit(prepared.proposalId, later)).rejects.toMatchObject({
      code: 'MEMORY_WRITE_AMBIGUOUS',
    })
    expect(await unknown.repository.get(prepared.proposalId)).toEqual(parked)
    expect(writeCount).toBe(0)

    const rejected = harness(provider())
    const rejectedProposal = await prepareApproved(rejected)
    await seedCommitting(rejected, rejectedProposal)
    let rejectedWriteCount = 0
    rejected.provider.write = async () => {
      rejectedWriteCount += 1
      return { status: 'committed', providerMemoryRef: 'memory://unsafe-replay' }
    }
    rejected.provider.status = async () => ({ status: 'rejected' })
    await expect(rejected.service.commit(rejectedProposal.proposalId, later)).rejects.toMatchObject(
      { code: 'MEMORY_WRITE_REJECTED' }
    )
    expect(await rejected.repository.get(rejectedProposal.proposalId)).toMatchObject({
      state: 'failed',
      outcome: { code: 'failed' },
    })
    expect(rejectedWriteCount).toBe(0)

    const unsupported = harness(provider('success', { writeCommit: true, idempotentStatus: false }))
    const unsupportedProposal = await prepareApproved(unsupported)
    await seedCommitting(unsupported, unsupportedProposal)
    let unsupportedStatusCount = 0
    let unsupportedWriteCount = 0
    unsupported.provider.status = async () => {
      unsupportedStatusCount += 1
      return { status: 'unknown' }
    }
    unsupported.provider.write = async () => {
      unsupportedWriteCount += 1
      return { status: 'committed', providerMemoryRef: 'memory://unsafe-replay' }
    }
    await expect(
      unsupported.service.commit(unsupportedProposal.proposalId, later)
    ).rejects.toMatchObject({ code: 'MEMORY_WRITE_AMBIGUOUS' })
    expect(await unsupported.repository.get(unsupportedProposal.proposalId)).toMatchObject({
      state: 'reconciliation_required',
      outcome: { code: 'ambiguous' },
    })
    expect(unsupportedStatusCount).toBe(0)
    expect(unsupportedWriteCount).toBe(0)
  })

  test('concurrent committing recovery uses status and rejects a stale compare-and-set', async () => {
    const context = harness(provider())
    const prepared = await prepareApproved(context)
    await seedCommitting(context, prepared)
    let releaseStatuses
    const statusesEntered = new Promise((resolve) => {
      releaseStatuses = resolve
    })
    let statusCount = 0
    let writeCount = 0
    context.provider.status = async () => {
      statusCount += 1
      if (statusCount === 2) releaseStatuses()
      await statusesEntered
      return { status: 'committed', providerMemoryRef: 'memory://recovered' }
    }
    context.provider.write = async () => {
      writeCount += 1
      return { status: 'committed', providerMemoryRef: 'memory://unsafe-replay' }
    }

    const outcomes = await Promise.allSettled([
      context.service.commit(prepared.proposalId, later),
      context.service.commit(prepared.proposalId, later),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find((outcome) => outcome.status === 'rejected').reason).toMatchObject({
      code: 'MEMORY_PROPOSAL_CONFLICT',
    })
    expect(await context.repository.get(prepared.proposalId)).toMatchObject({
      state: 'committed',
      outcome: { code: 'reconciled', providerMemoryRef: 'memory://recovered' },
    })
    expect(statusCount).toBe(2)
    expect(writeCount).toBe(0)
  })

  test('commit does not expire unapproved or terminal proposals', async () => {
    const proposedContext = harness(provider())
    const proposed = await proposedContext.service.propose(
      proposal({ provenance: { ...proposal().provenance, expiresAt: '2026-08-25T12:00:30.000Z' } }),
      policy()
    )
    await expect(proposedContext.service.commit(proposed.proposalId, later)).rejects.toMatchObject({
      code: 'MEMORY_APPROVAL_REQUIRED',
    })
    expect(await proposedContext.repository.get(proposed.proposalId)).toMatchObject({
      state: 'proposed',
    })

    const revokedContext = harness(provider())
    const approvedToRevoke = await prepareApproved(revokedContext, {
      provenance: { ...proposal().provenance, expiresAt: '2026-08-25T12:00:30.000Z' },
    })
    await revokedContext.service.revoke(approvedToRevoke.proposalId, later)
    await expect(
      revokedContext.service.commit(approvedToRevoke.proposalId, later)
    ).rejects.toMatchObject({ code: 'MEMORY_PROPOSAL_TERMINAL' })
    expect(await revokedContext.repository.get(approvedToRevoke.proposalId)).toMatchObject({
      state: 'revoked',
      outcome: { code: 'revoked' },
    })

    const deniedContext = harness(provider())
    const pendingDenial = await deniedContext.service.propose(
      proposal({
        proposalId: 'mwp_01JBBCDEF0123456789ABCDEFG',
        dedupeHint: 'denied-expired',
        provenance: { ...proposal().provenance, expiresAt: '2026-08-25T12:00:30.000Z' },
      }),
      policy({ mode: 'approval_required' }),
      approval({ interactionId: 'int_01JBBCDEF0123456789ABCDEFG' })
    )
    await new InteractionService(deniedContext.interactions).respond({
      interactionId: pendingDenial.approvalInteractionId,
      executionId: pendingDenial.provenance.sourceExecutionId,
      attemptId: pendingDenial.provenance.sourceAttemptId,
      responseId: 'cmd_01JBBCDEF0123456789ABCDEFG',
      action: 'deny',
      respondingPrincipalId: 'principal:test:approver',
      expectedVersion: 1,
      respondedAt: later,
    })
    const denied = await deniedContext.service.applyApproval(pendingDenial.proposalId, later)
    await expect(deniedContext.service.commit(denied.proposalId, later)).rejects.toMatchObject({
      code: 'MEMORY_PROPOSAL_TERMINAL',
    })
    expect(await deniedContext.repository.get(denied.proposalId)).toMatchObject({
      state: 'denied',
      outcome: { code: 'denied' },
    })

    const failedContext = harness(provider('reject'))
    const approvedToFail = await prepareApproved(failedContext, {
      proposalId: 'mwp_01JBBCDEF0123456789ABCDEFG',
      dedupeHint: 'failed-expired',
      provenance: { ...proposal().provenance, expiresAt: '2026-08-25T12:01:30.000Z' },
    })
    await expect(
      failedContext.service.commit(approvedToFail.proposalId, '2026-08-25T12:01:15.000Z')
    ).rejects.toMatchObject({ code: 'MEMORY_WRITE_REJECTED' })
    await expect(
      failedContext.service.commit(approvedToFail.proposalId, '2026-08-25T12:02:00.000Z')
    ).rejects.toMatchObject({ code: 'MEMORY_PROPOSAL_TERMINAL' })
    expect(await failedContext.repository.get(approvedToFail.proposalId)).toMatchObject({
      state: 'failed',
      outcome: { code: 'failed' },
    })
  })

  test('fails a status-rejected reconciliation without replaying the write', async () => {
    const context = harness(provider('ambiguous'))
    let writeCount = 0
    const write = context.provider.write.bind(context.provider)
    context.provider.write = async (request) => {
      writeCount += 1
      return write(request)
    }
    let status = { status: 'unknown' }
    context.provider.status = async () => status
    const prepared = await prepareApproved(context)
    await expect(context.service.commit(prepared.proposalId, later)).rejects.toMatchObject({
      code: 'MEMORY_WRITE_AMBIGUOUS',
    })
    const parked = await context.repository.get(prepared.proposalId)
    status = { status: 'rejected' }

    await expect(context.service.commit(prepared.proposalId, later)).rejects.toMatchObject({
      code: 'MEMORY_WRITE_REJECTED',
    })
    expect(writeCount).toBe(1)
    expect(await context.repository.get(prepared.proposalId)).toMatchObject({
      state: 'failed',
      version: parked.version + 1,
      outcome: { code: 'failed' },
    })
  })

  test('keeps unknown and unavailable status reconciliation parked without replay', async () => {
    const context = harness(provider('ambiguous'))
    let writeCount = 0
    const write = context.provider.write.bind(context.provider)
    context.provider.write = async (request) => {
      writeCount += 1
      return write(request)
    }
    context.provider.status = async () => ({ status: 'unknown' })
    const prepared = await prepareApproved(context)
    await expect(context.service.commit(prepared.proposalId, later)).rejects.toMatchObject({
      code: 'MEMORY_WRITE_AMBIGUOUS',
    })
    const parked = await context.repository.get(prepared.proposalId)

    await expect(context.service.commit(prepared.proposalId, later)).rejects.toMatchObject({
      code: 'MEMORY_WRITE_AMBIGUOUS',
    })
    expect(writeCount).toBe(1)
    expect(await context.repository.get(prepared.proposalId)).toEqual(parked)

    context.provider.status = async () => {
      throw new Error('status unavailable')
    }
    await expect(context.service.commit(prepared.proposalId, later)).rejects.toMatchObject({
      code: 'MEMORY_WRITE_AMBIGUOUS',
    })
    expect(writeCount).toBe(1)
    expect(await context.repository.get(prepared.proposalId)).toEqual(parked)
  })

  test('rejects cross-scope authority, unbounded content, source documents, and conflicting dedupe', async () => {
    const { service } = harness(provider())
    await expect(
      service.propose(proposal({ scopeDigest: `sha256:${'d'.repeat(64)}` }), policy())
    ).rejects.toMatchObject({ code: 'MEMORY_SCOPE_MISMATCH' })
    await expect(
      service.propose(proposal({ workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG' }), policy())
    ).rejects.toMatchObject({ code: 'MEMORY_SCOPE_MISMATCH' })
    await expect(
      service.propose(proposal({ content: 'full transcript: private' }), policy())
    ).rejects.toMatchObject({ code: 'MEMORY_CONTENT_NOT_ALLOWED' })
    const oversized = 'x'.repeat(1_025)
    await expect(
      service.propose(
        proposal({ content: oversized, contentDigest: digest(oversized), dedupeHint: 'oversized' }),
        policy()
      )
    ).rejects.toMatchObject({ code: 'MEMORY_CONTENT_NOT_ALLOWED' })
    await service.propose(proposal(), policy())
    await expect(
      service.propose(
        proposal({
          proposalId: 'mwp_01JBBCDEF0123456789ABCDEFG',
          content: 'different',
          contentDigest: digest('different'),
        }),
        policy()
      )
    ).rejects.toMatchObject({ code: 'MEMORY_PROPOSAL_CONFLICT' })
  })
})

function harness(writer) {
  const interactions = new InMemoryInteractionRepository()
  const repository = new InMemoryMemoryWriteProposalRepository(interactions)
  return {
    repository,
    interactions,
    provider: writer,
    service: new MemoryWriteService({
      repository,
      interactionRepository: interactions,
      now: () => now,
      ...(writer ? { provider: writer } : {}),
    }),
  }
}

function provider(
  behavior = 'success',
  capabilities = { writeCommit: true, idempotentStatus: true }
) {
  return new FakeMemoryProviderWriter(
    providerId,
    connectionId,
    workspaceId,
    scopeDigest,
    capabilities,
    behavior
  )
}

async function prepareApproved(context, overrides = {}) {
  const proposed = await context.service.propose(
    proposal(overrides),
    policy({ mode: 'approval_required' }),
    approval()
  )
  await new InteractionService(context.interactions).respond({
    interactionId: proposed.approvalInteractionId,
    executionId: proposed.provenance.sourceExecutionId,
    attemptId: proposed.provenance.sourceAttemptId,
    responseId: 'cmd_01JABCDEF0123456789ABCDEFG',
    action: 'approve',
    respondingPrincipalId: 'principal:test:approver',
    expectedVersion: 1,
    respondedAt: later,
  })
  return context.service.applyApproval(proposed.proposalId, later)
}

async function seedCommitting(context, approved) {
  const committing = {
    ...approved,
    state: 'committing',
    version: approved.version + 1,
    updatedAt: later,
  }
  expect(await context.repository.compareAndSet(approved.version, committing)).toBe(true)
  return committing
}

async function seedInFlight(context, approved, state) {
  const inFlight = {
    ...approved,
    state,
    version: approved.version + 1,
    updatedAt: later,
    ...(state === 'reconciliation_required'
      ? { outcome: { code: 'ambiguous', observedAt: later } }
      : {}),
  }
  expect(await context.repository.compareAndSet(approved.version, inFlight)).toBe(true)
  return inFlight
}

function proposal(overrides = {}) {
  const content = overrides.content ?? 'Remember the release checklist preference.'
  return {
    proposalId: 'mwp_01JABCDEF0123456789ABCDEFG',
    providerId,
    connectionId,
    workspaceId,
    scopeDigest,
    memoryType: 'preference',
    content,
    retention: 'durable',
    provenance: {
      sourceExecutionId: 'exe_01JABCDEF0123456789ABCDEFG',
      sourceAttemptId: 'att_01JABCDEF0123456789ABCDEFG',
      confidence: 0.9,
      importance: 0.8,
      sensitivity: 'internal',
      evidenceRefs: ['artifact://evidence/1'],
      artifactRefs: ['art_01JABCDEF0123456789ABCDEFG'],
    },
    dedupeHint: 'preference:release-checklist',
    contentDigest: digest(content),
    createdAt: now,
    ...overrides,
  }
}

function policy(overrides = {}) {
  return {
    mode: 'proposal_only',
    maximumBytes: 1_024,
    allowedSensitivities: ['internal'],
    approvalPrincipalIds: ['principal:test:approver'],
    ...overrides,
  }
}

function approval(overrides = {}) {
  return {
    interactionId: 'int_01JABCDEF0123456789ABCDEFG',
    requestedAt: now,
    expiresAt: '2026-08-25T12:10:00.000Z',
    ...overrides,
  }
}

function digest(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}
