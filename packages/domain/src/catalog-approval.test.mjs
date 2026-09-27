import { describe, expect, test } from 'bun:test'
import { CatalogApprovalAdministration, CatalogApprovalService } from './index.ts'

const digest = (character) => `sha256:${character.repeat(64)}`

class InMemoryCatalogApprovalRepository {
  decisions = []

  async insert(decision) {
    const exists = this.decisions.some(
      (candidate) =>
        candidate.versionKind === decision.versionKind &&
        candidate.versionId === decision.versionId &&
        candidate.revision === decision.revision
    )
    if (exists) return false
    this.decisions.push(decision)
    return true
  }

  async list(versionKind, versionId) {
    return this.decisions.filter(
      (decision) => decision.versionKind === versionKind && decision.versionId === versionId
    )
  }
}

function setup({ profile, skill } = {}) {
  const approvals = new InMemoryCatalogApprovalRepository()
  const versions = {
    async getAgentProfileVersion(versionId) {
      return profile?.profileVersionId === versionId ? profile : undefined
    },
    async getSkillVersion(versionId) {
      return skill?.skillVersionId === versionId ? skill : undefined
    },
  }
  return { approvals, versions, service: new CatalogApprovalService({ approvals, versions }) }
}

const publishedProfile = {
  profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
  revision: 2,
  contentDigest: digest('a'),
  lifecycle: 'published',
}

const publishedSkill = {
  skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
  revision: 1,
  manifest: { contentDigest: digest('b') },
  lifecycle: 'published',
}

const decision = (overrides = {}) => ({
  versionKind: 'agent_profile',
  versionId: publishedProfile.profileVersionId,
  revision: publishedProfile.revision,
  contentDigest: publishedProfile.contentDigest,
  decision: 'approved',
  actorPrincipalRef: 'principal://agent-hq/user/42',
  authorityRef: 'grant://catalog/approver-v1',
  decidedAt: '2026-09-24T12:00:00.000Z',
  ...overrides,
})

describe('catalog version approval decisions', () => {
  test('administration requires a verified operator and refuses claimed identity or authority', async () => {
    const { approvals, versions } = setup({ profile: publishedProfile })
    const request = { operation: 'approvals.record', decision: decision() }
    await expect(
      new CatalogApprovalAdministration({ approvals, versions }).apply(request)
    ).rejects.toMatchObject({ code: 'CATALOG_APPROVAL_OPERATOR_REQUIRED' })
    const operator = {
      actorPrincipalRef: 'operator:sqlite:uid:42',
      authorityRef: 'authority:sqlite:local-os',
    }
    const administration = new CatalogApprovalAdministration({ approvals, versions, operator })
    await expect(administration.apply(request)).rejects.toMatchObject({
      code: 'CATALOG_APPROVAL_OPERATOR_MISMATCH',
    })
    await expect(
      administration.apply({
        ...request,
        decision: decision({ ...operator, authorityRef: 'grant://someone-else' }),
      })
    ).rejects.toMatchObject({ code: 'CATALOG_APPROVAL_OPERATOR_MISMATCH' })
    expect(approvals.decisions).toHaveLength(0)
    const recorded = await administration.apply({ ...request, decision: decision(operator) })
    expect(recorded.decision).toMatchObject(operator)
    expect(
      (await administration.apply({ ...request, decision: decision(operator) })).replayed
    ).toBe(true)
  })
  test('records a version/digest-bound approval and inspects it', async () => {
    const { service } = setup({ profile: publishedProfile })
    const recorded = await service.decide(decision())
    expect(recorded.replayed).toBe(false)
    expect(recorded.decision).toMatchObject({
      versionId: publishedProfile.profileVersionId,
      revision: 2,
      decision: 'approved',
      actorPrincipalRef: 'principal://agent-hq/user/42',
    })
    expect(
      await service.inspect({
        versionKind: 'agent_profile',
        versionId: publishedProfile.profileVersionId,
      })
    ).toMatchObject({ decision: 'approved' })
  })

  test('records skill decisions against the manifest digest', async () => {
    const { service } = setup({ skill: publishedSkill })
    const recorded = await service.decide(
      decision({
        versionKind: 'skill',
        versionId: publishedSkill.skillVersionId,
        revision: 1,
        contentDigest: publishedSkill.manifest.contentDigest,
        decision: 'rejected',
        rationale: 'unbounded tool scope',
      })
    )
    expect(recorded.decision.decision).toBe('rejected')
  })

  test('refuses unknown, revoked, and superseded versions', async () => {
    const missing = setup({})
    await expect(missing.service.decide(decision())).rejects.toMatchObject({
      code: 'CATALOG_APPROVAL_VERSION_MISSING',
    })
    for (const lifecycle of ['revoked', 'superseded']) {
      const { service } = setup({ profile: { ...publishedProfile, lifecycle } })
      await expect(service.decide(decision())).rejects.toMatchObject({
        code: 'CATALOG_APPROVAL_VERSION_NOT_APPROVABLE',
      })
    }
  })

  test('refuses decisions bound to a stale revision or digest', async () => {
    const { service } = setup({ profile: publishedProfile })
    await expect(service.decide(decision({ revision: 1 }))).rejects.toMatchObject({
      code: 'CATALOG_APPROVAL_STALE_VERSION',
    })
    await expect(service.decide(decision({ contentDigest: digest('f') }))).rejects.toMatchObject({
      code: 'CATALOG_APPROVAL_STALE_VERSION',
    })
  })

  test('replays identical decisions and conflicts on divergent ones', async () => {
    const { service } = setup({ profile: publishedProfile })
    const first = await service.decide(decision())
    const replay = await service.decide(decision())
    expect(replay.replayed).toBe(true)
    expect(replay.decision).toEqual(first.decision)

    await expect(
      service.decide(decision({ decision: 'rejected', rationale: 'changed mind' }))
    ).rejects.toMatchObject({ code: 'CATALOG_APPROVAL_CONFLICT' })
    await expect(
      service.decide(decision({ actorPrincipalRef: 'principal://other/user/7' }))
    ).rejects.toMatchObject({ code: 'CATALOG_APPROVAL_CONFLICT' })
  })

  test('inspect reports the latest revision decision after a version change', async () => {
    const { service, approvals } = setup({ profile: publishedProfile })
    await service.decide(decision())
    // The version advances; the earlier decision stays recorded for its revision.
    const advanced = { ...publishedProfile, revision: 3, contentDigest: digest('c') }
    const rehydrated = new CatalogApprovalService({
      approvals,
      versions: {
        async getAgentProfileVersion(versionId) {
          return advanced.profileVersionId === versionId ? advanced : undefined
        },
        async getSkillVersion() {
          return undefined
        },
      },
    })
    const latest = await rehydrated.decide(decision({ revision: 3, contentDigest: digest('c') }))
    expect(latest.replayed).toBe(false)
    expect(
      await rehydrated.inspect({
        versionKind: 'agent_profile',
        versionId: advanced.profileVersionId,
      })
    ).toMatchObject({ revision: 3 })
    expect(approvals.decisions).toHaveLength(2)
  })
})
