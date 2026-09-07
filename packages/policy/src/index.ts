import { createHash } from 'node:crypto'
import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'

const TimestampSchema = z.iso.datetime()
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const CanonicalReferenceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const JsonObjectSchema = z.record(z.string(), z.json())

export const PolicySnapshotReferenceSchema = z
  .object({
    policyId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9.-]*$/),
    version: z.number().int().positive(),
    digest: DigestSchema,
  })
  .strict()

export const PolicyActionSchema = z.enum([
  'runtime:execute',
  'tool:invoke',
  'context:read',
  'context:promote',
  'model:invoke',
  'sandbox:create',
  'sandbox:network',
  'policy:update',
  'credential:lease',
])

export const PolicyResourceTypeSchema = z.enum([
  'runtime',
  'tool',
  'context',
  'model',
  'sandbox',
  'policy',
  'credential',
])

export const PolicyAuthorizationRequestSchema = z
  .object({
    requestId: IdentifierSchemas.requestId,
    principal: z
      .object({
        type: z.enum(['user', 'service', 'agent', 'runtime']),
        id: CanonicalReferenceSchema,
        workspaceId: IdentifierSchemas.workspaceId,
        attributes: JsonObjectSchema.optional(),
      })
      .strict(),
    action: PolicyActionSchema,
    resource: z
      .object({
        type: PolicyResourceTypeSchema,
        id: CanonicalReferenceSchema,
        workspaceId: IdentifierSchemas.workspaceId,
        attributes: JsonObjectSchema,
      })
      .strict(),
    context: z
      .object({
        workspaceId: IdentifierSchemas.workspaceId,
        requestedAt: TimestampSchema,
        attributes: JsonObjectSchema.optional(),
      })
      .strict(),
    policySnapshot: PolicySnapshotReferenceSchema,
  })
  .strict()

export const PolicyDecisionSchema = z
  .object({
    effect: z.enum(['allow', 'deny']),
    decisionId: DigestSchema,
    reasonCode: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Z][A-Z0-9_]*$/),
    policySnapshot: PolicySnapshotReferenceSchema,
    evaluatedAt: TimestampSchema,
  })
  .strict()

export type PolicySnapshotReference = z.output<typeof PolicySnapshotReferenceSchema>
export type PolicyAuthorizationRequest = z.output<typeof PolicyAuthorizationRequestSchema>
export type PolicyDecision = z.output<typeof PolicyDecisionSchema>

/** Provider-neutral domain port. Cedar can be replaced without changing callers. */
export interface PolicyDecisionPoint {
  authorize(request: PolicyAuthorizationRequest): Promise<PolicyDecision>
}

export const PolicyDocumentSchema = PolicySnapshotReferenceSchema.extend({
  cedar: z.string().min(1).max(1_048_576),
  createdAt: TimestampSchema,
  status: z.enum(['published', 'active', 'revoked']).default('published'),
}).strict()

export type PolicyDocument = z.output<typeof PolicyDocumentSchema>

export interface CedarAuthorizationRequest {
  readonly policyText: string
  readonly principal: {
    readonly entityType: string
    readonly entityId: string
    readonly attributes: Record<string, z.util.JSONType>
  }
  readonly action: { readonly entityType: 'Action'; readonly entityId: string }
  readonly resource: {
    readonly entityType: string
    readonly entityId: string
    readonly attributes: Record<string, z.util.JSONType>
  }
  readonly context: Record<string, z.util.JSONType>
}

export interface CedarEvaluatorPort {
  evaluate(request: CedarAuthorizationRequest): Promise<{
    readonly decision: 'allow' | 'deny'
    readonly determiningPolicies: readonly {
      readonly effect: 'permit' | 'forbid'
      readonly policyId?: string
    }[]
  }>
  validate(policyText: string): Promise<{ readonly valid: boolean; readonly reasonCode?: string }>
}

export class InMemoryPolicyStore {
  readonly #documents = new Map<string, PolicyDocument>()
  readonly #active = new Map<string, number>()

  async publish(input: unknown): Promise<PolicyDocument> {
    const document = PolicyDocumentSchema.parse(input)
    if (document.digest !== digest(document.cedar)) throw new Error('POLICY_DIGEST_MISMATCH')
    const key = policyKey(document.policyId, document.version)
    if (this.#documents.has(key)) throw new Error('POLICY_VERSION_EXISTS')
    const published = PolicyDocumentSchema.parse({ ...document, status: 'published' })
    this.#documents.set(key, published)
    return clone(published)
  }

  async resolve(reference: PolicySnapshotReference): Promise<PolicyDocument | undefined> {
    const parsed = PolicySnapshotReferenceSchema.parse(reference)
    const document = this.#documents.get(policyKey(parsed.policyId, parsed.version))
    if (!document || document.digest !== parsed.digest) return undefined
    return clone(document)
  }

  async active(policyId: string): Promise<PolicyDocument | undefined> {
    const version = this.#active.get(policyId)
    if (version === undefined) return undefined
    return cloneOptional(this.#documents.get(policyKey(policyId, version)))
  }

  async activate(policyId: string, version: number): Promise<PolicyDocument> {
    const key = policyKey(policyId, version)
    const document = this.#documents.get(key)
    if (!document || document.status === 'revoked') throw new Error('POLICY_NOT_ACTIVATABLE')
    const previous = await this.active(policyId)
    if (previous && previous.version !== version && previous.status === 'active') {
      this.#documents.set(policyKey(policyId, previous.version), {
        ...previous,
        status: 'published',
      })
    }
    const active = PolicyDocumentSchema.parse({ ...document, status: 'active' })
    this.#documents.set(key, active)
    this.#active.set(policyId, version)
    return clone(active)
  }

  async rollback(policyId: string, version: number): Promise<PolicyDocument> {
    return this.activate(policyId, version)
  }

  async revoke(policyId: string, version: number): Promise<PolicyDocument> {
    const key = policyKey(policyId, version)
    const document = this.#documents.get(key)
    if (!document) throw new Error('POLICY_MISSING')
    const revoked = PolicyDocumentSchema.parse({ ...document, status: 'revoked' })
    this.#documents.set(key, revoked)
    if (this.#active.get(policyId) === version) this.#active.delete(policyId)
    return clone(revoked)
  }

  async test(reference: PolicySnapshotReference, evaluator: CedarEvaluatorPort) {
    const document = await this.resolve(reference)
    if (!document || document.status === 'revoked') {
      return { valid: false, reasonCode: 'POLICY_UNAVAILABLE' }
    }
    try {
      return await evaluator.validate(document.cedar)
    } catch {
      return { valid: false, reasonCode: 'POLICY_EVALUATOR_FAILED' }
    }
  }
}

export class CedarPolicyDecisionPoint implements PolicyDecisionPoint {
  readonly #store: InMemoryPolicyStore
  readonly #evaluator: CedarEvaluatorPort
  readonly #now: () => string

  constructor(options: {
    readonly store: InMemoryPolicyStore
    readonly evaluator: CedarEvaluatorPort
    readonly now?: () => string
  }) {
    this.#store = options.store
    this.#evaluator = options.evaluator
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async authorize(input: PolicyAuthorizationRequest): Promise<PolicyDecision> {
    const request = PolicyAuthorizationRequestSchema.parse(input)
    if (resourceForAction(request.action) !== request.resource.type) {
      return this.#deny(request, 'ACTION_RESOURCE_MISMATCH')
    }
    if (
      request.principal.workspaceId !== request.context.workspaceId ||
      request.resource.workspaceId !== request.context.workspaceId
    ) {
      return this.#deny(request, 'WORKSPACE_SCOPE_MISMATCH')
    }
    const document = await this.#store.resolve(request.policySnapshot)
    if (!document) return this.#deny(request, 'POLICY_MISSING')
    if (document.status === 'revoked') return this.#deny(request, 'POLICY_REVOKED')
    try {
      const result = await this.#evaluator.evaluate(toCedarRequest(request, document.cedar))
      const forbidden = result.determiningPolicies.some(({ effect }) => effect === 'forbid')
      const permitted = result.determiningPolicies.some(({ effect }) => effect === 'permit')
      return forbidden || result.decision === 'deny' || !permitted
        ? this.#deny(request, forbidden ? 'CEDAR_FORBID' : 'CEDAR_DENY')
        : decision(request, 'allow', 'CEDAR_PERMIT', this.#now())
    } catch {
      return this.#deny(request, 'POLICY_EVALUATOR_FAILED')
    }
  }

  #deny(request: PolicyAuthorizationRequest, reasonCode: string): PolicyDecision {
    return decision(request, 'deny', reasonCode, this.#now())
  }
}

export interface FakeCedarRule {
  readonly effect: 'permit' | 'forbid'
  readonly principalType?: string
  readonly action?: string
  readonly resourceType?: string
}

export class FakeCedarEvaluator implements CedarEvaluatorPort {
  readonly requests: CedarAuthorizationRequest[] = []
  fail = false

  constructor(readonly rules: readonly FakeCedarRule[]) {}

  async evaluate(request: CedarAuthorizationRequest) {
    if (this.fail) throw new Error('FAKE_CEDAR_UNAVAILABLE')
    this.requests.push(clone(request))
    const determiningPolicies = this.rules
      .filter(
        (rule) =>
          (rule.principalType === undefined ||
            title(rule.principalType) === request.principal.entityType) &&
          (rule.action === undefined || rule.action === request.action.entityId) &&
          (rule.resourceType === undefined ||
            title(rule.resourceType) === request.resource.entityType)
      )
      .map((rule, index) => ({ effect: rule.effect, policyId: `fake-${index + 1}` }))
    return {
      decision: determiningPolicies.some(({ effect }) => effect === 'forbid')
        ? ('deny' as const)
        : determiningPolicies.some(({ effect }) => effect === 'permit')
          ? ('allow' as const)
          : ('deny' as const),
      determiningPolicies,
    }
  }

  async validate(policyText: string) {
    if (this.fail) throw new Error('FAKE_CEDAR_UNAVAILABLE')
    return /\b(?:permit|forbid)\s*\(/.test(policyText)
      ? { valid: true as const }
      : { valid: false as const, reasonCode: 'CEDAR_INVALID_POLICY' }
  }
}

function toCedarRequest(
  request: PolicyAuthorizationRequest,
  policyText: string
): CedarAuthorizationRequest {
  return {
    policyText,
    principal: {
      entityType: title(request.principal.type),
      entityId: request.principal.id,
      attributes: {
        workspaceId: request.principal.workspaceId,
        ...request.principal.attributes,
      },
    },
    action: { entityType: 'Action', entityId: request.action },
    resource: {
      entityType: title(request.resource.type),
      entityId: request.resource.id,
      attributes: {
        workspaceId: request.resource.workspaceId,
        ...request.resource.attributes,
      },
    },
    context: {
      workspaceId: request.context.workspaceId,
      requestedAt: request.context.requestedAt,
      ...request.context.attributes,
    },
  }
}

function decision(
  request: PolicyAuthorizationRequest,
  effect: 'allow' | 'deny',
  reasonCode: string,
  evaluatedAt: string
): PolicyDecision {
  return PolicyDecisionSchema.parse({
    effect,
    decisionId: digest({ request, effect, reasonCode, evaluatedAt }),
    reasonCode,
    policySnapshot: request.policySnapshot,
    evaluatedAt,
  })
}

function policyKey(policyId: string, version: number): string {
  return `${policyId}:${version}`
}

function resourceForAction(
  action: PolicyAuthorizationRequest['action']
): PolicyAuthorizationRequest['resource']['type'] {
  if (action.startsWith('runtime:')) return 'runtime'
  if (action.startsWith('tool:')) return 'tool'
  if (action.startsWith('context:')) return 'context'
  if (action.startsWith('model:')) return 'model'
  if (action.startsWith('sandbox:')) return 'sandbox'
  if (action.startsWith('policy:')) return 'policy'
  return 'credential'
}

function title(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function digest(value: unknown): `sha256:${string}` {
  const serialized = typeof value === 'string' ? value : canonical(value)
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

function cloneOptional<Value>(value: Value | undefined): Value | undefined {
  return value === undefined ? undefined : clone(value)
}

export const packageName = 'policy'
