import { describe, expect, test } from 'bun:test'
import {
  InMemoryProjectStateRepository,
  InMemoryStatePromotionProposalRepository,
  ProjectStateConflict,
  ProjectStateOperationSchema,
  ProjectStateService,
  RecordingProjectStateEventPublisher,
} from './index.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const projectId = 'prj_01JABCDEF0123456789ABCDEFG'
const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
const now = '2026-08-23T12:00:00.000Z'
const later = '2026-08-23T13:00:00.000Z'

describe('revisioned ProjectState and promotion proposals', () => {
  test('allows only one conflicting writer at an expected revision', async () => {
    const { service } = setup()
    await service.initialize({ workspaceId, projectId, at: now })
    const first = service.applyMutation(
      mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
        appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
      ])
    )
    const second = service.applyMutation(
      mutation('stm_01JBBCDEF0123456789ABCDEFG', 0, [
        appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'replace M2'),
      ])
    )
    const results = await Promise.allSettled([first, second])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejection = results.find((result) => result.status === 'rejected')
    expect(rejection.reason).toBeInstanceOf(ProjectStateConflict)
    expect(rejection.reason).toMatchObject({
      code: 'STALE_REVISION',
      expectedRevision: 0,
      currentRevision: 1,
      conflictingItemIds: ['psi_01JABCDEF0123456789ABCDEFG'],
    })
  })

  test('merges disjoint stale appends deterministically', async () => {
    const { service } = setup()
    await service.initialize({ workspaceId, projectId, at: now })
    await service.applyMutation(
      mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
        appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
      ])
    )
    const merged = await service.applyMutation(
      mutation('stm_01JBBCDEF0123456789ABCDEFG', 0, [
        appendItem('psi_01JBBCDEF0123456789ABCDEFG', 'owner', 'platform'),
      ])
    )

    expect(merged.state.revision).toBe(2)
    expect(merged.state.items.map((item) => item.key)).toEqual(['goal', 'owner'])
  })

  test('retries identical appends without another revision or event', async () => {
    const { service, events } = setup()
    await service.initialize({ workspaceId, projectId, at: now })
    const input = mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
      appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
    ])
    const first = await service.applyMutation(input)
    const retry = await service.applyMutation(input)

    expect(first.applied).toBe(true)
    expect(retry.applied).toBe(false)
    expect(retry.state.revision).toBe(1)
    expect(events.events).toHaveLength(1)

    const concurrent = setup()
    await concurrent.service.initialize({ workspaceId, projectId, at: now })
    const attempts = await Promise.all([
      concurrent.service.applyMutation(input),
      concurrent.service.applyMutation(input),
    ])
    expect(attempts.map((attempt) => attempt.applied).toSorted()).toEqual([false, true])
    expect(concurrent.events.events).toHaveLength(1)
  })

  test('merges disjoint stale updates without losing item revisions', async () => {
    const { service } = setup()
    await service.initialize({ workspaceId, projectId, at: now })
    await service.applyMutation(
      mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
        appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'draft'),
        appendItem('psi_01JBBCDEF0123456789ABCDEFG', 'owner', 'unassigned'),
      ])
    )
    await service.applyMutation(
      mutation('stm_01JCCBCDEF0123456789ABCDEF', 1, [
        updateItem('psi_01JABCDEF0123456789ABCDEFG', 'approved'),
      ])
    )
    const merged = await service.applyMutation(
      mutation('stm_01JDCBCDEF0123456789ABCDEF', 1, [
        updateItem('psi_01JBBCDEF0123456789ABCDEFG', 'platform'),
      ])
    )

    expect(merged.state.items.map((item) => [item.key, item.value, item.itemRevision])).toEqual([
      ['goal', 'approved', 2],
      ['owner', 'platform', 2],
    ])
  })

  test('retains provenance, sensitivity, freshness, supersession, and artifacts', async () => {
    const { service } = setup()
    await service.initialize({ workspaceId, projectId, at: now })
    const result = await service.applyMutation(
      mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
        {
          ...appendItem('psi_01JABCDEF0123456789ABCDEFG', 'decision', 'use CAS'),
          item: {
            ...appendItem('psi_01JABCDEF0123456789ABCDEFG', 'decision', 'use CAS').item,
            sensitivity: 'confidential',
            freshness: { observedAt: now, expiresAt: '2026-09-01T00:00:00.000Z' },
            provenance: {
              sourceKind: 'artifact',
              sourcePrincipalRef: 'principal://agent-hq/user/42',
              artifactRefs: ['art_01JABCDEF0123456789ABCDEFG'],
              capturedAt: now,
            },
            supersedesItemId: 'psi_01JZBCDEF0123456789ABCDEFG',
          },
        },
      ])
    )

    expect(result.state.items[0]).toMatchObject({
      sensitivity: 'confidential',
      supersedesItemId: 'psi_01JZBCDEF0123456789ABCDEFG',
      provenance: { sourceKind: 'artifact', artifactRefs: ['art_01JABCDEF0123456789ABCDEFG'] },
    })
  })

  test('requires explicit reviewed promotion for execution-derived changes', async () => {
    const { service } = setup()
    await service.initialize({ workspaceId, projectId, at: now })
    const operation = appendItem('psi_01JABCDEF0123456789ABCDEFG', 'finding', 'tests pass', {
      sourceKind: 'execution',
      sourceExecutionId: executionId,
      sourcePrincipalRef: 'principal://control-plane/runtime-worker',
      artifactRefs: [],
      capturedAt: now,
    })

    await expect(
      service.applyMutation(mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [operation]))
    ).rejects.toMatchObject({ code: 'PROMOTION_REQUIRED' })
    const candidate = await service.createPromotionProposal({
      proposalId: 'spp_01JABCDEF0123456789ABCDEFG',
      workspaceId,
      projectId,
      baseRevision: 0,
      sourceExecutionId: executionId,
      operations: [operation],
      createdAt: now,
      expiresAt: '2026-09-01T00:00:00.000Z',
    })
    const approved = await service.approvePromotion({
      proposalId: candidate.proposalId,
      reviewingPrincipalRef: 'principal://agent-hq/user/42',
      reviewedAt: later,
    })
    const merged = await service.mergePromotion({
      proposalId: approved.proposalId,
      mutationId: 'stm_01JBBCDEF0123456789ABCDEFG',
      mergedAt: later,
    })

    expect(merged).toMatchObject({
      state: 'merged',
      reviewingPrincipalRef: 'principal://agent-hq/user/42',
      resultingProjectStateRevision: 1,
    })
  })

  test('fails closed for cross-workspace project reads and mutations without existence leakage', async () => {
    const { service, events } = setup()
    const otherWorkspaceId = 'wsp_01JBBCDEF0123456789ABCDEFG'
    await service.initialize({ workspaceId, projectId, at: now })

    await expect(
      service.getAtRevision({ workspaceId: otherWorkspaceId, projectId, revision: 0 })
    ).rejects.toMatchObject({ code: 'REVISION_MISSING' })
    await expect(
      service.getAtRevision({
        workspaceId: otherWorkspaceId,
        projectId: 'prj_01JBBCDEF0123456789ABCDEFG',
        revision: 0,
      })
    ).rejects.toMatchObject({ code: 'REVISION_MISSING' })
    await expect(
      service.applyMutation({
        ...mutation('stm_01JZBCDEF0123456789ABCDEFG', 0, [
          appendItem('psi_01JZBCDEF0123456789ABCDEFG', 'forbidden', 'cross-workspace'),
        ]),
        workspaceId: otherWorkspaceId,
      })
    ).rejects.toMatchObject({ code: 'PROJECT_STATE_MISSING' })
    expect(await service.getHistory({ workspaceId, projectId })).toHaveLength(1)
    expect(events.events).toHaveLength(0)
  })

  test('supports rejection, supersession, expiry, and history reconstruction', async () => {
    const { service } = setup()
    await service.initialize({ workspaceId, projectId, at: now })
    const rejected = await service.createPromotionProposal(
      proposal('spp_01JABCDEF0123456789ABCDEFG')
    )
    expect(
      (
        await service.rejectPromotion({
          proposalId: rejected.proposalId,
          reviewingPrincipalRef: 'principal://agent-hq/user/42',
          reviewedAt: later,
          reason: 'Not canonical',
        })
      ).state
    ).toBe('rejected')
    const old = await service.createPromotionProposal(proposal('spp_01JBBCDEF0123456789ABCDEFG'))
    const replacement = await service.createPromotionProposal(
      proposal('spp_01JCBCDEF0123456789ABCDEFG')
    )
    expect(
      (await service.supersedePromotion(old.proposalId, replacement.proposalId, later)).state
    ).toBe('superseded')
    const expiring = await service.createPromotionProposal(
      proposal('spp_01JDBCDEF0123456789ABCDEFG')
    )
    expect(
      (await service.expirePromotion(expiring.proposalId, '2026-09-02T00:00:00.000Z')).state
    ).toBe('expired')

    await service.applyMutation(
      mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
        appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
      ])
    )
    await service.applyMutation(
      mutation('stm_01JBBCDEF0123456789ABCDEFG', 1, [
        appendItem('psi_01JBBCDEF0123456789ABCDEFG', 'owner', 'platform'),
      ])
    )
    expect(
      (await service.getAtRevision({ workspaceId, projectId, revision: 1 })).items
    ).toHaveLength(1)
    expect(
      (await service.getHistory({ workspaceId, projectId })).map((state) => state.revision)
    ).toEqual([0, 1, 2])
  })

  test('rejects non-JSON values, time regression, and approval after expiry', async () => {
    const operation = appendItem('psi_01JABCDEF0123456789ABCDEFG', 'invalid', 'value')
    expect(() =>
      ProjectStateOperationSchema.parse({
        ...operation,
        item: { ...operation.item, value: () => 'not durable' },
      })
    ).toThrow()

    const { service } = setup()
    await service.initialize({ workspaceId, projectId, at: now })
    await expect(
      service.applyMutation({
        ...mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
          appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
        ]),
        at: '2026-08-23T11:00:00.000Z',
      })
    ).rejects.toMatchObject({ code: 'TIMESTAMP_REGRESSION' })

    const candidate = await service.createPromotionProposal(
      proposal('spp_01JABCDEF0123456789ABCDEFG')
    )
    await expect(
      service.approvePromotion({
        proposalId: candidate.proposalId,
        reviewingPrincipalRef: 'principal://agent-hq/user/42',
        reviewedAt: '2026-09-02T00:00:00.000Z',
      })
    ).rejects.toMatchObject({ code: 'PROPOSAL_EXPIRED' })
  })
})

function setup() {
  const events = new RecordingProjectStateEventPublisher()
  const service = new ProjectStateService(
    new InMemoryProjectStateRepository(),
    new InMemoryStatePromotionProposalRepository(),
    events
  )
  return { service, events }
}

function mutation(mutationId, expectedRevision, operations) {
  return {
    mutationId,
    workspaceId,
    projectId,
    expectedRevision,
    actorPrincipalRef: 'principal://agent-hq/user/42',
    operations,
    at: later,
  }
}

function appendItem(itemId, key, value, provenance = undefined) {
  return {
    kind: 'append',
    item: {
      itemId,
      key,
      value,
      sensitivity: 'internal',
      freshness: { observedAt: now },
      provenance: provenance ?? {
        sourceKind: 'principal',
        sourcePrincipalRef: 'principal://agent-hq/user/42',
        artifactRefs: [],
        capturedAt: now,
      },
    },
  }
}

function updateItem(itemId, value) {
  return {
    kind: 'update',
    itemId,
    expectedItemRevision: 1,
    value,
    sensitivity: 'internal',
    freshness: { observedAt: later },
    provenance: {
      sourceKind: 'principal',
      sourcePrincipalRef: 'principal://agent-hq/user/42',
      artifactRefs: [],
      capturedAt: later,
    },
  }
}

function proposal(proposalId) {
  return {
    proposalId,
    workspaceId,
    projectId,
    baseRevision: 0,
    sourceExecutionId: executionId,
    operations: [
      appendItem('psi_01JZBCDEF0123456789ABCDEFG', 'candidate', proposalId, {
        sourceKind: 'execution',
        sourceExecutionId: executionId,
        sourcePrincipalRef: 'principal://control-plane/runtime-worker',
        artifactRefs: [],
        capturedAt: now,
      }),
    ],
    createdAt: now,
    expiresAt: '2026-09-01T00:00:00.000Z',
  }
}
