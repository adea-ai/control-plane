import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'

export const RetentionHoldIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
export const RetentionHoldClassIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const OwnerSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
export const RetentionHoldReasonCodeSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/)
const PrincipalRefSchema = z.string().min(1).max(256)
const AuthorityRefSchema = z.string().min(1).max(256)
export const RetentionHoldCanonicalUtcInstantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const time = Date.parse(value)
    return Number.isFinite(time) && new Date(time).toISOString() === value
  })

export const RetentionHoldScopeKindSchema = z.enum(['class', 'workspace', 'project'])
export type RetentionHoldScopeKind = z.output<typeof RetentionHoldScopeKindSchema>

/** A hold's scope uses only canonical workspace/project identifiers. */
export const RetentionHoldScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('class') }).strict(),
  z.object({ kind: z.literal('workspace'), workspaceId: IdentifierSchemas.workspaceId }).strict(),
  z
    .object({
      kind: z.literal('project'),
      workspaceId: IdentifierSchemas.workspaceId,
      projectId: IdentifierSchemas.projectId,
    })
    .strict(),
])
export type RetentionHoldScope = z.output<typeof RetentionHoldScopeSchema>

export const RetentionHoldSessionSchema = z
  .object({ actorPrincipalRef: PrincipalRefSchema, authorityRef: AuthorityRefSchema })
  .strict()
export type RetentionHoldSession = z.output<typeof RetentionHoldSessionSchema>

export const RetentionHoldProvenanceSchema = z
  .object({ actorPrincipalRef: PrincipalRefSchema, authorityRef: AuthorityRefSchema })
  .strict()
export type RetentionHoldProvenance = z.output<typeof RetentionHoldProvenanceSchema>

export const RetentionHoldReleaseSchema = z
  .object({
    requestId: RetentionHoldIdSchema,
    releasedAt: RetentionHoldCanonicalUtcInstantSchema,
    releasedBy: RetentionHoldProvenanceSchema,
  })
  .strict()
export type RetentionHoldRelease = z.output<typeof RetentionHoldReleaseSchema>

export const RetentionHoldSchema = z
  .object({
    holdId: RetentionHoldIdSchema,
    classId: RetentionHoldClassIdSchema,
    scope: RetentionHoldScopeSchema,
    owner: OwnerSchema,
    reasonCode: RetentionHoldReasonCodeSchema,
    createdAt: RetentionHoldCanonicalUtcInstantSchema,
    createdBy: RetentionHoldProvenanceSchema,
    revision: z.number().int().min(0).max(1),
    release: RetentionHoldReleaseSchema.optional(),
  })
  .strict()
  .superRefine((hold, context) => {
    if ((hold.release === undefined) !== (hold.revision === 0)) {
      context.addIssue({
        code: 'custom',
        path: ['revision'],
        message: 'Active holds have revision zero and released holds have revision one',
      })
    }
  })
export type RetentionHold = z.output<typeof RetentionHoldSchema>

export const RetentionHoldClassPolicySchema = z
  .object({
    owner: OwnerSchema,
    scopes: z.array(RetentionHoldScopeKindSchema).min(1),
    reasonCodes: z.array(RetentionHoldReasonCodeSchema).min(1),
  })
  .strict()
  .superRefine((policy, context) => {
    if (new Set(policy.scopes).size !== policy.scopes.length) {
      context.addIssue({ code: 'custom', path: ['scopes'], message: 'Scopes must be unique' })
    }
    if (new Set(policy.reasonCodes).size !== policy.reasonCodes.length) {
      context.addIssue({
        code: 'custom',
        path: ['reasonCodes'],
        message: 'Reason codes must be unique',
      })
    }
  })
export type RetentionHoldClassPolicy = z.output<typeof RetentionHoldClassPolicySchema>

/** The host supplies policy explicitly; this module has no implicit classes or owners. */
export const RetentionHoldPolicySchema = z
  .record(RetentionHoldClassIdSchema, RetentionHoldClassPolicySchema)
  .refine((policy) => Object.keys(policy).length > 0)
export type RetentionHoldPolicy = z.output<typeof RetentionHoldPolicySchema>

export const RetentionHoldCreateRequestSchema = z
  .object({
    operation: z.literal('create'),
    holdId: RetentionHoldIdSchema,
    classId: RetentionHoldClassIdSchema,
    scope: RetentionHoldScopeSchema,
    reasonCode: RetentionHoldReasonCodeSchema,
    /** A claim only: the service compares it with its host-verified session. */
    actorPrincipalRef: PrincipalRefSchema,
    authorityRef: AuthorityRefSchema,
  })
  .strict()

export const RetentionHoldReleaseRequestSchema = z
  .object({
    operation: z.literal('release'),
    holdId: RetentionHoldIdSchema,
    requestId: RetentionHoldIdSchema,
    expectedRevision: z.number().int().nonnegative(),
    /** A claim only: the service compares it with its host-verified session. */
    actorPrincipalRef: PrincipalRefSchema,
    authorityRef: AuthorityRefSchema,
  })
  .strict()

export const RetentionHoldAdministrationRequestSchema = z.discriminatedUnion('operation', [
  RetentionHoldCreateRequestSchema,
  RetentionHoldReleaseRequestSchema,
])

export type RetentionHoldAdministrationRequest = z.output<
  typeof RetentionHoldAdministrationRequestSchema
>

export interface RetentionHoldTarget {
  readonly classId: string
  /** Omitted/class means tenant scope is unavailable, not a wildcard for scoped holds. */
  readonly scope?: RetentionHoldScope | undefined
}

export interface RetentionHoldRepository {
  get(holdId: string): Promise<RetentionHold | undefined>
  create(hold: RetentionHold): Promise<{ readonly created: boolean; readonly hold: RetentionHold }>
  release(input: {
    readonly holdId: string
    readonly expectedRevision: number
    readonly release: RetentionHoldRelease
  }): Promise<{ readonly released: boolean; readonly hold: RetentionHold }>
}

export type RetentionHoldErrorCode =
  | 'RETENTION_HOLD_INPUT_INVALID'
  | 'RETENTION_HOLD_POLICY_INVALID'
  | 'RETENTION_HOLD_CLASS_UNCONFIGURED'
  | 'RETENTION_HOLD_SCOPE_UNSUPPORTED'
  | 'RETENTION_HOLD_REASON_UNSUPPORTED'
  | 'RETENTION_HOLD_SESSION_REQUIRED'
  | 'RETENTION_HOLD_ACTOR_MISMATCH'
  | 'RETENTION_HOLD_OWNER_DENIED'
  | 'RETENTION_HOLD_NOT_FOUND'
  | 'RETENTION_HOLD_ID_CONFLICT'
  | 'RETENTION_HOLD_REVISION_CONFLICT'
  | 'RETENTION_HOLD_ALREADY_RELEASED'
  | 'RETENTION_HOLD_STORED_RECORD_INVALID'
  | 'RETENTION_HOLD_TARGET_SCOPE_MISSING'
  | 'RETENTION_HOLD_STORAGE_INCONSISTENT'

export class RetentionHoldError extends Error {
  constructor(readonly code: RetentionHoldErrorCode) {
    super(code)
    this.name = 'RetentionHoldError'
  }
}

export type RetentionHoldOwnerAuthorization = (input: {
  readonly action: 'create' | 'release'
  readonly session: RetentionHoldSession
  readonly owner: string
  readonly classId: string
  readonly scope: RetentionHoldScope
}) => boolean | Promise<boolean>

export class RetentionHoldAdministration {
  readonly #repository: RetentionHoldRepository
  readonly #policy: RetentionHoldPolicy
  readonly #verifiedSession: () =>
    | RetentionHoldSession
    | undefined
    | Promise<RetentionHoldSession | undefined>
  readonly #authorizeOwner: RetentionHoldOwnerAuthorization
  readonly #now: () => Date

  constructor(options: {
    readonly repository: RetentionHoldRepository
    readonly policy: RetentionHoldPolicy
    /** Reads verified host identity; request bodies are never identity sources. */
    readonly verifiedSession: () =>
      | RetentionHoldSession
      | undefined
      | Promise<RetentionHoldSession | undefined>
    /** Mandatory owner check. Returning anything other than true denies. */
    readonly authorizeOwner: RetentionHoldOwnerAuthorization
    readonly now?: () => Date
  }) {
    if (
      options === undefined ||
      options.repository === undefined ||
      typeof options.verifiedSession !== 'function' ||
      typeof options.authorizeOwner !== 'function'
    ) {
      throw new RetentionHoldError('RETENTION_HOLD_SESSION_REQUIRED')
    }
    this.#repository = options.repository
    this.#policy = parseRetentionHoldPolicy(options.policy)
    this.#verifiedSession = options.verifiedSession
    this.#authorizeOwner = options.authorizeOwner
    this.#now = options.now ?? (() => new Date())
  }

  async apply(input: unknown): Promise<{
    readonly status: 'applied' | 'replayed'
    readonly operation: 'create' | 'release'
    readonly hold: RetentionHold
  }> {
    let request: RetentionHoldAdministrationRequest
    try {
      request = RetentionHoldAdministrationRequestSchema.parse(input)
    } catch {
      throw new RetentionHoldError('RETENTION_HOLD_INPUT_INVALID')
    }
    const session = await this.#getVerifiedSession()
    if (
      request.actorPrincipalRef !== session.actorPrincipalRef ||
      request.authorityRef !== session.authorityRef
    ) {
      throw new RetentionHoldError('RETENTION_HOLD_ACTOR_MISMATCH')
    }

    if (request.operation === 'create') {
      const classPolicy = this.#classPolicy(request.classId)
      this.#assertRequestedScope(classPolicy, request.scope, request.reasonCode)
      await this.#authorize({
        action: 'create',
        session,
        owner: classPolicy.owner,
        classId: request.classId,
        scope: request.scope,
      })
      const hold = RetentionHoldSchema.parse({
        holdId: request.holdId,
        classId: request.classId,
        scope: request.scope,
        owner: classPolicy.owner,
        reasonCode: request.reasonCode,
        createdAt: canonicalNow(this.#now),
        createdBy: session,
        revision: 0,
      })
      const result = await this.#repository.create(hold)
      return {
        status: result.created ? 'applied' : 'replayed',
        operation: 'create',
        hold: validateStoredHold(result.hold, this.#policy),
      }
    }

    const current = await this.#repository.get(request.holdId)
    if (current === undefined) throw new RetentionHoldError('RETENTION_HOLD_NOT_FOUND')
    const hold = validateStoredHold(current, this.#policy)
    const classPolicy = this.#classPolicy(hold.classId)
    await this.#authorize({
      action: 'release',
      session,
      owner: classPolicy.owner,
      classId: hold.classId,
      scope: hold.scope,
    })
    const result = await this.#repository.release({
      holdId: request.holdId,
      expectedRevision: request.expectedRevision,
      release: {
        requestId: request.requestId,
        releasedAt: canonicalNow(this.#now),
        releasedBy: session,
      },
    })
    return {
      status: result.released ? 'applied' : 'replayed',
      operation: 'release',
      hold: validateStoredHold(result.hold, this.#policy),
    }
  }

  async #getVerifiedSession(): Promise<RetentionHoldSession> {
    let session: unknown
    try {
      session = await this.#verifiedSession()
      return RetentionHoldSessionSchema.parse(session)
    } catch {
      throw new RetentionHoldError('RETENTION_HOLD_SESSION_REQUIRED')
    }
  }

  #classPolicy(classId: string): RetentionHoldClassPolicy {
    if (!Object.hasOwn(this.#policy, classId))
      throw new RetentionHoldError('RETENTION_HOLD_CLASS_UNCONFIGURED')
    const classPolicy = this.#policy[classId]
    if (classPolicy === undefined) throw new RetentionHoldError('RETENTION_HOLD_CLASS_UNCONFIGURED')
    return classPolicy
  }

  #assertRequestedScope(
    classPolicy: RetentionHoldClassPolicy,
    scope: RetentionHoldScope,
    reasonCode: string
  ): void {
    if (!classPolicy.scopes.includes(scope.kind))
      throw new RetentionHoldError('RETENTION_HOLD_SCOPE_UNSUPPORTED')
    if (!classPolicy.reasonCodes.includes(reasonCode))
      throw new RetentionHoldError('RETENTION_HOLD_REASON_UNSUPPORTED')
  }

  async #authorize(input: Parameters<RetentionHoldOwnerAuthorization>[0]): Promise<void> {
    if ((await this.#authorizeOwner(input)) !== true)
      throw new RetentionHoldError('RETENTION_HOLD_OWNER_DENIED')
  }
}

/** Stable advisory-lock input shared by hold writers and future deletion claims. */
export function retentionHoldClassLockKey(classIdInput: unknown): string {
  const classId = RetentionHoldClassIdSchema.safeParse(classIdInput)
  if (!classId.success) throw new RetentionHoldError('RETENTION_HOLD_INPUT_INVALID')
  return `retention-hold:${classId.data}`
}

export function parseRetentionHoldPolicy(input: unknown): RetentionHoldPolicy {
  const parsed = RetentionHoldPolicySchema.safeParse(input)
  if (!parsed.success) throw new RetentionHoldError('RETENTION_HOLD_POLICY_INVALID')
  return parsed.data
}

export function validateStoredHold(
  input: unknown,
  policyInput: RetentionHoldPolicy
): RetentionHold {
  const parsed = RetentionHoldSchema.safeParse(input)
  if (!parsed.success) throw new RetentionHoldError('RETENTION_HOLD_STORED_RECORD_INVALID')
  const hold = parsed.data
  const policy = Object.hasOwn(policyInput, hold.classId) ? policyInput[hold.classId] : undefined
  if (
    policy === undefined ||
    policy.owner !== hold.owner ||
    !policy.scopes.includes(hold.scope.kind) ||
    !policy.reasonCodes.includes(hold.reasonCode)
  ) {
    throw new RetentionHoldError('RETENTION_HOLD_STORED_RECORD_INVALID')
  }
  return hold
}

export function sameRetentionHoldIdentity(left: RetentionHold, right: RetentionHold): boolean {
  return (
    left.holdId === right.holdId &&
    left.classId === right.classId &&
    JSON.stringify(left.scope) === JSON.stringify(right.scope) &&
    left.owner === right.owner &&
    left.reasonCode === right.reasonCode &&
    JSON.stringify(left.createdBy) === JSON.stringify(right.createdBy)
  )
}

/**
 * Count active holds for one candidate. An incomplete target scope is an error
 * whenever a scoped hold could match; callers must never turn missing tenant
 * metadata into permission to delete.
 */
export function countMatchingActiveRetentionHolds(input: {
  readonly holds: readonly unknown[]
  readonly target: RetentionHoldTarget
  readonly policy: RetentionHoldPolicy
  readonly recordIds?: readonly (string | undefined)[]
}): number {
  const targetClass = RetentionHoldClassIdSchema.safeParse(input.target.classId)
  if (!targetClass.success) throw new RetentionHoldError('RETENTION_HOLD_CLASS_UNCONFIGURED')
  const parsedPolicy = parseRetentionHoldPolicy(input.policy)
  if (!Object.hasOwn(parsedPolicy, targetClass.data))
    throw new RetentionHoldError('RETENTION_HOLD_CLASS_UNCONFIGURED')
  const policy = parsedPolicy[targetClass.data]
  if (policy === undefined) throw new RetentionHoldError('RETENTION_HOLD_CLASS_UNCONFIGURED')
  let targetScope: RetentionHoldScope | undefined
  if (input.target.scope !== undefined) {
    const parsedScope = RetentionHoldScopeSchema.safeParse(input.target.scope)
    if (!parsedScope.success) throw new RetentionHoldError('RETENTION_HOLD_TARGET_SCOPE_MISSING')
    targetScope = parsedScope.data
  }
  let holds: RetentionHold[]
  try {
    holds = input.holds.map((value) => RetentionHoldSchema.parse(value))
  } catch {
    throw new RetentionHoldError('RETENTION_HOLD_STORED_RECORD_INVALID')
  }
  const ids = input.recordIds
  if (ids !== undefined && ids.length !== holds.length) {
    throw new RetentionHoldError('RETENTION_HOLD_STORAGE_INCONSISTENT')
  }
  for (let index = 0; index < holds.length; index += 1) {
    const hold = holds[index]
    if (hold === undefined) throw new RetentionHoldError('RETENTION_HOLD_STORAGE_INCONSISTENT')
    if (ids !== undefined && ids[index] !== hold.holdId) {
      throw new RetentionHoldError('RETENTION_HOLD_STORAGE_INCONSISTENT')
    }
    validateStoredHold(hold, parsedPolicy)
  }
  const active = holds.filter(
    (hold) => hold.classId === targetClass.data && hold.release === undefined
  )
  if (targetScope === undefined || targetScope.kind === 'class') {
    if (active.some((hold) => hold.scope.kind !== 'class')) {
      throw new RetentionHoldError('RETENTION_HOLD_TARGET_SCOPE_MISSING')
    }
    return active.length
  }

  const targetWorkspaceId = targetScope.workspaceId
  const targetProjectId = targetScope.kind === 'project' ? targetScope.projectId : undefined
  if (targetScope.kind === 'workspace') {
    if (
      active.some(
        (hold) => hold.scope.kind === 'project' && hold.scope.workspaceId === targetWorkspaceId
      )
    ) {
      throw new RetentionHoldError('RETENTION_HOLD_TARGET_SCOPE_MISSING')
    }
  }
  return active.filter((hold) => {
    if (hold.scope.kind === 'class') return true
    if (hold.scope.workspaceId !== targetWorkspaceId) return false
    return hold.scope.kind === 'workspace' || hold.scope.projectId === targetProjectId
  }).length
}

function canonicalNow(now: () => Date): string {
  const instant = now()
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
    throw new RetentionHoldError('RETENTION_HOLD_INPUT_INVALID')
  }
  return instant.toISOString()
}
