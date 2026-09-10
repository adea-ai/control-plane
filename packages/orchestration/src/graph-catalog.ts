import { createHash } from 'node:crypto'
import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const TimestampSchema = z.iso.datetime()
const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
const ReferenceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const CapabilitySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9.-]*$/)
const unique = <Value>(values: Value[]) => new Set(values).size === values.length

const GraphReferenceSchema = z
  .object({
    graphDefinitionId: ReferenceSchema,
    graphVersion: SemverSchema,
    contentDigest: DigestSchema,
  })
  .strict()

const NodeNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._-]*$/)

export const GraphDefinitionContentSchema = z
  .object({
    graphDefinitionId: ReferenceSchema,
    graphVersion: SemverSchema,
    schemaVersion: z.literal(1),
    nodes: z
      .array(
        z
          .object({
            node: NodeNameSchema,
            operation: z
              .object({
                kind: z.enum(['runtime', 'model', 'tool', 'delegation']),
                name: ReferenceSchema,
              })
              .strict(),
          })
          .strict()
      )
      .min(1)
      .max(256)
      .refine((nodes) => unique(nodes.map(({ node }) => node)), 'Graph node names must be unique'),
    edges: z
      .array(
        z
          .object({
            from: z.union([NodeNameSchema, z.literal('__start__')]),
            to: z.union([NodeNameSchema, z.literal('__end__')]),
          })
          .strict()
      )
      .min(1)
      .max(1_024),
    schemas: z
      .object({ input: ReferenceSchema, state: ReferenceSchema, output: ReferenceSchema })
      .strict(),
    requiredCapabilities: z.array(CapabilitySchema).max(128).refine(unique),
    compatibility: z
      .object({
        contractMajorVersions: z.array(z.number().int().positive()).min(1).refine(unique),
        compilerVersions: z.array(SemverSchema).min(1).refine(unique),
        adapterVersions: z.array(SemverSchema).min(1).refine(unique),
      })
      .strict(),
  })
  .strict()
  .superRefine((definition, context) => {
    const nodes = new Set(definition.nodes.map(({ node }) => node))
    for (const edge of definition.edges) {
      if (edge.from !== '__start__' && !nodes.has(edge.from)) {
        context.addIssue({ code: 'custom', message: `Unknown edge source: ${edge.from}` })
      }
      if (edge.to !== '__end__' && !nodes.has(edge.to)) {
        context.addIssue({ code: 'custom', message: `Unknown edge target: ${edge.to}` })
      }
    }
    if (!definition.edges.some(({ from }) => from === '__start__')) {
      context.addIssue({ code: 'custom', message: 'Graph requires a start edge' })
    }
    if (!definition.edges.some(({ to }) => to === '__end__')) {
      context.addIssue({ code: 'custom', message: 'Graph requires an end edge' })
    }
  })

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

export class InMemoryGraphDefinitionRepository implements GraphDefinitionRepository {
  readonly #versions = new Map<string, PublishedGraphDefinition>()

  async insert(version: PublishedGraphDefinition): Promise<boolean> {
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
    const key = versionKey(version.reference)
    const current = this.#versions.get(key)
    if (current?.revision !== expectedRevision || !sameContent(current, version)) return false
    this.#versions.set(key, structuredClone(version))
    return true
  }
}

export type GraphCatalogErrorCode =
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

function sameContent(left: PublishedGraphDefinition, right: PublishedGraphDefinition): boolean {
  return (
    left.reference.graphDefinitionId === right.reference.graphDefinitionId &&
    left.reference.graphVersion === right.reference.graphVersion &&
    left.reference.contentDigest === right.reference.contentDigest &&
    JSON.stringify(left.content) === JSON.stringify(right.content)
  )
}

function contentDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
