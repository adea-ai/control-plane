import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import {
  ExternalSessionDiscoveryReadModelSchema,
  ExternalSessionGetRequestSchema,
  ExternalSessionGetResponseSchema,
  ExternalSessionListRequestSchema,
  ExternalSessionListResponseSchema,
  RuntimeConnectionDiscoveryReadModelSchema,
  RuntimeConnectionGetRequestSchema,
  RuntimeConnectionGetResponseSchema,
  RuntimeConnectionListRequestSchema,
  RuntimeConnectionListResponseSchema,
  RuntimeListRequestSchema,
  RuntimeListResponseSchema,
  type RuntimeConnectionDiscoveryReadModel,
} from '@control-plane/contracts'
import {
  RUNTIME_DISCOVERY_REPOSITORY,
  type RuntimeDiscoveryRepository,
  type RuntimeDiscoveryScope,
} from './runtime-discovery.repository.js'

@Injectable()
export class RuntimeDiscoveryService {
  constructor(
    @Inject(RUNTIME_DISCOVERY_REPOSITORY)
    private readonly repository: RuntimeDiscoveryRepository
  ) {}

  async listRuntimes(inputValue: unknown) {
    const input = RuntimeListRequestSchema.parse(inputValue)
    const models = (await this.repository.listRuntimeConnections(toScope(input)))
      .map((model) => RuntimeConnectionDiscoveryReadModelSchema.parse(model))
      .flatMap((model) => {
        if (
          model.node === undefined ||
          (input.parameters.status !== undefined && model.status !== input.parameters.status) ||
          !input.parameters.requiredCapabilities.every((capability) =>
            model.capabilities.includes(capability)
          )
        ) {
          return []
        }
        return [
          {
            runtimeNodeRefId: model.node.runtimeNodeRefId,
            runtimeConnectionId: model.runtimeConnectionId,
            runtimeDefinitionId: model.runtimeDefinitionId,
            family: model.family,
            location: model.node.location,
            status: model.status,
            observedAt: model.observedAt,
            capabilities: model.capabilities,
            limitations: model.limitations,
          },
        ]
      })
      .toSorted((left, right) => left.runtimeNodeRefId.localeCompare(right.runtimeNodeRefId))
    return RuntimeListResponseSchema.parse({
      ...responseContext(input),
      data: { runtimes: models },
    })
  }

  async listRuntimeConnections(inputValue: unknown) {
    const input = RuntimeConnectionListRequestSchema.parse(inputValue)
    const scope = toScope(input, input.parameters.runtimeNodeRefId)
    const models = (await this.repository.listRuntimeConnections(scope))
      .map((model) => RuntimeConnectionDiscoveryReadModelSchema.parse(model))
      .filter((model) => matchesRuntimeFilters(model, input.parameters))
      .toSorted((left, right) => left.runtimeConnectionId.localeCompare(right.runtimeConnectionId))
    const page = paginate(models, input.parameters.cursor, input.parameters.limit, (model) =>
      String(model.runtimeConnectionId)
    )
    return RuntimeConnectionListResponseSchema.parse({
      ...responseContext(input),
      data: { runtimeConnections: page.items, page: page.metadata },
    })
  }

  async getRuntimeConnection(inputValue: unknown) {
    const input = RuntimeConnectionGetRequestSchema.parse(inputValue)
    const model = await this.repository.getRuntimeConnection(
      toScope(input, input.parameters.runtimeNodeRefId),
      input.parameters.runtimeConnectionId
    )
    if (model === undefined) throw notFound('RUNTIME_CONNECTION_NOT_FOUND')
    return RuntimeConnectionGetResponseSchema.parse({
      ...responseContext(input),
      data: { runtimeConnection: RuntimeConnectionDiscoveryReadModelSchema.parse(model) },
    })
  }

  async listExternalSessions(inputValue: unknown) {
    const input = ExternalSessionListRequestSchema.parse(inputValue)
    const scope = toScope(input, input.parameters.runtimeNodeRefId)
    const models = (await this.repository.listExternalSessions(scope))
      .map((model) => ExternalSessionDiscoveryReadModelSchema.parse(model))
      .filter(
        (model) =>
          (input.parameters.runtimeConnectionId === undefined ||
            model.runtimeConnectionId === input.parameters.runtimeConnectionId) &&
          (input.parameters.states.length === 0 || input.parameters.states.includes(model.state))
      )
      .toSorted((left, right) => left.externalSessionId.localeCompare(right.externalSessionId))
    const page = paginate(models, input.parameters.cursor, input.parameters.limit, (model) =>
      String(model.externalSessionId)
    )
    return ExternalSessionListResponseSchema.parse({
      ...responseContext(input),
      data: { externalSessions: page.items, page: page.metadata },
    })
  }

  async getExternalSession(inputValue: unknown) {
    const input = ExternalSessionGetRequestSchema.parse(inputValue)
    const model = await this.repository.getExternalSession(
      toScope(input, input.parameters.runtimeNodeRefId),
      input.parameters.externalSessionId
    )
    if (model === undefined) throw notFound('EXTERNAL_SESSION_NOT_FOUND')
    return ExternalSessionGetResponseSchema.parse({
      ...responseContext(input),
      data: { externalSession: ExternalSessionDiscoveryReadModelSchema.parse(model) },
    })
  }
}

function toScope(
  input: { readonly workspaceId: string; readonly projectId?: string | undefined },
  runtimeNodeRefId?: string
): RuntimeDiscoveryScope {
  return {
    workspaceId: input.workspaceId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(runtimeNodeRefId === undefined ? {} : { runtimeNodeRefId }),
  }
}

function responseContext(input: {
  readonly contractVersion: { readonly major: number; readonly minor: number }
  readonly requestId: string
  readonly correlation: unknown
}) {
  return {
    contractVersion: input.contractVersion,
    requestId: input.requestId,
    correlation: input.correlation,
  }
}

function matchesRuntimeFilters(
  model: RuntimeConnectionDiscoveryReadModel,
  filters: {
    readonly states: readonly string[]
    readonly requiredCapabilities: readonly string[]
  }
): boolean {
  const states = new Set([
    model.status,
    model.freshness.state,
    model.connection.availability === 'offline' || model.connection.availability === 'reconnecting'
      ? 'offline'
      : model.connection.availability,
  ])
  const matchesState =
    filters.states.length === 0 || filters.states.some((state) => states.has(state))
  const supported = new Set(
    model.capabilityDetails
      .filter((capability) => capability.support !== 'unsupported')
      .map((capability) => capability.name)
  )
  return (
    matchesState && filters.requiredCapabilities.every((capability) => supported.has(capability))
  )
}

function paginate<Model>(
  models: readonly Model[],
  cursor: string | undefined,
  limit: number,
  identity: (model: Model) => string
): { readonly items: readonly Model[]; readonly metadata: { readonly nextCursor?: string } } {
  const after = cursor === undefined ? undefined : decodeCursor(cursor)
  const start = after === undefined ? 0 : models.findIndex((model) => identity(model) === after) + 1
  if (after !== undefined && start === 0) {
    throw new BadRequestException({
      code: 'INVALID_CURSOR',
      message: 'Pagination cursor is invalid',
    })
  }
  const items = models.slice(start, start + limit)
  const hasMore = start + items.length < models.length
  const lastItem = items.at(-1)
  return {
    items,
    metadata:
      hasMore && lastItem !== undefined ? { nextCursor: encodeCursor(identity(lastItem)) } : {},
  }
}

function encodeCursor(identity: string): string {
  return `cur_${Buffer.from(identity, 'utf8').toString('base64url')}`
}

function decodeCursor(cursor: string): string {
  try {
    const decoded = Buffer.from(cursor.slice(4), 'base64url').toString('utf8')
    if (decoded.length === 0 || encodeCursor(decoded) !== cursor) throw new Error('invalid cursor')
    return decoded
  } catch {
    throw new BadRequestException({
      code: 'INVALID_CURSOR',
      message: 'Pagination cursor is invalid',
    })
  }
}

function notFound(code: string): NotFoundException {
  return new NotFoundException({ code, message: 'Discovery resource was not found' })
}
