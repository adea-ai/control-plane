import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from './canonical-json.ts'
import { GraphDefinitionContentSchema, GraphInputSchema } from './graphs.ts'

const legacyToolGraph = {
  graphDefinitionId: 'graph:local-tool-pin',
  graphVersion: '1.0.0',
  schemaVersion: 1,
  nodes: [{ node: 'run', operation: { kind: 'tool', name: 'invoke' } }],
  edges: [
    { from: '__start__', to: 'run' },
    { from: 'run', to: '__end__' },
  ],
  schemas: { input: 'schema:input', state: 'schema:state', output: 'schema:output' },
  requiredCapabilities: [],
  compatibility: {
    contractMajorVersions: [1],
    compilerVersions: ['1.0.0'],
    adapterVersions: ['1.0.0'],
  },
}

const graphWithToolPin = () => ({
  ...structuredClone(legacyToolGraph),
  nodes: [
    {
      node: 'run',
      operation: {
        kind: 'tool',
        name: 'invoke',
        toolPin: {
          toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
          toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
          contentDigest: `sha256:${'a'.repeat(64)}`,
          operation: 'write-record',
        },
      },
    },
  ],
  requiredCapabilities: ['graph.tool-pins.v1'],
})

const contentDigest = (value) =>
  `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`

test('graph input preserves JSON data without invoking accessors', () => {
  const input = { objective: 'Review', values: [null, 1, true, { name: 'task' }] }
  expect(GraphInputSchema.parse(input)).toEqual(input)
  let calls = 0
  const accessor = {
    get value() {
      calls++
      return 'hidden'
    },
  }
  expect(GraphInputSchema.safeParse(accessor).success).toBe(false)
  expect(calls).toBe(0)
})

test('graph input rejects lossy arrays and enforces serialized byte size', () => {
  const sparse = []
  sparse.length = 5
  const extra = [1]
  extra.hidden = 'omitted by JSON'
  for (const values of [sparse, extra, Array.from({ length: 5_000 }, () => 0)]) {
    expect(GraphInputSchema.safeParse({ values }).success).toBe(false)
  }
  expect(GraphInputSchema.safeParse({ value: '\u0000'.repeat(12_000) }).success).toBe(false)
})

test('graph input rejects cycles, unsafe prototypes and executable values', () => {
  const cyclic = {}
  cyclic.self = cyclic
  for (const value of [
    cyclic,
    { value: Infinity },
    { value: () => 1 },
    { value: undefined },
    { value: new Date() },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ]) {
    expect(GraphInputSchema.safeParse(value).success).toBe(false)
  }
})

test('graph content accepts an exact immutable tool pin behind its capability declaration', () => {
  const definition = graphWithToolPin()

  expect(GraphDefinitionContentSchema.parse(definition)).toEqual(definition)
})

for (const [caseName, mutate, invalidField] of [
  [
    'tool definition identifier',
    (pin) => (pin.toolDefinitionId = 'tool_01JABCDEF0123456789ABCDEFG'),
    'toolDefinitionId',
  ],
  [
    'tool version identifier',
    (pin) => (pin.toolVersionId = 'version_01JABCDEF0123456789ABCDEFG'),
    'toolVersionId',
  ],
  ['content digest', (pin) => (pin.contentDigest = 'sha256:not-a-digest'), 'contentDigest'],
  ['canonical operation', (pin) => (pin.operation = 'Write_Record'), 'operation'],
]) {
  test(`graph content rejects a malformed ${caseName} in a tool pin`, () => {
    const definition = graphWithToolPin()
    mutate(definition.nodes[0].operation.toolPin)
    const result = GraphDefinitionContentSchema.safeParse(definition)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some(
          ({ path }) => path.join('.') === `nodes.0.operation.toolPin.${invalidField}`
        )
      ).toBe(true)
    }
  })
}

for (const kind of ['runtime', 'model', 'delegation']) {
  test(`graph content rejects a tool pin on a ${kind} operation`, () => {
    const nonToolDefinition = graphWithToolPin()
    nonToolDefinition.nodes[0].operation.kind = kind
    const result = GraphDefinitionContentSchema.safeParse(nonToolDefinition)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some(
          ({ code, keys, path }) =>
            code === 'unrecognized_keys' &&
            path.join('.') === 'nodes.0.operation' &&
            keys.includes('toolPin')
        )
      ).toBe(true)
    }
  })
}

test('graph content requires graph.tool-pins.v1 when a tool pin is present', () => {
  const definition = graphWithToolPin()
  definition.requiredCapabilities = []

  const result = GraphDefinitionContentSchema.safeParse(definition)
  expect(result.success).toBe(false)
  if (!result.success) {
    expect(
      result.error.issues.some(({ message }) =>
        message.includes('Pinned tool operations require graph.tool-pins.v1')
      )
    ).toBe(true)
  }
})

test('graph tool pins require all four binding fields and reject extra fields', () => {
  const missingField = graphWithToolPin()
  delete missingField.nodes[0].operation.toolPin.operation
  const missingResult = GraphDefinitionContentSchema.safeParse(missingField)
  expect(missingResult.success).toBe(false)
  if (!missingResult.success) {
    expect(
      missingResult.error.issues.some(
        ({ path }) => path.join('.') === 'nodes.0.operation.toolPin.operation'
      )
    ).toBe(true)
  }

  const extraField = graphWithToolPin()
  extraField.nodes[0].operation.toolPin.alias = 'alternate-name'
  const extraResult = GraphDefinitionContentSchema.safeParse(extraField)
  expect(extraResult.success).toBe(false)
  if (!extraResult.success) {
    expect(
      extraResult.error.issues.some(
        ({ code, keys, path }) =>
          code === 'unrecognized_keys' &&
          path.join('.') === 'nodes.0.operation.toolPin' &&
          keys.includes('alias')
      )
    ).toBe(true)
  }
})

test('adding optional tool pins leaves legacy graph content and digest unchanged', () => {
  const parsed = GraphDefinitionContentSchema.parse(legacyToolGraph)

  expect(parsed).toEqual(legacyToolGraph)
  expect(contentDigest(parsed)).toBe(
    'sha256:a24b44aea35afd3538a2e446523d8154cf25be2182e31cd0755851a5b26e940d'
  )
})

test('tool pin version, content digest, and operation each change graph content digest', () => {
  const definition = graphWithToolPin()
  const baseline = contentDigest(definition)
  const mutations = [
    (pin) => (pin.toolDefinitionId = 'tld_01JABCDEF0123456789ABCDEFH'),
    (pin) => (pin.toolVersionId = 'tlv_01JABCDEF0123456789ABCDEFH'),
    (pin) => (pin.contentDigest = `sha256:${'b'.repeat(64)}`),
    (pin) => (pin.operation = 'read-record'),
  ]

  for (const mutate of mutations) {
    const changed = structuredClone(definition)
    mutate(changed.nodes[0].operation.toolPin)
    expect(contentDigest(changed)).not.toBe(baseline)
  }
})
