import { createHash } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { canonicalJsonStringify } from '@control-plane/contracts'
import {
  ModelConnectionCreateRequestSchema,
  ModelConnectionRevokeRequestSchema,
  ModelConnectionResponseSchema,
  type ModelConnectionAdministration,
  ModelConnectionListRequestSchema,
  ModelConnectionListResponseSchema,
  ModelDefaultsGetRequestSchema,
  ModelDefaultsSetRequestSchema,
  ModelDefaultsResponseSchema,
  ModelSelectionResolveRequestSchema,
  ModelSelectionResponseSchema,
  ModelSelectionError,
  type ModelSelectionService,
} from '@control-plane/model-gateway'

export const MODEL_CONNECTION_SERVICE = Symbol('MODEL_CONNECTION_SERVICE')
export interface ModelConnectionService {
  create(input: unknown, principalId: string): Promise<unknown>
  revoke(input: unknown, principalId: string): Promise<unknown>
  list(input: unknown, principalId: string): Promise<unknown>
  getDefaults(input: unknown, principalId: string): Promise<unknown>
  setDefaults(input: unknown, principalId: string): Promise<unknown>
  resolve(input: unknown, principalId: string): Promise<unknown>
}
export class UnavailableModelConnectionService implements ModelConnectionService {
  async create() {
    return unavailable()
  }
  async revoke() {
    return unavailable()
  }
  async list() {
    return unavailable()
  }
  async getDefaults() {
    return unavailable()
  }
  async setDefaults() {
    return unavailable()
  }
  async resolve() {
    return unavailable()
  }
}
export class ConfiguredModelConnectionService implements ModelConnectionService {
  constructor(
    readonly selections: ModelSelectionService,
    readonly administration?: ModelConnectionAdministration
  ) {}
  async create(input: unknown, principalId: string) {
    const request = parse(ModelConnectionCreateRequestSchema, input, principalId)
    return safely(async () => {
      if (!this.administration) return unavailable()
      const ref = createHash('sha256')
        .update(canonicalJsonStringify([request.workspaceId, principalId, request.idempotencyKey]))
        .digest('hex')
        .slice(0, 32)
      const connection = await this.administration.connect({
        workspaceId: request.workspaceId,
        principalRef: principalId,
        ...request.payload,
        connectionRef: `mconn_${ref}`,
      })
      return ModelConnectionResponseSchema.parse({ ...identity(request), data: { connection } })
    })
  }
  async revoke(input: unknown, principalId: string) {
    const request = parse(ModelConnectionRevokeRequestSchema, input, principalId)
    return safely(async () => {
      if (!this.administration) return unavailable()
      const connection = await this.administration.revoke({
        workspaceId: request.workspaceId,
        principalRef: principalId,
        ...request.payload,
      })
      return ModelConnectionResponseSchema.parse({ ...identity(request), data: { connection } })
    })
  }
  async list(input: unknown, principalId: string) {
    const request = parse(ModelConnectionListRequestSchema, input, principalId)
    return safely(async () =>
      ModelConnectionListResponseSchema.parse({
        ...identity(request),
        data: {
          connections: await this.selections.list(request.workspaceId, request.parameters.target),
        },
      })
    )
  }
  async getDefaults(input: unknown, principalId: string) {
    const request = parse(ModelDefaultsGetRequestSchema, input, principalId)
    return safely(async () =>
      ModelDefaultsResponseSchema.parse({
        ...identity(request),
        data: { defaults: (await this.selections.getDefaults(request.workspaceId)) ?? null },
      })
    )
  }
  async setDefaults(input: unknown, principalId: string) {
    const request = parse(ModelDefaultsSetRequestSchema, input, principalId)
    const { expectedRevision, ...choices } = request.payload
    return safely(async () => {
      const next = { workspaceId: request.workspaceId, revision: expectedRevision + 1, ...choices }
      const current = await this.selections.getDefaults(request.workspaceId)
      const defaults =
        current && canonicalJsonStringify(current) === canonicalJsonStringify(next)
          ? current
          : await this.selections.setDefaults(expectedRevision, next)
      return ModelDefaultsResponseSchema.parse({ ...identity(request), data: { defaults } })
    })
  }
  async resolve(input: unknown, principalId: string) {
    const request = parse(ModelSelectionResolveRequestSchema, input, principalId)
    return safely(async () =>
      ModelSelectionResponseSchema.parse({
        ...identity(request),
        data: {
          selection: await this.selections.select({
            workspaceId: request.workspaceId,
            ...request.parameters,
          }),
        },
      })
    )
  }
}
function parse<Value>(
  schema: { safeParse(input: unknown): { success: true; data: Value } | { success: false } },
  input: unknown,
  principalId: string
): Value {
  const result = schema.safeParse(input)
  if (!result.success)
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Model request validation failed',
    })
  const value = result.data as Value & { caller: { servicePrincipalId: string } }
  if (!principalId || value.caller.servicePrincipalId !== principalId)
    throw new ForbiddenException({
      code: 'MODEL_CALLER_MISMATCH',
      message: 'Model caller is not authorized',
    })
  return result.data
}
function identity(request: { contractVersion: unknown; requestId: string; correlation: unknown }) {
  return {
    contractVersion: request.contractVersion,
    requestId: request.requestId,
    correlation: request.correlation,
  }
}
async function safely<Value>(operation: () => Promise<Value>): Promise<Value> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof ModelSelectionError)
      throw new ConflictException({ code: error.code, message: 'Model selection is not ready' })
    throw new ServiceUnavailableException({
      code: 'READINESS_UNAVAILABLE',
      message: 'Model readiness is unavailable',
    })
  }
}
function unavailable(): never {
  throw new ServiceUnavailableException({
    code: 'MODEL_CONNECTIONS_NOT_CONFIGURED',
    message: 'Model connections are not configured',
  })
}
