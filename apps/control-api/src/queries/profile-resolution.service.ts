import { NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import {
  ProfileResolutionRequestSchema,
  ProfileResolutionResponseSchema,
} from '@control-plane/contracts'
import type {
  AgentProfileRepository,
  AgentProfileVersion,
  SkillRepository,
} from '@control-plane/domain'
import { catalogOwnershipAllowsAccess } from '@control-plane/domain'
import {
  assertCatalogVersionApproved,
  type CatalogApprovalGateOptions,
} from './catalog-approval-gate.js'

export const PROFILE_RESOLUTION_SERVICE = Symbol('PROFILE_RESOLUTION_SERVICE')

export interface ProfileResolutionService {
  resolve(input: unknown, callerPrincipalId: string): Promise<unknown>
}

export class UnavailableProfileResolutionService implements ProfileResolutionService {
  async resolve(): Promise<never> {
    throw new ServiceUnavailableException({
      code: 'PROFILE_RESOLUTION_NOT_CONFIGURED',
      message: 'Profile resolution is not configured',
    })
  }
}

/**
 * Approval gate for the public resolution path (#188). Absent options mean
 * nothing is enforced; a policy with `required: true` denies resolution of
 * profile or skill versions without a matching approval, using the shared
 * `evaluateCatalogApproval` semantics (explicit decisions win, dated-cutover
 * grandfathering, fail closed otherwise). Enforcement here gates consumption
 * of published versions — authoring and publishing flows are unaffected.
 */
export interface ProfileApprovalGateOptions extends CatalogApprovalGateOptions {
  readonly skills: Pick<SkillRepository, 'getSkillVersion'>
}

export class RepositoryProfileResolutionService implements ProfileResolutionService {
  constructor(
    private readonly catalog: Pick<
      AgentProfileRepository,
      'getAgentProfile' | 'getAgentProfileVersion' | 'listAgentProfileVersions'
    > &
      Pick<SkillRepository, 'getSkill' | 'getSkillVersion'>,
    private readonly approvalGate?: ProfileApprovalGateOptions
  ) {}

  async resolve(inputValue: unknown, callerPrincipalId: string) {
    const input = ProfileResolutionRequestSchema.parse(inputValue)
    if (callerPrincipalId.length === 0) notFound()
    const profile = await this.#resolveVersion(
      input.parameters.profileId,
      input.parameters.profileVersionId
    )
    if (profile === undefined || profile.lifecycle !== 'published') {
      notFound()
    }
    const [profileOwner, linkedSkills] = await Promise.all([
      this.catalog.getAgentProfile(profile.profileId),
      Promise.all(
        profile.definition.skills.map(async (reference) => {
          const skillVersion = await this.catalog.getSkillVersion(reference.skillVersionId)
          if (skillVersion === undefined || skillVersion.skillId !== reference.skillId)
            return undefined
          const skillOwner = await this.catalog.getSkill(skillVersion.skillId)
          return skillOwner?.skillId === skillVersion.skillId &&
            catalogOwnershipAllowsAccess(skillOwner.ownership, {
              workspaceId: input.workspaceId,
              principalId: callerPrincipalId,
            })
            ? skillVersion
            : undefined
        })
      ),
    ])
    if (
      profileOwner?.profileId !== profile.profileId ||
      !catalogOwnershipAllowsAccess(profileOwner.ownership, {
        workspaceId: input.workspaceId,
        principalId: callerPrincipalId,
      }) ||
      linkedSkills.some((skill) => skill === undefined)
    ) {
      notFound()
    }
    if (this.approvalGate !== undefined) {
      await this.#assertApproved('agent_profile', 'PROFILE', profile.profileVersionId, {
        revision: profile.revision,
        contentDigest: profile.contentDigest,
        publishedAt: profile.lifecycleMetadata.publishedAt,
      })
      for (const [index, { skillVersionId }] of profile.definition.skills.entries()) {
        const skill = linkedSkills[index]
        await this.#assertApproved('skill', 'SKILL', skillVersionId, {
          revision: skill?.revision ?? 0,
          contentDigest: skill?.manifest.contentDigest ?? '',
          publishedAt: skill?.lifecycleMetadata.publishedAt,
        })
      }
    }
    return ProfileResolutionResponseSchema.parse({
      contractVersion: input.contractVersion,
      requestId: input.requestId,
      correlation: input.correlation,
      data: {
        profile: {
          profileId: profile.profileId,
          profileVersionId: profile.profileVersionId,
          version: profile.version,
          revision: profile.revision,
          schemaVersion: profile.definition.schemaVersion,
          contentDigest: profile.contentDigest,
          lifecycle: 'published',
        },
        skillVersionIds: profile.definition.skills.map(({ skillVersionId }) => skillVersionId),
      },
    })
  }

  async #assertApproved(
    kind: 'agent_profile' | 'skill',
    label: 'PROFILE' | 'SKILL',
    versionId: string,
    version: {
      readonly revision: number
      readonly contentDigest: string
      readonly publishedAt: string | undefined
    }
  ): Promise<void> {
    const gate = this.approvalGate
    if (gate === undefined) return
    await assertCatalogVersionApproved(gate, label, kind, versionId, version)
  }

  async #resolveVersion(
    profileId: string,
    profileVersionId?: string
  ): Promise<AgentProfileVersion | undefined> {
    if (profileVersionId !== undefined) {
      const profile = await this.catalog.getAgentProfileVersion(profileVersionId)
      return profile?.profileId === profileId ? profile : undefined
    }
    return (await this.catalog.listAgentProfileVersions(profileId))
      .filter((profile) => profile.lifecycle === 'published')
      .toSorted((left, right) => right.version - left.version || right.revision - left.revision)[0]
  }
}

function notFound(): never {
  throw new NotFoundException({
    code: 'PROFILE_VERSION_NOT_FOUND',
    message: 'Published profile version was not found',
  })
}
