import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  AppliedStateMutationSchema,
  InMemoryProjectStateRepository,
  InMemoryStatePromotionProposalRepository,
  ProjectStateConflict,
  ProjectStateOperationSchema,
  ProjectStateService,
  RecordingProjectStateEventPublisher,
  projectStateMutationDigestForVersion,
  projectStateMutationDigestV2,
  projectStateMutationLegacyDigest,
  projectStateMutationMatchesDigest,
} from './index.ts'
import { projectStateDigestHistoryFixtures } from './project-state-digest-history-fixtures.mjs'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const projectId = 'prj_01JABCDEF0123456789ABCDEFG'
const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
const now = '2026-08-23T12:00:00.000Z'
const later = '2026-08-23T13:00:00.000Z'

describe('project state digest cutover', () => {
  test('a mutation persisted pre-cutover replays via the legacy digest', async () => {
    const repository = new InMemoryProjectStateRepository()
    const service = new ProjectStateService(
      repository,
      new InMemoryStatePromotionProposalRepository(),
      new RecordingProjectStateEventPublisher()
    )
    await service.initialize({ workspaceId, projectId, at: now })
    // Appended values are free-form JSON: keys 'a-b'/'a_b' order differently
    // under localeCompare vs code point, so the two forms genuinely diverge.
    const input = mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
      appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', {
        'a-b': 1,
        a_b: 2,
      }),
    ])
    const legacyDigest = projectStateMutationLegacyDigest(input)
    expect(legacyDigest).not.toBe(projectStateMutationDigestV2(input))

    // Intercept the first write to simulate a record stored pre-cutover.
    const originalCompareAndSet = repository.compareAndSet.bind(repository)
    repository.compareAndSet = async (expectedRevision, state, record) => {
      return originalCompareAndSet(expectedRevision, state, {
        ...record,
        inputDigest: legacyDigest,
      })
    }

    const first = await service.applyMutation(input)
    expect(first.applied).toBe(true)
    // Replay computes the V2 form plus the legacy candidate: the pre-cutover
    // record must resolve to an idempotent replay, never MUTATION_ID_REUSED.
    const replay = await service.applyMutation(input)
    expect(replay.applied).toBe(false)
  })
})

describe('project state mutation digest versioning', () => {
  test('the frozen historical fixtures authenticate their own canonical bytes', () => {
    // The frozen digest is the witness for the frozen bytes, so this check holds on any
    // host: it never re-derives the historical digest from the input.
    for (const testCase of projectStateDigestHistoryFixtures.cases) {
      const digest = createHash('sha256').update(testCase.canonicalBytes).digest('hex')
      expect(`sha256:${digest}`).toBe(testCase.legacyDigest)
    }
  })

  test('the frozen historical digests genuinely diverge from the code-point digests', () => {
    for (const testCase of projectStateDigestHistoryFixtures.cases) {
      expect(projectStateMutationDigestV2(testCase.input)).not.toBe(testCase.legacyDigest)
    }
  })

  test('the record version decides the canonicalization a reader accepts', async () => {
    // The historical canonicalization sorts keys with a locale-dependent collation, so the
    // compatibility path is pinned to the locale the frozen fixtures were produced under.
    // The code-point path is unaffected: it never consults the locale.
    await withPinnedLegacyLocale(
      projectStateDigestHistoryFixtures.provenance.generationProfile.locale,
      async () => {
        for (const testCase of projectStateDigestHistoryFixtures.cases) {
          const versionedDigest = projectStateMutationDigestV2(testCase.input)
          // An untagged record predates explicit versioning: the reader accepts the
          // compatibility forms it can still justify.
          expect(projectStateMutationMatchesDigest(testCase.input, testCase.legacyDigest)).toBe(
            true
          )
          expect(projectStateMutationMatchesDigest(testCase.input, versionedDigest)).toBe(true)
          // A versioned record names its canonicalization: only that form is accepted.
          expect(projectStateMutationMatchesDigest(testCase.input, versionedDigest, 2)).toBe(true)
          expect(projectStateMutationMatchesDigest(testCase.input, testCase.legacyDigest, 2)).toBe(
            false
          )
        }
      }
    )
  })

  test('the current legacy helper reproduces the frozen historical bytes under the pinned profile', async () => {
    // Consistency only. The proof is the frozen canonical bytes hashing to the frozen
    // digest; this shows the compatibility path still reaches the same bytes.
    const locale = projectStateDigestHistoryFixtures.provenance.generationProfile.locale
    await withPinnedLegacyLocale(locale, async () => {
      for (const testCase of projectStateDigestHistoryFixtures.cases) {
        expect(projectStateMutationLegacyDigest(testCase.input)).toBe(testCase.legacyDigest)
      }
    })
  })

  test('an unsupported digest version fails closed', () => {
    const testCase = projectStateDigestHistoryFixtures.cases[0]
    const versionedDigest = projectStateMutationDigestV2(testCase.input)
    for (const version of [1, 3, 0, -1, 2.5, '2', null, true]) {
      expect(
        projectStateMutationMatchesDigest(testCase.input, testCase.legacyDigest, version)
      ).toBe(false)
      expect(projectStateMutationMatchesDigest(testCase.input, versionedDigest, version)).toBe(
        false
      )
    }
  })

  test('a malformed digest version is rejected by the record schema', () => {
    const record = {
      mutationId: 'stm_01JABCDEF0123456789ABCDEFG',
      inputDigest: projectStateMutationDigestV2(projectStateDigestHistoryFixtures.cases[0].input),
      resultingRevision: 1,
      touchedItemIds: [],
    }
    expect(AppliedStateMutationSchema.safeParse(record).success).toBe(true)
    expect(AppliedStateMutationSchema.safeParse({ ...record, inputDigestVersion: 2 }).success).toBe(
      true
    )
    for (const malformed of [2.5, '2', null, true, {}]) {
      expect(
        AppliedStateMutationSchema.safeParse({ ...record, inputDigestVersion: malformed }).success
      ).toBe(false)
    }
    // Well-formed but unsupported versions survive the schema and are refused by the reader.
    expect(AppliedStateMutationSchema.safeParse({ ...record, inputDigestVersion: 3 }).success).toBe(
      true
    )
  })

  test('the default writer keeps the untagged record it has always written', async () => {
    const { service, repository } = setupWithRepository()
    await service.initialize({ workspaceId, projectId, at: now })
    const input = mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
      appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
    ])
    await service.applyMutation(input)
    const stored = await repository.getMutation(workspaceId, projectId, input.mutationId)
    expect(stored.inputDigestVersion).toBeUndefined()
    expect(stored.inputDigest).toBe(projectStateMutationDigestV2(input))
    expect(Object.hasOwn(stored, 'inputDigestVersion')).toBe(false)
  })

  test('the versioned writer is opt-in and records the canonicalization it used', async () => {
    const { service, repository } = setupWithRepository()
    await service.initialize({ workspaceId, projectId, at: now })
    const input = mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
      appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
    ])
    const written = await service.applyMutation(input, { digestVersion: 2 })
    expect(written.applied).toBe(true)
    const stored = await repository.getMutation(workspaceId, projectId, input.mutationId)
    expect(stored.inputDigestVersion).toBe(2)
    expect(stored.inputDigest).toBe(projectStateMutationDigestV2(input))
  })

  test('a versioned writer rejects an unsupported version instead of writing one', async () => {
    const { service } = setupWithRepository()
    await service.initialize({ workspaceId, projectId, at: now })
    const input = mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
      appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
    ])
    await expect(service.applyMutation(input, { digestVersion: 3 })).rejects.toThrow()
  })

  test('an ordinary replay and a compare-and-set loser accept the same records', async () => {
    const { service, repository } = setupWithRepository()
    await service.initialize({ workspaceId, projectId, at: now })
    const input = mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
      appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
    ])
    await service.applyMutation(input, { digestVersion: 2 })

    // The ordinary replay reads the record and verifies it against its own version.
    const replay = await service.applyMutation(input)
    expect(replay.applied).toBe(false)
    expect(replay.state.revision).toBe(1)

    // The compare-and-set loser reaches the same record through the same verification.
    const loser = await service.applyMutation(input, { digestVersion: 2 })
    expect(loser.applied).toBe(false)
    expect(loser.state.revision).toBe(1)
    expect(await repository.getHistory(workspaceId, projectId)).toHaveLength(2)
  })

  test('an altered input is refused for a versioned and for an untagged record', async () => {
    const { service, repository } = setupWithRepository()
    await service.initialize({ workspaceId, projectId, at: now })
    const input = mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
      appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
    ])
    await service.applyMutation(input, { digestVersion: 2 })
    const altered = mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
      appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M3'),
    ])
    await expect(service.applyMutation(altered)).rejects.toMatchObject({
      code: 'MUTATION_ID_REUSED',
    })
    expect(await repository.getHistory(workspaceId, projectId)).toHaveLength(2)
  })

  test('a record carrying an unsupported version is refused instead of replayed', async () => {
    const { service, repository } = setupWithRepository()
    await service.initialize({ workspaceId, projectId, at: now })
    const input = mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
      appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
    ])
    // Simulate a record written by a release this reader does not know.
    const originalCompareAndSet = repository.compareAndSet.bind(repository)
    repository.compareAndSet = async (expectedRevision, state, record) =>
      originalCompareAndSet(expectedRevision, state, { ...record, inputDigestVersion: 3 })
    await service.applyMutation(input)
    await expect(service.applyMutation(input)).rejects.toMatchObject({
      code: 'MUTATION_DIGEST_VERSION_UNSUPPORTED',
    })
  })

  test('the recorded version selects the canonicalization the digest was produced with', async () => {
    const { service, repository } = setupWithRepository()
    await service.initialize({ workspaceId, projectId, at: now })
    const input = mutation('stm_01JABCDEF0123456789ABCDEFG', 0, [
      appendItem('psi_01JABCDEF0123456789ABCDEFG', 'goal', 'ship M2'),
    ])
    await service.applyMutation(input, { digestVersion: 2 })
    const stored = await repository.getMutation(workspaceId, projectId, input.mutationId)

    // The bytes the record carries are the digest of the canonicalization the record names,
    // so the version tag can never disagree with the digest it stands for.
    expect(stored.inputDigest).toBe(projectStateMutationDigestForVersion(2, input))
    expect(stored.inputDigest).toBe(projectStateMutationDigestV2(input))

    // A version this release has no canonicalization for has no digest at all: the writer
    // cannot record it and the reader cannot verify against it.
    expect(projectStateMutationDigestForVersion(3, input)).toBeUndefined()
    expect(projectStateMutationMatchesDigest(input, stored.inputDigest, 3)).toBe(false)
  })

  test('the promotion path can write a versioned record', async () => {
    const { service, repository } = setupWithRepository()
    await service.initialize({ workspaceId, projectId, at: now })
    const operation = appendItem('psi_01JBBCDEF0123456789ABCDEFG', 'finding', 'tests pass', {
      sourceKind: 'execution',
      sourceExecutionId: executionId,
      sourcePrincipalRef: 'principal://control-plane/runtime-worker',
      artifactRefs: [],
      capturedAt: now,
    })
    const approved = await approveProposal(service, operation)

    await service.mergePromotion(
      {
        proposalId: approved.proposalId,
        mutationId: 'stm_01JBBCDEF0123456789ABCDEFG',
        mergedAt: later,
      },
      { digestVersion: 2 }
    )

    // The merged record names the canonicalization it was written with.
    const stored = await repository.getMutation(
      workspaceId,
      projectId,
      'stm_01JBBCDEF0123456789ABCDEFG'
    )
    expect(stored.inputDigestVersion).toBe(2)
  })

  test('the promotion path keeps the untagged record when the writer does not opt in', async () => {
    const { service, repository } = setupWithRepository()
    await service.initialize({ workspaceId, projectId, at: now })
    const operation = appendItem('psi_01JBBCDEF0123456789ABCDEFG', 'finding', 'tests pass', {
      sourceKind: 'execution',
      sourceExecutionId: executionId,
      sourcePrincipalRef: 'principal://control-plane/runtime-worker',
      artifactRefs: [],
      capturedAt: now,
    })
    const approved = await approveProposal(service, operation)

    await service.mergePromotion({
      proposalId: approved.proposalId,
      mutationId: 'stm_01JBBCDEF0123456789ABCDEFG',
      mergedAt: later,
    })

    const stored = await repository.getMutation(
      workspaceId,
      projectId,
      'stm_01JBBCDEF0123456789ABCDEFG'
    )
    expect(stored.inputDigestVersion).toBeUndefined()
    expect(Object.hasOwn(stored, 'inputDigestVersion')).toBe(false)
  })
})

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

function setupWithRepository() {
  const repository = new InMemoryProjectStateRepository()
  const events = new RecordingProjectStateEventPublisher()
  const service = new ProjectStateService(
    repository,
    new InMemoryStatePromotionProposalRepository(),
    events
  )
  return { service, repository, events }
}

/**
 * Pins the locale the locale-dependent legacy canonicalization resolves against, so the
 * compatibility path is exercised under the profile the frozen fixtures were produced
 * under instead of the host's ambient locale. Calls that pass an explicit locale are left
 * alone, and the original implementation is always restored.
 */
async function withPinnedLegacyLocale(locale, callback) {
  const originalLocaleCompare = String.prototype.localeCompare
  Reflect.set(String.prototype, 'localeCompare', function (...args) {
    return args.length === 1
      ? originalLocaleCompare.call(this, args[0], locale)
      : originalLocaleCompare.apply(this, args)
  })
  try {
    return await callback()
  } finally {
    Reflect.set(String.prototype, 'localeCompare', originalLocaleCompare)
  }
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

/**
 * A reviewed promotion proposal for one execution-derived operation, so a test can drive the
 * merge path the way the reviewed flow does.
 */
async function approveProposal(service, operation) {
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
  return service.approvePromotion({
    proposalId: candidate.proposalId,
    reviewingPrincipalRef: 'principal://agent-hq/user/42',
    reviewedAt: later,
  })
}
