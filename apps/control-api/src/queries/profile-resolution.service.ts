import { NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import {
  ProfileResolutionRequestSchema,
  ProfileResolutionResponseSchema,
} from '@control-plane/contracts'
import type { AgentProfileRepository, AgentProfileVersion } from '@control-plane/domain'

export const PROFILE_RESOLUTION_SERVICE = Symbol('PROFILE_RESOLUTION_SERVICE')

export interface ProfileResolutionService {
  resolve(input: unknown): Promise<unknown>
}

export class UnavailableProfileResolutionService implements ProfileResolutionService {
  async resolve(): Promise<never> {
    throw new ServiceUnavailableException({
      code: 'PROFILE_RESOLUTION_NOT_CONFIGURED',
      message: 'Profile resolution is not configured',
    })
  }
}

export class RepositoryProfileResolutionService implements ProfileResolutionService {
  constructor(
    private readonly profiles: Pick<
      AgentProfileRepository,
      'getAgentProfileVersion' | 'listAgentProfileVersions'
    >
  ) {}

  async resolve(inputValue: unknown) {
    const input = ProfileResolutionRequestSchema.parse(inputValue)
    const profile = await this.#resolveVersion(
      input.parameters.profileId,
      input.parameters.profileVersionId
    )
    if (profile === undefined || profile.lifecycle !== 'published') {
      throw new NotFoundException({
        code: 'PROFILE_VERSION_NOT_FOUND',
        message: 'Published profile version was not found',
      })
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

  async #resolveVersion(
    profileId: string,
    profileVersionId?: string
  ): Promise<AgentProfileVersion | undefined> {
    if (profileVersionId !== undefined) {
      const profile = await this.profiles.getAgentProfileVersion(profileVersionId)
      return profile?.profileId === profileId ? profile : undefined
    }
    return (await this.profiles.listAgentProfileVersions(profileId))
      .filter((profile) => profile.lifecycle === 'published')
      .toSorted((left, right) => right.version - left.version || right.revision - left.revision)[0]
  }
}
