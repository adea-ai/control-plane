import { createHash } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common'
import {
  ProjectStateInitializationRequestSchema,
  ProjectStateInitializationResponseSchema,
  canonicalJsonStringify,
  type ProjectStateInitializationResponse,
} from '@control-plane/contracts'
import {
  ProjectStateError,
  initializeProjectStateOnce,
  type ProjectStateInitializationRepository,
} from '@control-plane/domain'

export const PROJECT_STATE_INITIALIZATION_SERVICE = Symbol('PROJECT_STATE_INITIALIZATION_SERVICE')

export interface ProjectStateInitializationService {
  initialize(input: unknown, principalId: string): Promise<ProjectStateInitializationResponse>
}

export class UnavailableProjectStateInitializationService implements ProjectStateInitializationService {
  async initialize(): Promise<never> {
    throw new ServiceUnavailableException({
      code: 'PROJECT_STATE_INITIALIZATION_NOT_CONFIGURED',
      message: 'ProjectState initialization is not configured',
    })
  }
}

/**
 * Creates the empty revision-zero ProjectState for the authenticated envelope's project. The
 * HTTP guard owns the `project-state:initialize` scope and workspace/project grants; this service
 * binds the caller assertion, verifies the envelope payload hash and derives the receipt hash
 * from the authenticated principal so a replay by another caller cannot claim the receipt.
 */
export class RepositoryProjectStateInitializationService implements ProjectStateInitializationService {
  readonly #now: () => Date

  constructor(
    readonly repository: ProjectStateInitializationRepository,
    options: { readonly now?: () => Date } = {}
  ) {
    this.#now = options.now ?? (() => new Date())
  }

  async initialize(input: unknown, principalId: string) {
    const request = ProjectStateInitializationRequestSchema.parse(input)
    if (!principalId || request.caller.servicePrincipalId !== principalId) {
      throw new ForbiddenException({
        code: 'PROJECT_STATE_CALLER_MISMATCH',
        message: 'ProjectState caller is not authorized',
      })
    }
    if (sha256(canonicalJsonStringify(request.payload)) !== request.payloadHash) {
      throw new BadRequestException({
        code: 'PROJECT_STATE_PAYLOAD_HASH_MISMATCH',
        message: 'Command payload hash does not match its payload',
      })
    }
    const payloadHash = sha256(
      canonicalJsonStringify([
        request.workspaceId,
        request.projectId,
        principalId,
        request.operation,
        request.payload,
      ])
    )
    try {
      const { receipt } = await initializeProjectStateOnce(this.repository, {
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        callerId: principalId,
        commandId: request.commandId,
        idempotencyKey: request.idempotencyKey,
        payloadHash,
        at: this.#now().toISOString(),
      })
      return ProjectStateInitializationResponseSchema.parse({
        contractVersion: request.contractVersion,
        requestId: request.requestId,
        correlation: request.correlation,
        data: {
          projectState: {
            workspaceId: receipt.workspaceId,
            projectId: receipt.projectId,
            revision: 0,
          },
          commandId: receipt.commandId,
          initializedAt: receipt.initializedAt,
        },
      })
    } catch (error) {
      throw publicError(error)
    }
  }
}

function publicError(error: unknown): unknown {
  if (!(error instanceof ProjectStateError)) return error
  if (error.code === 'PROJECT_STATE_EXISTS') {
    return new ConflictException({
      code: 'PROJECT_STATE_ALREADY_INITIALIZED',
      message: 'ProjectState is already initialized for this project',
    })
  }
  if (error.code === 'INITIALIZATION_IDEMPOTENCY_CONFLICT') {
    return new ConflictException({
      code: 'PROJECT_STATE_IDEMPOTENCY_CONFLICT',
      message: 'Idempotency key was reused with a different command',
    })
  }
  return error
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
