import { describe, expect, test } from 'bun:test'
import { ControlApiFixtures } from '@control-plane/contracts'
import { executionConstraintFixtures } from '@control-plane/domain'
import { RepositoryProfileResolutionService } from './profile-resolution.service.ts'

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
    skills: [
      {
        skillId: 'skl_01JABCDEF0123456789ABCDEFG',
        skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
        contentDigest: digest('b'),
      },
    ],
    capabilityRequirements: ['stream.output'],
    executionConstraints: globalThis.structuredClone(executionConstraintFixtures.write),
    outputContractRefs: ['contract://execution-result/v1'],
  },
  createdAt: '2026-08-22T12:00:00.000Z',
  lifecycleMetadata: { publishedAt: '2026-08-22T12:00:00.000Z' },
}

const skillVersion = {
  skillId: 'skl_01JABCDEF0123456789ABCDEFG',
  skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
  revision: 1,
  lifecycle: 'published',
  manifest: { schemaVersion: 1, semanticVersion: '2.1.0', contentDigest: digest('b') },
  content: { instructions: 'Inspect and update project files.', artifactRefs: [] },
  createdAt: '2026-08-22T12:00:00.000Z',
  lifecycleMetadata: { publishedAt: '2026-08-22T12:00:00.000Z' },
}

const decision = (overrides = {}) => ({
  versionKind: 'agent_profile',
  versionId: profileVersion.profileVersionId,
  revision: profileVersion.revision,
  contentDigest: profileVersion.contentDigest,
  decision: 'approved',
  actorPrincipalRef: 'principal://agent-hq/user/42',
  decidedAt: '2026-09-20T12:00:00.000Z',
  ...overrides,
})

function service({ policy, decisions = [] } = {}) {
  const profiles = {
    async getAgentProfileVersion(profileVersionId) {
      return profileVersionId === profileVersion.profileVersionId ? profileVersion : undefined
    },
    async listAgentProfileVersions(profileId) {
      return profileId === profileVersion.profileId ? [profileVersion] : []
    },
  }
  const skills = {
    async getSkillVersion(skillVersionId) {
      return skillVersionId === skillVersion.skillVersionId ? skillVersion : undefined
    },
  }
  const approvals = {
    async list(versionKind, versionId) {
      return decisions.filter(
        (candidate) => candidate.versionKind === versionKind && candidate.versionId === versionId
      )
    },
  }
  const gate = policy === undefined ? undefined : { approvals, skills, policy }
  return new RepositoryProfileResolutionService(profiles, gate)
}

function request(overrides = {}) {
  return {
    ...ControlApiFixtures.profileResolution.request,
    ...overrides,
  }
}

describe('profile resolution approval gate', () => {
  test('resolves published profiles unchanged when no gate is configured', async () => {
    const response = await service().resolve(request())
    expect(response).toEqual(ControlApiFixtures.profileResolution.response)
  })

  test('enforces nothing while the policy is off', async () => {
    const response = await service({ policy: { required: false } }).resolve(request())
    expect(response).toMatchObject({
      data: { profile: { profileVersionId: profileVersion.profileVersionId } },
    })
  })

  test('allows approved and grandfathered versions', async () => {
    const approved = await service({
      policy: { required: true },
      decisions: [
        decision(),
        decision({
          versionKind: 'skill',
          versionId: skillVersion.skillVersionId,
          revision: skillVersion.revision,
          contentDigest: skillVersion.manifest.contentDigest,
        }),
      ],
    }).resolve(request())
    expect(approved).toMatchObject({ data: { profile: { revision: 2 } } })

    const grandfathered = await service({
      policy: { required: true, requiredSince: '2026-09-01T00:00:00.000Z' },
    }).resolve(request())
    expect(grandfathered).toMatchObject({ data: { profile: { revision: 2 } } })
  })

  test('denies missing, stale-bound, and rejected decisions', async () => {
    const required = service({ policy: { required: true } })
    await expect(required.resolve(request())).rejects.toMatchObject({
      response: { code: 'PROFILE_APPROVAL_MISSING' },
    })

    const stale = service({ policy: { required: true }, decisions: [decision({ revision: 1 })] })
    await expect(stale.resolve(request())).rejects.toMatchObject({
      response: { code: 'PROFILE_APPROVAL_MISSING' },
    })

    const rejected = service({
      policy: { required: true },
      decisions: [decision({ decision: 'rejected' })],
    })
    await expect(rejected.resolve(request())).rejects.toMatchObject({
      response: { code: 'PROFILE_APPROVAL_REJECTED' },
    })
  })

  test('gates referenced skill versions independently of the profile', async () => {
    const skillDenied = service({
      policy: { required: true },
      decisions: [decision()],
    })
    await expect(skillDenied.resolve(request())).rejects.toMatchObject({
      response: { code: 'SKILL_APPROVAL_MISSING' },
    })

    const bothApproved = service({
      policy: { required: true },
      decisions: [
        decision(),
        decision({
          versionKind: 'skill',
          versionId: skillVersion.skillVersionId,
          revision: skillVersion.revision,
          contentDigest: skillVersion.manifest.contentDigest,
        }),
      ],
    })
    const response = await bothApproved.resolve(request())
    expect(response).toMatchObject({
      data: { skillVersionIds: [skillVersion.skillVersionId] },
    })
  })
})
