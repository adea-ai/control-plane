import { z } from 'zod'
import { IdentifierSchemas } from './identifiers.js'

const ReferenceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
const CapabilitySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9.-]*$/)
const unique = <Value>(values: Value[]) => new Set(values).size === values.length

export const GraphReferenceSchema = z
  .object({
    graphDefinitionId: ReferenceSchema,
    graphVersion: SemverSchema,
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict()
export type GraphReference = z.output<typeof GraphReferenceSchema>

const NodeNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._-]*$/)
const CanonicalToolOperationNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9.-]*$/)

export const GraphToolPinSchema = z
  .object({
    toolDefinitionId: IdentifierSchemas.toolDefinitionId,
    toolVersionId: IdentifierSchemas.toolVersionId,
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    operation: CanonicalToolOperationNameSchema,
  })
  .strict()
export type GraphToolPin = z.output<typeof GraphToolPinSchema>

export const GRAPH_TOOL_PINS_CAPABILITY = 'graph.tool-pins.v1' as const

const GraphNodeOperationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.enum(['runtime', 'model', 'delegation']),
      name: ReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('tool'),
      name: ReferenceSchema,
      toolPin: GraphToolPinSchema.optional(),
    })
    .strict(),
])

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
            join: z.enum(['all', 'any']).optional(),
            operation: GraphNodeOperationSchema,
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
            when: z
              .object({
                path: z
                  .array(
                    z
                      .string()
                      .min(1)
                      .max(256)
                      .refine((key) => !['__proto__', 'prototype', 'constructor'].includes(key))
                  )
                  .min(1)
                  .max(16),
                equals: z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]),
              })
              .strict()
              .optional(),
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
    const hasToolPin = definition.nodes.some(
      ({ operation }) => operation.kind === 'tool' && operation.toolPin !== undefined
    )
    if (hasToolPin && !definition.requiredCapabilities.includes(GRAPH_TOOL_PINS_CAPABILITY)) {
      context.addIssue({
        code: 'custom',
        path: ['requiredCapabilities'],
        message: `Pinned tool operations require ${GRAPH_TOOL_PINS_CAPABILITY}`,
      })
    }
    for (const edge of definition.edges) {
      if (edge.from === '__start__' && edge.when !== undefined) {
        context.addIssue({ code: 'custom', message: 'Start edges cannot depend on node results' })
      }
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

/** Public catalog snapshot; the server additionally verifies the content digest. */
export const GraphDefinitionVersionSchema = z
  .object({
    reference: GraphReferenceSchema,
    revision: z.number().int().positive(),
    lifecycle: z.enum(['published', 'deprecated', 'revoked']),
    content: GraphDefinitionContentSchema,
    publishedAt: z.iso.datetime(),
    changedAt: z.iso.datetime(),
    reason: z.string().min(1).max(1024).optional(),
  })
  .strict()
  .superRefine((version, context) => {
    if (
      version.reference.graphDefinitionId !== version.content.graphDefinitionId ||
      version.reference.graphVersion !== version.content.graphVersion ||
      Date.parse(version.changedAt) < Date.parse(version.publishedAt) ||
      (version.lifecycle !== 'published' && !version.reason)
    ) {
      context.addIssue({ code: 'custom', message: 'Graph version metadata is inconsistent' })
    }
  })
export type GraphDefinitionVersion = z.output<typeof GraphDefinitionVersionSchema>

export type GraphJsonValue =
  | null
  | boolean
  | number
  | string
  | GraphJsonValue[]
  | { [key: string]: GraphJsonValue }
export type GraphInput = { [key: string]: GraphJsonValue }

// Check bounds and plain data before recursive parsing, cloning or digesting.
// Every graph input is persisted in the plan and may later enter checkpoints.
function isBoundedGraphInput(value: unknown): value is GraphInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }]
  const seen = new Set<object>()
  let count = 0
  let bytes = 0
  while (pending.length > 0) {
    const item = pending.pop()!
    if (++count > 4_096 || item.depth > 16) return false
    const entry = item.value
    if (typeof entry === 'string') {
      bytes += new TextEncoder().encode(entry).length
    } else if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) return false
      bytes += 24
    } else if (entry === null || typeof entry === 'boolean') {
      bytes += 5
    } else if (typeof entry === 'object') {
      if (seen.has(entry)) return false
      seen.add(entry)
      const prototype = Object.getPrototypeOf(entry) as object | null
      if (!Array.isArray(entry) && prototype !== Object.prototype && prototype !== null)
        return false
      if (
        Array.isArray(entry) &&
        (entry.length > 4_096 || Object.keys(entry).length !== entry.length)
      )
        return false
      if (Reflect.ownKeys(entry).length > 4_096) return false
      for (const key of Reflect.ownKeys(entry)) {
        if (Array.isArray(entry) && key === 'length') continue
        if (
          Array.isArray(entry) &&
          (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= entry.length)
        )
          return false
        if (
          typeof key !== 'string' ||
          key.length > 256 ||
          ['__proto__', 'constructor', 'prototype'].includes(key)
        )
          return false
        const descriptor = Object.getOwnPropertyDescriptor(entry, key)
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false
        bytes += new TextEncoder().encode(key).length + 4
        pending.push({ value: descriptor.value, depth: item.depth + 1 })
      }
    } else return false
    if (bytes > 65_536 || pending.length > 4_096) return false
  }
  return new TextEncoder().encode(JSON.stringify(value)).length <= 65_536
}

export const GraphInputSchema = z
  .custom<GraphInput>(isBoundedGraphInput, 'Graph input must be bounded plain JSON')
  .transform((input) => JSON.parse(JSON.stringify(input)) as GraphInput)
  .meta({
    type: 'object',
    additionalProperties: {},
    maxProperties: 4_096,
    description:
      'Plain JSON object, at most 65536 serialized UTF-8 bytes, 4096 values and 16 nested levels; executable and non-finite values are rejected.',
  })
export const GraphSelectionSchema = z
  .object({ reference: GraphReferenceSchema, input: GraphInputSchema })
  .strict()
export type GraphSelection = z.output<typeof GraphSelectionSchema>
export type GraphDefinitionContent = z.output<typeof GraphDefinitionContentSchema>
