import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'

const Timestamp = z.iso.datetime()
const Principal = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/)
const Reference = z
  .string()
  .max(512)
  .regex(/^[a-z][a-z0-9+.-]*:\/\/\S+$/)
export const InteractionKindSchema = z.enum(['approval', 'input', 'permission', 'resume', 'cancel'])
export const InteractionActionSchema = z.enum([
  'approve',
  'deny',
  'input',
  'grant',
  'resume',
  'cancel',
])
export const InteractionStateSchema = z.enum(['pending', 'responded', 'expired', 'cancelled'])
const allowedActionsByKind = {
  approval: new Set(['approve', 'deny', 'cancel']),
  input: new Set(['input', 'cancel']),
  permission: new Set(['grant', 'deny', 'cancel']),
  resume: new Set(['resume', 'cancel']),
  cancel: new Set(['cancel']),
} as const
const ResponseSchema = z
  .object({
    responseId: IdentifierSchemas.commandId,
    action: InteractionActionSchema,
    respondingPrincipalId: Principal,
    respondedAt: Timestamp,
    value: z.json().optional(),
  })
  .superRefine((response, context) => {
    if ((response.action === 'input') !== (response.value !== undefined))
      context.addIssue({
        code: 'custom',
        message: 'Input action requires only bounded structured input',
      })
    if (response.value !== undefined && Buffer.byteLength(JSON.stringify(response.value)) > 8_192)
      context.addIssue({ code: 'custom', message: 'Interaction input exceeds 8 KiB' })
  })

export const InteractionRequestSchema = z
  .object({
    interactionId: IdentifierSchemas.interactionId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    kind: InteractionKindSchema,
    prompt: z.object({ title: z.string().min(1).max(160), detailsReference: Reference.optional() }),
    allowedActions: z.array(InteractionActionSchema).min(1).max(6),
    allowedPrincipalIds: z.array(Principal).min(1).max(64),
    state: InteractionStateSchema,
    version: z.number().int().positive(),
    requestedAt: Timestamp,
    expiresAt: Timestamp,
    response: ResponseSchema.optional(),
    resolvedAt: Timestamp.optional(),
  })
  .superRefine((request, context) => {
    if (Date.parse(request.expiresAt) <= Date.parse(request.requestedAt))
      context.addIssue({ code: 'custom', message: 'Interaction expiry must follow request' })
    if ((request.state === 'responded') !== (request.response !== undefined))
      context.addIssue({ code: 'custom', message: 'Responded state requires a response' })
    if ((request.state === 'expired' || request.state === 'cancelled') && !request.resolvedAt)
      context.addIssue({ code: 'custom', message: 'Resolved state requires timestamp' })
    if (
      request.allowedActions.some(
        (action) => !(allowedActionsByKind[request.kind] as ReadonlySet<string>).has(action)
      )
    )
      context.addIssue({ code: 'custom', message: 'Action is not valid for interaction kind' })
  })
export type InteractionRequest = z.output<typeof InteractionRequestSchema>

export interface InteractionRepository {
  insert(request: InteractionRequest): Promise<boolean>
  get(interactionId: string): Promise<InteractionRequest | undefined>
  compareAndSet(expectedVersion: number, request: InteractionRequest): Promise<boolean>
}
export class InMemoryInteractionRepository implements InteractionRepository {
  readonly #requests = new Map<string, InteractionRequest>()
  async insert(request: InteractionRequest) {
    if (this.#requests.has(request.interactionId)) return false
    this.#requests.set(request.interactionId, clone(request))
    return true
  }
  async get(id: string) {
    return cloneOptional(this.#requests.get(id))
  }
  async listForAttempt(executionId: string, attemptId: string): Promise<InteractionRequest[]> {
    return [...this.#requests.values()]
      .filter((request) => request.executionId === executionId && request.attemptId === attemptId)
      .map((request) => clone(request))
  }
  async compareAndSet(version: number, request: InteractionRequest) {
    if (this.#requests.get(request.interactionId)?.version !== version) return false
    this.#requests.set(request.interactionId, clone(request))
    return true
  }
}

export type InteractionErrorCode =
  | 'INTERACTION_EXISTS'
  | 'INTERACTION_MISSING'
  | 'INTERACTION_EXPIRED'
  | 'STALE_INTERACTION_VERSION'
  | 'WRONG_INTERACTION_ATTEMPT'
  | 'UNAUTHORIZED_INTERACTION_RESPONSE'
  | 'INVALID_INTERACTION_ACTION'
  | 'INTERACTION_RESPONSE_CONFLICT'
  | 'INTERACTION_TERMINAL'
export class InteractionError extends Error {
  constructor(
    readonly code: InteractionErrorCode,
    readonly currentVersion?: number
  ) {
    super(code)
    this.name = 'InteractionError'
  }
}

const CreateSchema = z
  .object(InteractionRequestSchema.shape)
  .omit({ state: true, version: true, response: true, resolvedAt: true })
const RespondSchema = z.object({
  interactionId: IdentifierSchemas.interactionId,
  executionId: IdentifierSchemas.executionId,
  attemptId: IdentifierSchemas.attemptId,
  responseId: IdentifierSchemas.commandId,
  action: InteractionActionSchema,
  respondingPrincipalId: Principal,
  expectedVersion: z.number().int().positive(),
  respondedAt: Timestamp,
  value: z.json().optional(),
})

export class InteractionService {
  constructor(readonly repository: InteractionRepository) {}
  async request(input: unknown) {
    const parsed = CreateSchema.parse(input)
    const request = InteractionRequestSchema.parse({ ...parsed, state: 'pending', version: 1 })
    if (!(await this.repository.insert(request))) fail('INTERACTION_EXISTS')
    return request
  }
  async respond(input: unknown) {
    const parsed = RespondSchema.parse(input)
    const current = await this.#get(parsed.interactionId)
    if (current.response) {
      if (sameResponse(current.response, parsed)) return current
      fail('INTERACTION_RESPONSE_CONFLICT')
    }
    if (current.state !== 'pending') fail('INTERACTION_TERMINAL')
    if (current.executionId !== parsed.executionId || current.attemptId !== parsed.attemptId)
      fail('WRONG_INTERACTION_ATTEMPT')
    if (current.version !== parsed.expectedVersion)
      fail('STALE_INTERACTION_VERSION', current.version)
    if (Date.parse(parsed.respondedAt) >= Date.parse(current.expiresAt)) fail('INTERACTION_EXPIRED')
    if (!current.allowedPrincipalIds.includes(parsed.respondingPrincipalId))
      fail('UNAUTHORIZED_INTERACTION_RESPONSE')
    if (!current.allowedActions.includes(parsed.action)) fail('INVALID_INTERACTION_ACTION')
    const response = ResponseSchema.parse(parsed)
    return this.#save(
      current,
      InteractionRequestSchema.parse({
        ...current,
        state: 'responded',
        version: current.version + 1,
        response,
        resolvedAt: parsed.respondedAt,
      })
    )
  }
  async expire(id: string, at: string) {
    const current = await this.#get(id)
    if (current.state === 'expired') return current
    if (current.state !== 'pending') fail('INTERACTION_TERMINAL')
    if (Date.parse(at) < Date.parse(current.expiresAt)) fail('INTERACTION_EXPIRED')
    return this.#save(
      current,
      InteractionRequestSchema.parse({
        ...current,
        state: 'expired',
        version: current.version + 1,
        resolvedAt: at,
      })
    )
  }
  async resolveTerminal(id: string, at: string) {
    const current = await this.#get(id)
    if (current.state !== 'pending') return current
    return this.#save(
      current,
      InteractionRequestSchema.parse({
        ...current,
        state: 'cancelled',
        version: current.version + 1,
        resolvedAt: at,
      })
    )
  }
  async #save(current: InteractionRequest, next: InteractionRequest) {
    if (await this.repository.compareAndSet(current.version, next)) return next
    const latest = await this.repository.get(current.interactionId)
    if (latest?.response && next.response && sameResponse(latest.response, next.response)) {
      return latest
    }
    fail('STALE_INTERACTION_VERSION', latest?.version)
  }
  async #get(id: string) {
    const request = await this.repository.get(id)
    if (!request) fail('INTERACTION_MISSING')
    return request
  }
}
function sameResponse(
  left: z.output<typeof ResponseSchema>,
  right: Pick<
    z.output<typeof ResponseSchema>,
    'responseId' | 'action' | 'respondingPrincipalId' | 'value'
  >
) {
  return (
    left.responseId === right.responseId &&
    left.action === right.action &&
    left.respondingPrincipalId === right.respondingPrincipalId &&
    JSON.stringify(left.value) === JSON.stringify(right.value)
  )
}
function fail(code: InteractionErrorCode, version?: number): never {
  throw new InteractionError(code, version)
}
function clone<T>(value: T): T {
  return structuredClone(value)
}
function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : clone(value)
}
