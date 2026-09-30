import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'
import {
  GraphDefinitionPublishRequestSchema,
  GraphDefinitionDeprecationRequestSchema,
  GraphDefinitionRevocationRequestSchema,
  GraphDefinitionResolutionRequestSchema,
  GraphDefinitionResponseSchema,
  canonicalJsonStringify,
  type GraphDefinitionResponse,
} from '@control-plane/contracts'
import {
  GraphDefinitionCatalog,
  GraphCatalogError,
  PublishedGraphDefinitionSchema,
  type GraphDefinitionCommandRepository,
  type GraphDefinitionRepository,
  type PublishedGraphDefinition,
} from '@control-plane/orchestration'
import { redactTelemetryValue } from '@control-plane/telemetry'

export const GRAPH_ADMINISTRATION_SERVICE = Symbol('GRAPH_ADMINISTRATION_SERVICE')
export interface GraphAdministrationService {
  publish(input: unknown, principalId: string): Promise<GraphDefinitionResponse>
  deprecate(input: unknown, principalId: string): Promise<GraphDefinitionResponse>
  revoke(input: unknown, principalId: string): Promise<GraphDefinitionResponse>
  resolve(input: unknown, principalId: string): Promise<GraphDefinitionResponse>
}
export class UnavailableGraphAdministrationService implements GraphAdministrationService {
  async publish(): Promise<never> {
    return unavailable()
  }
  async deprecate(): Promise<never> {
    return unavailable()
  }
  async revoke(): Promise<never> {
    return unavailable()
  }
  async resolve(): Promise<never> {
    return unavailable()
  }
}

type MutationRequest =
  | ReturnType<typeof GraphDefinitionPublishRequestSchema.parse>
  | ReturnType<typeof GraphDefinitionDeprecationRequestSchema.parse>
  | ReturnType<typeof GraphDefinitionRevocationRequestSchema.parse>

/** HTTP guards own credential scopes; repositories are fixed to the authenticated workspace. */
export class RepositoryGraphAdministrationService implements GraphAdministrationService {
  readonly #now: () => Date
  constructor(
    readonly options: {
      readonly repository: (workspaceId: string) => GraphDefinitionCommandRepository
      readonly now?: () => Date
    }
  ) {
    this.#now = options.now ?? (() => new Date())
  }

  async publish(input: unknown, principalId: string) {
    const request = GraphDefinitionPublishRequestSchema.parse(input)
    return this.#mutate(request, principalId, 'publish', (repository) =>
      new GraphDefinitionCatalog(repository).publish({
        definition: request.payload.definition,
        publishedAt: this.#now().toISOString(),
      })
    )
  }

  async deprecate(input: unknown, principalId: string) {
    const request = GraphDefinitionDeprecationRequestSchema.parse(input)
    return this.#mutate(request, principalId, 'deprecate', (repository) =>
      this.#transition(repository, request.payload, 'deprecate')
    )
  }

  async revoke(input: unknown, principalId: string) {
    const request = GraphDefinitionRevocationRequestSchema.parse(input)
    return this.#mutate(request, principalId, 'revoke', (repository) =>
      this.#transition(repository, request.payload, 'revoke')
    )
  }

  async resolve(input: unknown, principalId: string) {
    const request = GraphDefinitionResolutionRequestSchema.parse(input)
    assertCaller(request, principalId)
    try {
      // Catalog inspection retains revoked pins; it does not grant new execution admission.
      const definition = await new GraphDefinitionCatalog(
        this.options.repository(request.workspaceId)
      ).getPinned(request.parameters.reference)
      return response(request, definition)
    } catch (error) {
      throw publicError(error)
    }
  }

  async #transition(
    repository: GraphDefinitionRepository,
    payload: ReturnType<typeof GraphDefinitionDeprecationRequestSchema.parse>['payload'],
    operation: 'deprecate' | 'revoke'
  ) {
    const catalog = new GraphDefinitionCatalog(repository)
    const current = await catalog.getPinned(payload.reference)
    // A backward clock adjustment cannot make a lifecycle timestamp regress.
    const changedAt = new Date(
      Math.max(this.#now().getTime(), Date.parse(current.changedAt))
    ).toISOString()
    return catalog[operation]({ ...payload, changedAt })
  }

  async #mutate(
    request: MutationRequest,
    principalId: string,
    operation: 'publish' | 'deprecate' | 'revoke',
    action: (repository: GraphDefinitionRepository) => Promise<PublishedGraphDefinition>
  ) {
    assertCaller(request, principalId)
    if (!isDeepStrictEqual(redactTelemetryValue(request.payload), request.payload)) {
      throw new UnprocessableEntityException({
        code: 'GRAPH_CREDENTIAL_INPUT_REJECTED',
        message: 'Graph catalog input cannot contain credentials',
      })
    }
    const payloadHash = createHash('sha256')
      .update(
        canonicalJsonStringify([
          request.workspaceId,
          principalId,
          request.operation,
          request.payload,
        ])
      )
      .digest('hex')
    try {
      const result = await this.options.repository(request.workspaceId).executeCommand(
        {
          callerId: principalId,
          operation,
          idempotencyKey: request.idempotencyKey,
          payloadHash,
        },
        action
      )
      return response(request, result)
    } catch (error) {
      throw publicError(error)
    }
  }
}

function assertCaller(request: { caller: { servicePrincipalId: string } }, principalId: string) {
  if (!principalId || request.caller.servicePrincipalId !== principalId) {
    throw new ForbiddenException({
      code: 'GRAPH_CALLER_MISMATCH',
      message: 'Graph caller is not authorized',
    })
  }
}
function response(
  request: {
    contractVersion: { major: number; minor: number }
    requestId: string
    correlation: unknown
  },
  definition: unknown
) {
  return GraphDefinitionResponseSchema.parse({
    contractVersion: request.contractVersion,
    requestId: request.requestId,
    correlation: request.correlation,
    data: { definition: PublishedGraphDefinitionSchema.parse(definition) },
  })
}
function publicError(error: unknown): unknown {
  if (!(error instanceof GraphCatalogError)) return error
  if (error.code === 'GRAPH_NOT_FOUND' || error.code === 'GRAPH_DIGEST_MISMATCH') {
    return new NotFoundException({
      code: 'GRAPH_VERSION_NOT_FOUND',
      message: 'Graph version was not found',
    })
  }
  return new ConflictException({
    code: error.code,
    message: 'Graph catalog command conflicts with retained state',
  })
}
function unavailable(): never {
  throw new ServiceUnavailableException({
    code: 'GRAPH_ADMINISTRATION_NOT_CONFIGURED',
    message: 'Graph administration is not configured',
  })
}
