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

function service({
  policy,
  decisions = [],
  profileOwnership = { scope: 'system' },
  skillOwnership = { scope: 'system' },
} = {}) {
  const profiles = {
    async getAgentProfile(profileId) {
      return profileId === profileVersion.profileId
        ? { profileId, ownership: profileOwnership }
        : undefined
    },
    async getAgentProfileVersion(profileVersionId) {
      return profileVersionId === profileVersion.profileVersionId ? profileVersion : undefined
    },
    async listAgentProfileVersions(profileId) {
      return profileId === profileVersion.profileId ? [profileVersion] : []
    },
  }
  const skills = {
    async getSkill(skillId) {
      return skillId === skillVersion.skillId ? { skillId, ownership: skillOwnership } : undefined
    },
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
  Object.assign(profiles, skills)
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
  test('denies a profile whose parent belongs to another workspace', async () => {
    const foreignProfileRepository = {
      async getAgentProfileVersion(profileVersionId) {
        return profileVersionId === profileVersion.profileVersionId ? profileVersion : undefined
      },
      async listAgentProfileVersions(profileId) {
        return profileId === profileVersion.profileId ? [profileVersion] : []
      },
      async getAgentProfile() {
        return {
          profileId: profileVersion.profileId,
          ownership: { scope: 'workspace', workspaceId: 'wsp_01JOTHERWORKSPACE00000000000' },
        }
      },
      async getSkill(skillId) {
        return skillId === skillVersion.skillId
          ? { skillId, ownership: { scope: 'system' } }
          : undefined
      },
      async getSkillVersion(skillVersionId) {
        return skillVersionId === skillVersion.skillVersionId ? skillVersion : undefined
      },
    }
    const resolver = new RepositoryProfileResolutionService(foreignProfileRepository)

    await expect(resolver.resolve(request(), 'svc_agent-hq')).rejects.toMatchObject({
      response: { code: 'PROFILE_VERSION_NOT_FOUND' },
    })
  })

  test.each([
    ['system', { scope: 'system' }, 'svc_agent-hq', true],
    [
      'same workspace',
      { scope: 'workspace', workspaceId: request().workspaceId },
      'svc_agent-hq',
      true,
    ],
    [
      'another workspace',
      { scope: 'workspace', workspaceId: 'wsp_01JOTHERWORKSPACE00000000000' },
      'svc_agent-hq',
      false,
    ],
    [
      'same principal private',
      { scope: 'private', principalRef: 'svc_agent-hq' },
      'svc_agent-hq',
      true,
    ],
    [
      'other principal private',
      { scope: 'private', principalRef: 'svc_other' },
      'svc_agent-hq',
      false,
    ],
    [
      'organization without a membership source',
      { scope: 'organization', organizationRef: 'org:example' },
      'svc_agent-hq',
      false,
    ],
  ])(
    'applies the ownership rule for %s',
    async (_label, profileOwnership, principalId, allowed) => {
      const resolver = service({ profileOwnership })
      if (allowed) {
        await expect(resolver.resolve(request(), principalId)).resolves.toMatchObject({
          data: { profile: { profileVersionId: profileVersion.profileVersionId } },
        })
      } else {
        await expect(resolver.resolve(request(), principalId)).rejects.toMatchObject({
          response: { code: 'PROFILE_VERSION_NOT_FOUND' },
        })
      }
    }
  )

  test('denies a linked skill outside the authenticated workspace', async () => {
    const resolver = service({
      skillOwnership: {
        scope: 'workspace',
        workspaceId: 'wsp_01JOTHERWORKSPACE00000000000',
      },
    })
    await expect(resolver.resolve(request(), 'svc_agent-hq')).rejects.toMatchObject({
      response: { code: 'PROFILE_VERSION_NOT_FOUND' },
    })
  })

  test('resolves published profiles unchanged when no gate is configured', async () => {
    const response = await service().resolve(request(), 'svc_agent-hq')
    expect(response).toEqual(ControlApiFixtures.profileResolution.response)
  })

  test('enforces nothing while the policy is off', async () => {
    const response = await service({ policy: { required: false } }).resolve(
      request(),
      'svc_agent-hq'
    )
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
    }).resolve(request(), 'svc_agent-hq')
    expect(approved).toMatchObject({ data: { profile: { revision: 2 } } })

    const grandfathered = await service({
      policy: { required: true, requiredSince: '2026-09-01T00:00:00.000Z' },
    }).resolve(request(), 'svc_agent-hq')
    expect(grandfathered).toMatchObject({ data: { profile: { revision: 2 } } })
  })

  test('denies missing, stale-bound, and rejected decisions', async () => {
    const required = service({ policy: { required: true } })
    await expect(required.resolve(request(), 'svc_agent-hq')).rejects.toMatchObject({
      response: { code: 'PROFILE_APPROVAL_MISSING' },
    })

    const stale = service({ policy: { required: true }, decisions: [decision({ revision: 1 })] })
    await expect(stale.resolve(request(), 'svc_agent-hq')).rejects.toMatchObject({
      response: { code: 'PROFILE_APPROVAL_MISSING' },
    })

    const rejected = service({
      policy: { required: true },
      decisions: [decision({ decision: 'rejected' })],
    })
    await expect(rejected.resolve(request(), 'svc_agent-hq')).rejects.toMatchObject({
      response: { code: 'PROFILE_APPROVAL_REJECTED' },
    })
  })

  test('gates referenced skill versions independently of the profile', async () => {
    const skillDenied = service({
      policy: { required: true },
      decisions: [decision()],
    })
    await expect(skillDenied.resolve(request(), 'svc_agent-hq')).rejects.toMatchObject({
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
    const response = await bothApproved.resolve(request(), 'svc_agent-hq')
    expect(response).toMatchObject({
      data: { skillVersionIds: [skillVersion.skillVersionId] },
    })
  })
})
