import { createHash } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common'
import {
  canonicalJsonStringify,
  ModelSelectionFundingRequestSchema,
  ModelSelectionFundingResponseSchema,
  ModelSelectionFundingViewSchema,
  type ModelSelectionFundingView,
} from '@control-plane/contracts'
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
  /**
   * The pre-inference funding disclosure: the account, the auth mode and the
   * explicit funding owner of the accepted selection.
   *
   * It is always present so that an unconfigured host refuses it the same
   * bounded way it refuses every other model operation, instead of leaving a
   * caller to discover that the operation does not exist and to invent its own
   * refusal. A host without a funding view returns the bounded unavailability
   * below; it never discloses a payer, never falls back to another account,
   * model or provider, and never authorizes an inference.
   */
  funding(input: unknown, principalId: string): Promise<unknown>
  create(input: unknown, principalId: string): Promise<unknown>
  revoke(input: unknown, principalId: string): Promise<unknown>
  list(input: unknown, principalId: string): Promise<unknown>
  getDefaults(input: unknown, principalId: string): Promise<unknown>
  setDefaults(input: unknown, principalId: string): Promise<unknown>
  resolve(input: unknown, principalId: string): Promise<unknown>
}
export class UnavailableModelConnectionService implements ModelConnectionService {
  async funding() {
    return unavailable(FUNDING_NOT_CONFIGURED)
  }
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
    readonly administration?: ModelConnectionAdministration,
    readonly fundingView?: {
      /** Authenticate the transport reader against the accepted canonical intent/audience.
       * Resolve all execution/actor/plan/funding bindings from server-owned records.
       */
      resolve(input: {
        workspaceId: string
        principalId: string
        executionId: string
        attemptId: string
        selectionRef: string
        selectionRevision: number
      }): Promise<ModelSelectionFundingView>
    }
  ) {}
  async funding(input: unknown, principalId: string) {
    const request = parse(ModelSelectionFundingRequestSchema, input, principalId)
    if (!this.fundingView) return unavailable(FUNDING_NOT_CONFIGURED)
    const resolver = this.fundingView
    return safely(async () => {
      const funding = ModelSelectionFundingViewSchema.parse(
        await resolver.resolve({
          workspaceId: request.workspaceId,
          principalId,
          ...request.parameters,
        })
      )
      if (
        funding.workspaceId !== request.workspaceId ||
        funding.executionId !== request.parameters.executionId ||
        funding.attemptId !== request.parameters.attemptId ||
        funding.selectionRef !== request.parameters.selectionRef ||
        funding.selectionRevision !== request.parameters.selectionRevision
      )
        throw new ModelSelectionError('SELECTION_CHANGED')
      return ModelSelectionFundingResponseSchema.parse({ ...identity(request), data: { funding } })
    })
  }
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
/** The funding host is absent while the model host may still be present. */
const FUNDING_NOT_CONFIGURED = 'Model funding is not configured'
function unavailable(message = 'Model connections are not configured'): never {
  throw new ServiceUnavailableException({
    code: 'MODEL_CONNECTIONS_NOT_CONFIGURED',
    message,
  })
}
