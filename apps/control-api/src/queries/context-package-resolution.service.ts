import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import {
  ContextPackageResolutionRequestSchema,
  ContextPackageResolutionResponseSchema,
} from '@control-plane/contracts'
import type { ContextPackageRepository } from '@control-plane/context'

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
    if (
      input.projectId === undefined ||
      package_.projectState.projectId === undefined ||
      package_.projectState.workspaceId !== input.workspaceId ||
      package_.projectState.projectId !== input.projectId
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
