import { createHash } from 'node:crypto'
import {
  IdentifierSchemas,
  GraphReferenceSchema,
  GraphDefinitionContentSchema,
  GraphSelectionSchema,
  ServiceCallerAssertionSchema,
  type GraphInput,
  type GraphReference,
  type GraphSelection,
} from '@control-plane/contracts'
import type { ExecutionGraphAuthority } from '@control-plane/execution-plan'
export { GraphDefinitionContentSchema } from '@control-plane/contracts'
import { z } from 'zod'
import { canonicalJsonStringify } from '@control-plane/contracts'

const TimestampSchema = z.iso.datetime()
const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
const ReferenceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)

export const PublishedGraphDefinitionSchema = z
  .object({
    reference: GraphReferenceSchema,
    revision: z.number().int().positive(),
    lifecycle: z.enum(['published', 'deprecated', 'revoked']),
    content: GraphDefinitionContentSchema,
    publishedAt: TimestampSchema,
    changedAt: TimestampSchema,
    reason: z.string().min(1).max(1_024).optional(),
  })
  .strict()
  .superRefine((version, context) => {
    if (Date.parse(version.changedAt) < Date.parse(version.publishedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['changedAt'],
        message: 'Graph change timestamp must not precede publication',
      })
    }
    if (
      version.reference.graphDefinitionId !== version.content.graphDefinitionId ||
      version.reference.graphVersion !== version.content.graphVersion ||
      version.reference.contentDigest !== contentDigest(version.content)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Graph reference does not match immutable content',
      })
    }
    if (version.lifecycle !== 'published' && !version.reason) {
      context.addIssue({ code: 'custom', message: 'Graph lifecycle change requires a reason' })
    }
  })

export const GraphCheckpointRecordSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    executionId: IdentifierSchemas.executionId,
    workflowId: IdentifierSchemas.workflowId,
    threadId: ReferenceSchema,
    checkpointId: ReferenceSchema,
    parentCheckpointId: ReferenceSchema.optional(),
    graph: GraphReferenceSchema,
    compilerVersion: SemverSchema,
    adapterVersion: SemverSchema,
    state: z.enum(['active', 'completed', 'failed', 'cancelled']),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
  .refine((record) => Date.parse(record.expiresAt) > Date.parse(record.createdAt), {
    message: 'Checkpoint expiry must follow creation',
  })

export const GraphCheckpointRetentionPolicySchema = z
  .object({
    activeDays: z.number().int().positive().max(3_650),
    completedDays: z.number().int().positive().max(3_650),
    failedDays: z.number().int().positive().max(3_650),
  })
  .strict()

export type PublishedGraphDefinition = z.output<typeof PublishedGraphDefinitionSchema>
export type GraphCheckpointRecord = z.output<typeof GraphCheckpointRecordSchema>
export type GraphCheckpointRetentionPolicy = z.output<typeof GraphCheckpointRetentionPolicySchema>

export function checkpointExpiresAt(
  state: GraphCheckpointRecord['state'],
  createdAt: string,
  policyInput: unknown
): string {
  const policy = GraphCheckpointRetentionPolicySchema.parse(policyInput)
  const days =
    state === 'active'
      ? policy.activeDays
      : state === 'completed'
        ? policy.completedDays
        : policy.failedDays
  return new Date(Date.parse(TimestampSchema.parse(createdAt)) + days * 86_400_000).toISOString()
}

export interface GraphCompatibilityEnvironment {
  readonly capabilities: readonly string[]
  readonly contractMajorVersion: number
  readonly compilerVersion: string
  readonly adapterVersion: string
}

export interface GraphDefinitionRepository {
  insert(version: PublishedGraphDefinition): Promise<boolean>
  get(
    graphDefinitionId: string,
    graphVersion: string
  ): Promise<PublishedGraphDefinition | undefined>
  compareAndSet(expectedRevision: number, version: PublishedGraphDefinition): Promise<boolean>
}

export const GraphDefinitionCommandSchema = z
  .object({
    callerId: ServiceCallerAssertionSchema.shape.servicePrincipalId,
    operation: z.enum(['publish', 'deprecate', 'revoke']),
    idempotencyKey: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

export const GraphDefinitionCommandReceiptSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    command: GraphDefinitionCommandSchema,
    result: PublishedGraphDefinitionSchema,
  })
  .strict()

export type GraphDefinitionCommand = z.output<typeof GraphDefinitionCommandSchema>

/** The mutation and immutable response receipt must commit in one storage transaction. */
export interface GraphDefinitionCommandRepository extends GraphDefinitionRepository {
  executeCommand(
    command: GraphDefinitionCommand,
    action: (repository: GraphDefinitionRepository) => Promise<PublishedGraphDefinition>
  ): Promise<PublishedGraphDefinition>
}

/** New admission checks live catalog/compiler policy; exact replay checks the immutable pin. */
export class GraphDefinitionExecutionAuthority implements ExecutionGraphAuthority {
  constructor(
    readonly options: {
      readonly repository: (workspaceId: string) => GraphDefinitionRepository
      readonly environment: GraphCompatibilityEnvironment
      readonly validateDefinitionAndInput: (
        definition: PublishedGraphDefinition,
        input: GraphInput
      ) => boolean | Promise<boolean>
    }
  ) {}

  async validate(workspaceId: string, selection: GraphSelection): Promise<boolean> {
    const parsed = GraphSelectionSchema.parse(selection)
    const catalog = this.#catalog(workspaceId)
    try {
      const definition = PublishedGraphDefinitionSchema.parse(
        await catalog.resolveForNewExecution(parsed.reference, this.options.environment)
      )
      return await this.options.validateDefinitionAndInput(definition, parsed.input)
    } catch (error) {
      if (error instanceof GraphCatalogError) return false
      throw error
    }
  }

  async authorize(workspaceId: string, reference: GraphReference): Promise<boolean> {
    const catalog = this.#catalog(workspaceId)
    try {
      PublishedGraphDefinitionSchema.parse(await catalog.getPinned(reference))
      return true
    } catch (error) {
      if (error instanceof GraphCatalogError) return false
      throw error
    }
  }

  #catalog(workspaceId: string): GraphDefinitionCatalog {
    return new GraphDefinitionCatalog(
      this.options.repository(IdentifierSchemas.workspaceId.parse(workspaceId))
    )
  }
}

export class InMemoryGraphDefinitionRepository implements GraphDefinitionRepository {
  readonly #versions = new Map<string, PublishedGraphDefinition>()

  async insert(version: PublishedGraphDefinition): Promise<boolean> {
    version = PublishedGraphDefinitionSchema.parse(version)
    const key = versionKey(version.reference)
    if (this.#versions.has(key)) return false
    this.#versions.set(key, structuredClone(version))
    return true
  }

  async get(
    graphDefinitionId: string,
    graphVersion: string
  ): Promise<PublishedGraphDefinition | undefined> {
    const version = this.#versions.get(`${graphDefinitionId}:${graphVersion}`)
    return version ? structuredClone(version) : undefined
  }

  async compareAndSet(
    expectedRevision: number,
    version: PublishedGraphDefinition
  ): Promise<boolean> {
    const parsed = PublishedGraphDefinitionSchema.safeParse(version)
    if (!parsed.success) return false
    version = parsed.data
    const key = versionKey(version.reference)
    const current = this.#versions.get(key)
    if (current === undefined || !graphDefinitionUpdateIsValid(current, version, expectedRevision))
      return false
    this.#versions.set(key, structuredClone(version))
    return true
  }
}

export type GraphCatalogErrorCode =
  | 'GRAPH_COMMAND_CONFLICT'
  | 'GRAPH_VERSION_CONFLICT'
  | 'GRAPH_NOT_FOUND'
  | 'GRAPH_DIGEST_MISMATCH'
  | 'GRAPH_DEPRECATED'
  | 'GRAPH_REVOKED'
  | 'GRAPH_INCOMPATIBLE'
  | 'GRAPH_REVISION_CONFLICT'
  | 'GRAPH_INVALID_TRANSITION'

export class GraphCatalogError extends Error {
  constructor(readonly code: GraphCatalogErrorCode) {
    super(code)
    this.name = 'GraphCatalogError'
  }
}

export class GraphDefinitionCatalog {
  constructor(readonly repository: GraphDefinitionRepository) {}

  async publish(input: { readonly definition: unknown; readonly publishedAt: string }) {
    const content = GraphDefinitionContentSchema.parse(input.definition)
    const published = PublishedGraphDefinitionSchema.parse({
      reference: {
        graphDefinitionId: content.graphDefinitionId,
        graphVersion: content.graphVersion,
        contentDigest: contentDigest(content),
      },
      revision: 1,
      lifecycle: 'published',
      content,
      publishedAt: input.publishedAt,
      changedAt: input.publishedAt,
    })
    if (!(await this.repository.insert(published))) {
      throw new GraphCatalogError('GRAPH_VERSION_CONFLICT')
    }
    return published
  }

  async resolveForNewExecution(
    referenceInput: unknown,
    environment: GraphCompatibilityEnvironment
  ) {
    const version = await this.getPinned(referenceInput)
    if (version.lifecycle === 'deprecated') throw new GraphCatalogError('GRAPH_DEPRECATED')
    if (version.lifecycle === 'revoked') throw new GraphCatalogError('GRAPH_REVOKED')
    const compatibility = version.content.compatibility
    if (
      !compatibility.contractMajorVersions.includes(environment.contractMajorVersion) ||
      !compatibility.compilerVersions.includes(environment.compilerVersion) ||
      !compatibility.adapterVersions.includes(environment.adapterVersion) ||
      version.content.requiredCapabilities.some(
        (capability) => !environment.capabilities.includes(capability)
      )
    ) {
      throw new GraphCatalogError('GRAPH_INCOMPATIBLE')
    }
    return version
  }

  async getPinned(referenceInput: unknown): Promise<PublishedGraphDefinition> {
    const reference = GraphReferenceSchema.parse(referenceInput)
    const version = await this.repository.get(reference.graphDefinitionId, reference.graphVersion)
    if (!version) throw new GraphCatalogError('GRAPH_NOT_FOUND')
    if (version.reference.contentDigest !== reference.contentDigest) {
      throw new GraphCatalogError('GRAPH_DIGEST_MISMATCH')
    }
    return version
  }

  deprecate(input: LifecycleChangeInput): Promise<PublishedGraphDefinition> {
    return this.#transition(input, 'published', 'deprecated')
  }

  revoke(input: LifecycleChangeInput): Promise<PublishedGraphDefinition> {
    return this.#transition(input, ['published', 'deprecated'], 'revoked')
  }

  async #transition(
    input: LifecycleChangeInput,
    from: PublishedGraphDefinition['lifecycle'] | readonly PublishedGraphDefinition['lifecycle'][],
    lifecycle: PublishedGraphDefinition['lifecycle']
  ): Promise<PublishedGraphDefinition> {
    const current = await this.getPinned(input.reference)
    const allowed = Array.isArray(from) ? from : [from]
    if (!allowed.includes(current.lifecycle))
      throw new GraphCatalogError('GRAPH_INVALID_TRANSITION')
    const next = PublishedGraphDefinitionSchema.parse({
      ...current,
      revision: current.revision + 1,
      lifecycle,
      changedAt: input.changedAt,
      reason: input.reason,
    })
    if (!(await this.repository.compareAndSet(input.expectedRevision, next))) {
      throw new GraphCatalogError('GRAPH_REVISION_CONFLICT')
    }
    return next
  }
}

interface LifecycleChangeInput {
  readonly reference: unknown
  readonly expectedRevision: number
  readonly changedAt: string
  readonly reason: string
}

function versionKey(reference: { graphDefinitionId: string; graphVersion: string }): string {
  return `${reference.graphDefinitionId}:${reference.graphVersion}`
}

/** Shared persistence fence: lifecycle updates cannot rewrite a published graph or revive it. */
export function graphDefinitionUpdateIsValid(
  currentInput: PublishedGraphDefinition,
  nextInput: PublishedGraphDefinition,
  expectedRevision: number
): boolean {
  const currentResult = PublishedGraphDefinitionSchema.safeParse(currentInput)
  const nextResult = PublishedGraphDefinitionSchema.safeParse(nextInput)
  if (!currentResult.success || !nextResult.success || !Number.isSafeInteger(expectedRevision))
    return false
  const current = currentResult.data
  const next = nextResult.data
  return (
    expectedRevision > 0 &&
    current.revision === expectedRevision &&
    next.revision === expectedRevision + 1 &&
    sameContent(current, next) &&
    current.publishedAt === next.publishedAt &&
    Date.parse(next.changedAt) >= Date.parse(current.changedAt) &&
    Date.parse(current.changedAt) >= Date.parse(current.publishedAt) &&
    ((current.lifecycle === 'published' &&
      (next.lifecycle === 'deprecated' || next.lifecycle === 'revoked')) ||
      (current.lifecycle === 'deprecated' && next.lifecycle === 'revoked'))
  )
}

function sameContent(left: PublishedGraphDefinition, right: PublishedGraphDefinition): boolean {
  return (
    left.reference.graphDefinitionId === right.reference.graphDefinitionId &&
    left.reference.graphVersion === right.reference.graphVersion &&
    left.reference.contentDigest === right.reference.contentDigest &&
    canonicalJsonStringify(left.content) === canonicalJsonStringify(right.content)
  )
}

function contentDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`
}

// Uses the locale-independent canonical serializer from contracts: the
// GraphDefinitionContent key set contains schemaVersion/schemas, which
// localeCompare orders differently per host — the digest was host-dependent
// before this fix (#612 P0).
