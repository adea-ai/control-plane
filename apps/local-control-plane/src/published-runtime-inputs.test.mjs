import { describe, expect, test } from 'bun:test'
import { executionConstraintFixtures } from '@control-plane/domain'
import { resolvePublishedRuntimeInputs } from './published-runtime-inputs.ts'

const digest = (character) => `sha256:${character.repeat(64)}`

const profileVersion = {
  profileId: 'prf_01JABCDEF0123456789ABCDEFG',
  profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
  version: 3,
  revision: 2,
  lifecycle: 'published',
  contentDigest: digest('a'),
  definition: {
    schemaVersion: 1,
    roleInstructions: 'Complete the assigned task safely.',
    skills: [],
    capabilityRequirements: [],
    executionConstraints: globalThis.structuredClone(executionConstraintFixtures.write),
    outputContractRefs: [],
  },
  createdAt: '2026-08-22T12:00:00.000Z',
  lifecycleMetadata: { publishedAt: '2026-08-22T12:00:00.000Z' },
}

const skillVersion = {
  skillId: 'skl_01JABCDEF0123456789ABCDEFG',
  skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
  revision: 1,
  lifecycle: 'published',
  manifest: {
    schemaVersion: 1,
    semanticVersion: '2.1.0',
    contentDigest: digest('b'),
    requiredCapabilities: ['filesystem.read'],
    requiredTools: [{ toolId: 'project-files', versionRange: '^1.0.0' }],
    compatibleProfileSchemaVersions: [1],
    compatibleContractMajorVersions: [1],
  },
  content: { instructions: 'Inspect files.', artifactRefs: [] },
  createdAt: '2026-08-22T12:00:00.000Z',
  lifecycleMetadata: { publishedAt: '2026-08-22T12:00:00.000Z' },
}

const pins = {
  profile: {
    profileId: profileVersion.profileId,
    profileVersionId: profileVersion.profileVersionId,
    version: 3,
    revision: 2,
    schemaVersion: 1,
    contentDigest: digest('a'),
  },
  skills: [
    {
      skillId: skillVersion.skillId,
      skillVersionId: skillVersion.skillVersionId,
      revision: 1,
      schemaVersion: 1,
      semanticVersion: '2.1.0',
      contentDigest: digest('b'),
    },
  ],
}

const catalog = {
  async getAgentProfileVersion(id) {
    return id === profileVersion.profileVersionId ? profileVersion : undefined
  },
  async getSkillVersion(id) {
    return id === skillVersion.skillVersionId ? skillVersion : undefined
  },
}

const decision = (overrides = {}) => ({
  versionKind: 'agent_profile',
  versionId: profileVersion.profileVersionId,
  revision: 2,
  contentDigest: digest('a'),
  decision: 'approved',
  actorPrincipalRef: 'principal://agent-hq/user/42',
  decidedAt: '2026-09-20T12:00:00.000Z',
  ...overrides,
})

const gate = (overrides = {}) => ({
  policy: { required: true, ...overrides.policy },
  approvals: {
    async list(versionKind, versionId) {
      return (overrides.decisions ?? []).filter(
        (candidate) => candidate.versionKind === versionKind && candidate.versionId === versionId
      )
    },
  },
})

const bothDecisions = [
  decision(),
  decision({
    versionKind: 'skill',
    versionId: skillVersion.skillVersionId,
    revision: 1,
    contentDigest: digest('b'),
  }),
]

describe('local runtime input approval gate', () => {
  test('resolves unchanged without a gate and while the policy is off', async () => {
    expect(await resolvePublishedRuntimeInputs(catalog, pins, 'MANAGED_PI')).toMatchObject({
      profile: { profileVersionId: profileVersion.profileVersionId },
    })
    const off = gate({ policy: { required: false } })
    expect(await resolvePublishedRuntimeInputs(catalog, pins, 'MANAGED_PI', off)).toMatchObject({
      skills: [{ skillVersionId: skillVersion.skillVersionId }],
    })
  })

  test('allows approved and grandfathered inputs', async () => {
    expect(
      await resolvePublishedRuntimeInputs(catalog, pins, 'ACP', gate({ decisions: bothDecisions }))
    ).toMatchObject({ profile: { revision: 2 } })
    expect(
      await resolvePublishedRuntimeInputs(
        catalog,
        pins,
        'ACP',
        gate({ policy: { requiredSince: '2026-09-01T00:00:00.000Z' } })
      )
    ).toMatchObject({ profile: { revision: 2 } })
  })

  test('denies missing profile approval, rejected decisions, and ungated skills', async () => {
    await expect(
      resolvePublishedRuntimeInputs(catalog, pins, 'MANAGED_PI', gate())
    ).rejects.toThrow('MANAGED_PI_PROFILE_APPROVAL_MISSING')
    await expect(
      resolvePublishedRuntimeInputs(
        catalog,
        pins,
        'MANAGED_PI',
        gate({ decisions: [decision({ decision: 'rejected' })] })
      )
    ).rejects.toThrow('MANAGED_PI_PROFILE_APPROVAL_REJECTED')
    await expect(
      resolvePublishedRuntimeInputs(catalog, pins, 'ACP', gate({ decisions: [decision()] }))
    ).rejects.toThrow('ACP_SKILL_APPROVAL_MISSING')
  })
})
