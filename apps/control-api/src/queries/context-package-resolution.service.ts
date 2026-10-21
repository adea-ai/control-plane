import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import {
  ContextPackageResolutionRequestSchema,
  ContextPackageResolutionResponseSchema,
} from '@control-plane/contracts'
import {
  assertContextPackageIntegrity,
  contextPackageMatchesConsumerScope,
  type ContextPackageRepository,
} from '@control-plane/context'

export const CONTEXT_PACKAGE_RESOLUTION_SERVICE = Symbol('CONTEXT_PACKAGE_RESOLUTION_SERVICE')

export interface ContextPackageResolutionService {
  resolve(input: unknown): Promise<unknown>
}

export class UnavailableContextPackageResolutionService implements ContextPackageResolutionService {
  async resolve(): Promise<never> {
    throw new ServiceUnavailableException({
      code: 'CONTEXT_PACKAGE_RESOLUTION_NOT_CONFIGURED',
      message: 'ContextPackage resolution is not configured',
    })
  }
}

export class RepositoryContextPackageResolutionService implements ContextPackageResolutionService {
  constructor(private readonly packages: Pick<ContextPackageRepository, 'getById'>) {}

  async resolve(inputValue: unknown) {
    const input = ContextPackageResolutionRequestSchema.parse(inputValue)
    const package_ = await this.packages.getById(input.parameters.contextPackageId)
    if (package_ === undefined) {
      throw new NotFoundException({
        code: 'CONTEXT_PACKAGE_NOT_FOUND',
        message: 'ContextPackage was not found',
      })
    }
    // An immutable reference is only published when the stored content still
    // verifies against the digest it is published under. A package whose
    // content does not verify is not resolvable, so it is denied here rather
    // than handed to a consumer that could not check it.
    try {
      assertContextPackageIntegrity(package_)
    } catch {
      throw new NotFoundException({
        code: 'CONTEXT_PACKAGE_NOT_FOUND',
        message: 'ContextPackage was not found',
      })
    }
    if (
      input.projectId === undefined ||
      !contextPackageMatchesConsumerScope(package_, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      })
    ) {
      throw new ForbiddenException({
        code: 'CONTEXT_PACKAGE_SCOPE_MISMATCH',
        message: 'ContextPackage is outside the authorized project scope',
      })
    }
    return ContextPackageResolutionResponseSchema.parse({
      contractVersion: input.contractVersion,
      requestId: input.requestId,
      correlation: input.correlation,
      data: {
        contextPackage: {
          contextPackageId: package_.contextPackageId,
          contentDigest: package_.contentDigest,
          schemaVersion: package_.schemaVersion,
          compilerVersion: package_.compiler.version,
        },
      },
    })
  }
}
