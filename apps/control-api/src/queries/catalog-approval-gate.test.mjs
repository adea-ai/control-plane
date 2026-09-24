import { describe, expect, test } from 'bun:test'
import { assertCatalogVersionApproved } from './catalog-approval-gate.ts'

const digest = (character) => `sha256:${character.repeat(64)}`

const version = { revision: 2, contentDigest: digest('a'), publishedAt: '2026-08-22T12:00:00.000Z' }

const decision = (overrides = {}) => ({
  versionKind: 'agent_profile',
  versionId: 'pfv_01JABCDEF0123456789ABCDEFG',
  revision: 2,
  contentDigest: digest('a'),
  decision: 'approved',
  actorPrincipalRef: 'principal://agent-hq/user/42',
  decidedAt: '2026-09-20T12:00:00.000Z',
  ...overrides,
})

const gate = ({ policy = { required: true }, decisions = [] } = {}) => ({
  policy,
  approvals: {
    async list() {
      return decisions
    },
  },
})

const versionId = 'pfv_01JABCDEF0123456789ABCDEFG'

describe('shared catalog approval gate', () => {
  test('passes for approved, grandfathered, and unenforced policies', async () => {
    await expect(
      assertCatalogVersionApproved(
        gate({ decisions: [decision()] }),
        'PROFILE',
        'agent_profile',
        versionId,
        version
      )
    ).resolves.toBeUndefined()
    await expect(
      assertCatalogVersionApproved(
        gate({ policy: { required: true, requiredSince: '2026-09-01T00:00:00.000Z' } }),
        'PROFILE',
        'agent_profile',
        versionId,
        version
      )
    ).resolves.toBeUndefined()
    await expect(
      assertCatalogVersionApproved(
        gate({ policy: { required: false } }),
        'PROFILE',
        'agent_profile',
        versionId,
        version
      )
    ).resolves.toBeUndefined()
  })

  test('denies with the kind-specific code for missing and rejected decisions', async () => {
    await expect(
      assertCatalogVersionApproved(gate(), 'PROFILE', 'agent_profile', versionId, version)
    ).rejects.toMatchObject({ response: { code: 'PROFILE_APPROVAL_MISSING' } })
    await expect(
      assertCatalogVersionApproved(
        gate({ decisions: [decision({ decision: 'rejected' })] }),
        'SKILL',
        'skill',
        versionId,
        version
      )
    ).rejects.toMatchObject({ response: { code: 'SKILL_APPROVAL_REJECTED' } })
    await expect(
      assertCatalogVersionApproved(
        gate({ decisions: [decision({ revision: 1 })] }),
        'SKILL',
        'skill',
        versionId,
        version
      )
    ).rejects.toMatchObject({ response: { code: 'SKILL_APPROVAL_MISSING' } })
  })
})
