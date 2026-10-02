import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemorySaver } from '@langchain/langgraph'
import { GRAPH_TOOL_PINS_CAPABILITY } from '@control-plane/contracts'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import {
  GraphCatalogError,
  GraphDefinitionCatalog,
  GraphNodeOperationSchema,
  InMemoryGraphDefinitionRepository,
} from '@control-plane/orchestration'
import {
  CatalogBackedGraphDefinitionResolver,
  DeclarativeGraphCompiler,
  LangGraphSqliteCheckpointSaver,
  LangGraphOrchestrationAdapter,
} from './index.ts'

const requestBase = {
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
  threadId: 'declarative-graph-thread',
  input: { objective: 'preserve the declared graph semantics' },
  idempotencyKey: 'declarative:segment:1',
}

const compatibility = {
  contractMajorVersion: 1,
  compilerVersion: '1.0.0',
  adapterVersion: '1.4.12',
  capabilities: [],
}

const graphDefinition = {
  graphDefinitionId: 'declarative-fanout-join',
  graphVersion: '1.0.0',
  schemaVersion: 1,
  nodes: [
    { node: 'prepare', operation: { kind: 'runtime', name: 'prepare' } },
    { node: 'left', operation: { kind: 'model', name: 'left' } },
    { node: 'right', operation: { kind: 'tool', name: 'right' } },
    { node: 'join', operation: { kind: 'delegation', name: 'join' } },
    { node: 'finish', operation: { kind: 'runtime', name: 'finish' } },
  ],
  edges: [
    { from: '__start__', to: 'prepare' },
    { from: 'prepare', to: 'left' },
    { from: 'prepare', to: 'right' },
    { from: 'left', to: 'join' },
    { from: 'right', to: 'join' },
    { from: 'join', to: 'finish' },
    { from: 'finish', to: '__end__' },
  ],
  schemas: {
    input: 'control-plane.graph-input.v1',
    state: 'control-plane.graph-state.v1',
    output: 'control-plane.graph-output.v1',
  },
  requiredCapabilities: [],
  compatibility: {
    contractMajorVersions: [1],
    compilerVersions: ['1.0.0'],
    adapterVersions: ['1.4.12'],
  },
}

const toolPin = {
  toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
  toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
  contentDigest: `sha256:${'a'.repeat(64)}`,
  operation: 'right',
}

function graphDefinitionWithPinnedTool() {
  return {
    ...structuredClone(graphDefinition),
    nodes: graphDefinition.nodes.map((node) =>
      node.node === 'right'
        ? { ...node, operation: { ...node.operation, toolPin } }
        : structuredClone(node)
    ),
    requiredCapabilities: [...graphDefinition.requiredCapabilities, GRAPH_TOOL_PINS_CAPABILITY],
  }
}

const operationAllowlist = graphDefinition.nodes.map(({ operation }) => operation)

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function createSchemaRegistry(overrides = {}) {
  const validators = new Map([
    [
      'control-plane.graph-input.v1',
      (value) => record(value) && typeof value.objective === 'string',
    ],
    [
      'control-plane.graph-state.v1',
      (value) =>
        record(value) && record(value.input) && record(value.values) && record(value.output),
    ],
    [
      'control-plane.graph-output.v1',
      (value) => record(value) && typeof value.summary === 'string',
    ],
    ...Object.entries(overrides),
  ])

  return {
    getValidator(reference) {
      return validators.get(reference)
    },
  }
}

async function publish(definition = graphDefinition) {
  const catalog = new GraphDefinitionCatalog(new InMemoryGraphDefinitionRepository())
  const published = await catalog.publish({
    definition,
    publishedAt: '2026-09-30T12:00:00.000Z',
  })
  return { catalog, published }
}

function compiler(overrides = {}) {
  return new DeclarativeGraphCompiler({
    operationAllowlist,
    schemaRegistry: createSchemaRegistry(),
    maximumSteps: 32,
    ...overrides,
  })
}

function operationPort(calls) {
  return {
    async invoke(operation) {
      calls.push(operation)
      switch (operation.node) {
        case 'prepare':
          return { objective: operation.input.objective }
        case 'left':
          return { left: `left:${operation.input.prepare.objective}` }
        case 'right':
          return { right: `right:${operation.input.prepare.objective}` }
        case 'join':
          return {
            joined: `${operation.input.left.left}|${operation.input.right.right}`,
          }
        case 'finish':
          return { summary: operation.input.join.joined }
        default:
          throw new Error(`Unexpected operation node: ${operation.node}`)
      }
    },
    async cancel() {
      return true
    },
  }
}

function eventPublisher(events = []) {
  return {
    async publish(event) {
      events.push(event)
    },
  }
}

describe('declarative graph compiler', () => {
  test('compiles a published fanout and join through the operation port and checkpoints its result', async () => {
    const { published } = await publish()
    const calls = []
    const checkpointer = new MemorySaver()
    const registration = compiler().compile(published)
    const adapter = new LangGraphOrchestrationAdapter({
      graphs: [registration],
      checkpointer,
      operations: operationPort(calls),
      events: eventPublisher(),
    })

    const result = await adapter.run({ ...requestBase, graph: published.reference })

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        summary:
          'left:preserve the declared graph semantics|right:preserve the declared graph semantics',
      },
    })
    expect(calls.map(({ node, kind }) => `${node}:${kind}`)).toEqual([
      'prepare:runtime',
      'left:model',
      'right:tool',
      'join:delegation',
      'finish:runtime',
    ])
    expect(result.checkpointId).toBeString()
    const checkpoint = await checkpointer.getTuple({
      configurable: {
        thread_id: `${requestBase.workspaceId}:${requestBase.executionId}:${requestBase.threadId}`,
      },
    })
    expect(checkpoint?.checkpoint.id).toBe(result.checkpointId)
    expect(checkpoint?.checkpoint.channel_values['output']).toEqual(result.output)
  })

  test('rejects invalid digests, unknown operations, unknown schemas, and unreachable nodes', async () => {
    const { published } = await publish()
    const invalidDigest = {
      ...published,
      reference: { ...published.reference, contentDigest: `sha256:${'0'.repeat(64)}` },
    }
    expect(() => compiler().compile(invalidDigest)).toThrow(
      expect.objectContaining({ code: 'INVALID_PUBLISHED_GRAPH' })
    )

    const unknownOperation = await publish({
      ...graphDefinition,
      nodes: graphDefinition.nodes.map((node) =>
        node.node === 'prepare'
          ? { ...node, operation: { ...node.operation, name: 'unregistered' } }
          : node
      ),
    })
    expect(() => compiler().compile(unknownOperation.published)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' })
    )

    const unknownSchema = await publish({
      ...graphDefinition,
      schemas: { ...graphDefinition.schemas, state: 'control-plane.graph-state.unknown' },
    })
    expect(() => compiler().compile(unknownSchema.published)).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_GRAPH_SCHEMA' })
    )

    const unreachableNode = await publish({
      ...graphDefinition,
      nodes: [
        ...graphDefinition.nodes,
        { node: 'orphan', operation: { kind: 'runtime', name: 'prepare' } },
      ],
      edges: [...graphDefinition.edges, { from: 'orphan', to: '__end__' }],
    })
    expect(() => compiler().compile(unreachableNode.published)).toThrow(
      expect.objectContaining({ code: 'INVALID_GRAPH_TOPOLOGY' })
    )
  })

  test('validates declared graph input before dispatching any node operation', async () => {
    const { published } = await publish()
    const graphCompiler = compiler()
    expect(
      graphCompiler.validateInput(published, { objective: 'ready for plan persistence' })
    ).toBe(true)
    expect(graphCompiler.validateInput(published, { objective: 17 })).toBe(false)

    const calls = []
    const adapter = new LangGraphOrchestrationAdapter({
      graphs: [graphCompiler.compile(published)],
      checkpointer: new MemorySaver(),
      operations: operationPort(calls),
      events: eventPublisher(),
    })

    await expect(
      adapter.run({
        ...requestBase,
        graph: published.reference,
        input: { objective: 17 },
      })
    ).rejects.toMatchObject({ code: 'INVALID_GRAPH_REQUEST' })
    expect(calls).toEqual([])
  })

  test('rejects pinned tools when the configured graph environment lacks the pin capability', async () => {
    const { catalog, published } = await publish(graphDefinitionWithPinnedTool())
    const calls = []
    const resolver = new CatalogBackedGraphDefinitionResolver({
      catalogForWorkspace(workspaceId) {
        if (workspaceId !== requestBase.workspaceId) throw new Error('Unexpected workspace')
        return catalog
      },
      compatibility,
    })
    const adapter = new LangGraphOrchestrationAdapter({
      graphDefinitionResolver: resolver,
      declarativeCompiler: compiler(),
      checkpointer: new MemorySaver(),
      operations: operationPort(calls),
      events: eventPublisher(),
    })

    await expect(adapter.run({ ...requestBase, graph: published.reference })).rejects.toMatchObject(
      {
        code: 'GRAPH_INCOMPATIBLE',
      }
    )
    expect(calls).toEqual([])
    expect(compatibility.capabilities).not.toContain(GRAPH_TOOL_PINS_CAPABILITY)
  })

  test('passes the exact published tool pin to the authorized graph operation port', async () => {
    const { catalog, published } = await publish(graphDefinitionWithPinnedTool())
    const calls = []
    const resolver = new CatalogBackedGraphDefinitionResolver({
      catalogForWorkspace(workspaceId) {
        if (workspaceId !== requestBase.workspaceId) throw new Error('Unexpected workspace')
        return catalog
      },
      compatibility: {
        ...compatibility,
        capabilities: [...compatibility.capabilities, GRAPH_TOOL_PINS_CAPABILITY],
      },
    })
    const adapter = new LangGraphOrchestrationAdapter({
      graphDefinitionResolver: resolver,
      declarativeCompiler: compiler(),
      checkpointer: new MemorySaver(),
      operations: operationPort(calls),
      events: eventPublisher(),
    })

    const result = await adapter.run({ ...requestBase, graph: published.reference })

    expect(result).toMatchObject({ status: 'completed' })
    expect(calls.find(({ node }) => node === 'right')).toMatchObject({
      kind: 'tool',
      name: 'right',
      toolPin,
    })
  })

  test('rejects a tool pin attached to a non-tool operation request', () => {
    expect(
      GraphNodeOperationSchema.safeParse({
        executionId: requestBase.executionId,
        attemptId: requestBase.attemptId,
        workspaceId: requestBase.workspaceId,
        workflowId: requestBase.workflowId,
        threadId: requestBase.threadId,
        node: 'prepare',
        kind: 'runtime',
        name: 'prepare',
        input: {},
        idempotencyKey: 'graph-op-non-tool-pin',
        toolPin,
      }).success
    ).toBe(false)
  })

  test('approval signal requires a bounded JSON record', async () => {
    const { GraphNodeApprovalRequiredError } = await import('@control-plane/orchestration')
    const approval = {
      interactionKey: 'tool-approval:bounded',
      kind: 'approval',
      payload: { summary: 'Approve the operation?' },
    }
    expect(new GraphNodeApprovalRequiredError(approval).interaction).toEqual(approval)
    expect(
      () =>
        new GraphNodeApprovalRequiredError({
          ...approval,
          kind: 'input',
        })
    ).toThrow()
    expect(
      () =>
        new GraphNodeApprovalRequiredError({
          ...approval,
          payload: { detail: 'x'.repeat(16_385) },
        })
    ).toThrow()
  })

  test('uses a typed tool approval interrupt and rechecks the same durable operation on resume', async () => {
    const { GraphNodeApprovalRequiredError } = await import('@control-plane/orchestration')
    const { catalog, published } = await publish(graphDefinitionWithPinnedTool())
    const directory = await mkdtemp(join(tmpdir(), 'graph-tool-approval-'))
    const path = join(directory, 'state.sqlite')
    let persistence = new SqlitePersistenceProvider({ path })
    const calls = []
    // This state stands in for the independent durable interaction store checked by the port.
    let approvalPersisted = false
    const operations = {
      async invoke(operation) {
        calls.push(structuredClone(operation))
        switch (operation.node) {
          case 'prepare':
            return { objective: operation.input.objective }
          case 'left':
            return { left: `left:${operation.input.prepare.objective}` }
          case 'right':
            if (!approvalPersisted) {
              throw new GraphNodeApprovalRequiredError({
                interactionKey: 'tool-approval:right',
                kind: 'approval',
                payload: { summary: 'Approve this pinned tool operation?' },
              })
            }
            return { right: `right:${operation.input.prepare.objective}` }
          case 'join':
            return { joined: `${operation.input.left.left}|${operation.input.right.right}` }
          case 'finish':
            return { summary: operation.input.join.joined }
          default:
            throw new Error(`Unexpected operation node: ${operation.node}`)
        }
      },
      async cancel() {
        return true
      },
    }
    const resolver = new CatalogBackedGraphDefinitionResolver({
      catalogForWorkspace(workspaceId) {
        if (workspaceId !== requestBase.workspaceId) throw new Error('Unexpected workspace')
        return catalog
      },
      compatibility: {
        ...compatibility,
        capabilities: [...compatibility.capabilities, GRAPH_TOOL_PINS_CAPABILITY],
      },
    })
    const adapterOptions = () => ({
      graphDefinitionResolver: resolver,
      declarativeCompiler: compiler(),
      checkpointer: new LangGraphSqliteCheckpointSaver(persistence, requestBase.workspaceId),
      operations,
      events: eventPublisher(),
    })

    try {
      await persistence.migrate()
      const first = await new LangGraphOrchestrationAdapter(adapterOptions()).run({
        ...requestBase,
        graph: published.reference,
      })
      expect(first).toMatchObject({
        status: 'awaiting_input',
        interrupt: {
          interactionKey: 'tool-approval:right',
          kind: 'approval',
          payload: { summary: 'Approve this pinned tool operation?' },
        },
      })
      expect(first.checkpointId).toBeString()

      await persistence.close()
      persistence = new SqlitePersistenceProvider({ path })
      await persistence.migrate()
      const forgedWakeup = await new LangGraphOrchestrationAdapter(adapterOptions()).resume({
        executionId: requestBase.executionId,
        attemptId: requestBase.attemptId,
        workspaceId: requestBase.workspaceId,
        workflowId: requestBase.workflowId,
        graph: published.reference,
        threadId: requestBase.threadId,
        checkpointId: first.checkpointId,
        response: { approved: true },
        idempotencyKey: 'declarative:resume:forged-wakeup',
      })
      expect(forgedWakeup).toMatchObject({ status: 'awaiting_input' })

      await persistence.close()
      persistence = new SqlitePersistenceProvider({ path })
      await persistence.migrate()
      approvalPersisted = true
      const resumed = await new LangGraphOrchestrationAdapter(adapterOptions()).resume({
        executionId: requestBase.executionId,
        attemptId: requestBase.attemptId,
        workspaceId: requestBase.workspaceId,
        workflowId: requestBase.workflowId,
        graph: published.reference,
        threadId: requestBase.threadId,
        checkpointId: forgedWakeup.checkpointId,
        response: { approved: false },
        idempotencyKey: 'declarative:resume:after-persisted-approval',
      })

      expect(resumed).toMatchObject({ status: 'completed' })
      const rightCalls = calls.filter(({ node }) => node === 'right')
      expect(rightCalls.length).toBeGreaterThanOrEqual(3)
      expect(new Set(rightCalls.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(1)
      expect(
        rightCalls.every(
          ({ toolPin: actualPin }) => JSON.stringify(actualPin) === JSON.stringify(toolPin)
        )
      ).toBe(true)
      expect(rightCalls.every(({ input }) => !Object.hasOwn(input, 'response'))).toBe(true)
    } finally {
      await persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('does not turn a non-tool approval error into a graph interrupt', async () => {
    const { GraphNodeApprovalRequiredError } = await import('@control-plane/orchestration')
    const { published } = await publish()
    const adapter = new LangGraphOrchestrationAdapter({
      graphs: [compiler().compile(published)],
      checkpointer: new MemorySaver(),
      operations: {
        async invoke() {
          throw new GraphNodeApprovalRequiredError({
            interactionKey: 'tool-approval:wrong-kind',
            kind: 'approval',
            payload: { summary: 'Unexpected runtime approval signal' },
          })
        },
        async cancel() {
          return true
        },
      },
      events: eventPublisher(),
    })

    const result = await adapter.run({ ...requestBase, graph: published.reference })

    expect(result).toMatchObject({ status: 'failed', failure: { code: 'GRAPH_FAILED' } })
  })

  test('rejects sensitive approval payloads before they enter interrupt checkpoints', async () => {
    const { GraphNodeApprovalRequiredError } = await import('@control-plane/orchestration')
    const { published } = await publish()
    const checkpointer = new MemorySaver()
    const secretCanary = 'secret-canary-approval-interrupt-3c18'
    const regularOperations = operationPort([])
    const adapter = new LangGraphOrchestrationAdapter({
      graphs: [compiler().compile(published)],
      checkpointer,
      operations: {
        async invoke(operation) {
          if (operation.node === 'right') {
            throw new GraphNodeApprovalRequiredError({
              interactionKey: 'tool-approval:secret-payload',
              kind: 'approval',
              payload: { authorization: `Bearer ${secretCanary}` },
            })
          }
          return regularOperations.invoke(operation)
        },
        async cancel() {
          return true
        },
      },
      events: eventPublisher(),
    })

    const result = await adapter.run({ ...requestBase, graph: published.reference })

    expect(result).toMatchObject({ status: 'failed' })
    expect(JSON.stringify(result)).not.toContain(secretCanary)
    expect(JSON.stringify(checkpointer.storage)).not.toContain(secretCanary)
  })

  test('does not interpret ordinary JSON tool output as an approval request', async () => {
    const { published } = await publish()
    const calls = []
    const adapter = new LangGraphOrchestrationAdapter({
      graphs: [compiler().compile(published)],
      checkpointer: new MemorySaver(),
      operations: {
        ...operationPort(calls),
        async invoke(operation) {
          calls.push(operation)
          if (operation.node === 'right') {
            return {
              right: `right:${operation.input.prepare.objective}`,
              interactionKey: 'looks-like-an-approval',
              kind: 'approval',
              payload: { summary: 'Ordinary operation data' },
            }
          }
          return operationPort([]).invoke(operation)
        },
      },
      events: eventPublisher(),
    })

    const result = await adapter.run({ ...requestBase, graph: published.reference })

    expect(result).toMatchObject({ status: 'completed' })
    expect(calls.filter(({ node }) => node === 'right')).toHaveLength(1)
  })

  test('leaves an active graph running and emits no cancellation event when cancellation is unknown', async () => {
    const { published } = await publish()
    let signalStarted
    const started = new Promise((resolve) => {
      signalStarted = resolve
    })
    let releaseOperation
    const pendingOperation = new Promise((resolve) => {
      releaseOperation = resolve
    })
    const events = []
    const regularOperations = operationPort([])
    const adapter = new LangGraphOrchestrationAdapter({
      graphs: [compiler().compile(published)],
      checkpointer: new MemorySaver(),
      operations: {
        async invoke(operation) {
          if (operation.node !== 'prepare') return regularOperations.invoke(operation)
          signalStarted()
          await pendingOperation
          return { objective: operation.input.objective }
        },
        async cancel() {
          return false
        },
      },
      events: eventPublisher(events),
    })

    const running = adapter.run({ ...requestBase, graph: published.reference })
    await started
    const cancelled = await adapter.cancel({
      executionId: requestBase.executionId,
      attemptId: requestBase.attemptId,
      workspaceId: requestBase.workspaceId,
      workflowId: requestBase.workflowId,
      graph: published.reference,
      threadId: requestBase.threadId,
      reason: 'user_request',
      idempotencyKey: 'declarative:cancel:unknown',
    })
    releaseOperation()

    expect(cancelled).toBe(false)
    await expect(running).resolves.toMatchObject({ status: 'completed' })
    expect(events.some(({ type }) => type === 'graph.cancelled')).toBe(false)
  })

  test('bounds cyclic declarative execution with its configured LangGraph recursion limit', async () => {
    const definition = {
      ...graphDefinition,
      graphDefinitionId: 'bounded-loop',
      nodes: [
        { node: 'prepare', operation: { kind: 'runtime', name: 'prepare' } },
        { node: 'repeat', operation: { kind: 'tool', name: 'repeat' } },
        { node: 'finish', operation: { kind: 'runtime', name: 'finish' } },
      ],
      edges: [
        { from: '__start__', to: 'prepare' },
        { from: 'prepare', to: 'repeat' },
        { from: 'repeat', to: 'repeat' },
        { from: 'repeat', to: 'finish' },
        { from: 'finish', to: '__end__' },
      ],
    }
    const { published } = await publish(definition)
    const calls = []
    const graphCompiler = compiler({
      operationAllowlist: [
        { kind: 'runtime', name: 'prepare' },
        { kind: 'tool', name: 'repeat' },
        { kind: 'runtime', name: 'finish' },
      ],
      schemaRegistry: createSchemaRegistry({
        'control-plane.graph-output.v1': (value) => record(value),
      }),
      maximumSteps: 6,
    })
    const adapter = new LangGraphOrchestrationAdapter({
      graphs: [graphCompiler.compile(published)],
      checkpointer: new MemorySaver(),
      operations: {
        async invoke(operation) {
          calls.push(operation)
          if (operation.node === 'prepare') return { count: 0 }
          if (operation.node === 'finish') return { summary: 'finished' }
          return { count: (operation.input.repeat?.count ?? 0) + 1 }
        },
        async cancel() {
          return true
        },
      },
      events: eventPublisher(),
    })

    const result = await adapter.run({ ...requestBase, graph: published.reference })

    expect(result).toMatchObject({ status: 'failed', failure: { code: 'GRAPH_FAILED' } })
    const repeatCalls = calls.filter(({ node }) => node === 'repeat')
    expect(repeatCalls.length).toBeGreaterThan(1)
    expect(repeatCalls.length).toBeLessThanOrEqual(6)
  })

  test('uses checkpoint-stable idempotency keys for retries and distinct keys for feedback visits', async () => {
    const definition = {
      ...graphDefinition,
      graphDefinitionId: 'idempotent-feedback-loop',
      nodes: [
        { node: 'prepare', operation: { kind: 'runtime', name: 'prepare' } },
        { node: 'repeat', operation: { kind: 'tool', name: 'repeat' } },
        { node: 'finish', operation: { kind: 'runtime', name: 'finish' } },
      ],
      edges: [
        { from: '__start__', to: 'prepare' },
        { from: 'prepare', to: 'repeat' },
        { from: 'repeat', to: 'repeat' },
        { from: 'repeat', to: 'finish' },
        { from: 'finish', to: '__end__' },
      ],
    }
    const { published } = await publish(definition)
    const effects = new Map()
    const attempts = []
    let loseFirstRepeatResponse = true
    const checkpointer = new MemorySaver()
    const adapter = new LangGraphOrchestrationAdapter({
      graphs: [
        compiler({
          operationAllowlist: [
            { kind: 'runtime', name: 'prepare' },
            { kind: 'tool', name: 'repeat' },
            { kind: 'runtime', name: 'finish' },
          ],
          schemaRegistry: createSchemaRegistry({
            'control-plane.graph-output.v1': (value) => record(value),
          }),
          maximumSteps: 6,
        }).compile(published),
      ],
      checkpointer,
      operations: {
        async invoke(operation) {
          const payload = JSON.stringify({
            node: operation.node,
            kind: operation.kind,
            name: operation.name,
            input: operation.input,
          })
          attempts.push({ node: operation.node, key: operation.idempotencyKey, payload })
          const existing = effects.get(operation.idempotencyKey)
          if (existing) {
            if (existing.payload !== payload) {
              throw new Error('An idempotency key was reused with a different operation payload')
            }
            return existing.result
          }

          const result =
            operation.node === 'repeat'
              ? { count: (operation.input.repeat?.count ?? 0) + 1 }
              : operation.node === 'prepare'
                ? { count: 0 }
                : { summary: 'bounded' }
          effects.set(operation.idempotencyKey, { payload, result })
          if (operation.node === 'repeat' && loseFirstRepeatResponse) {
            loseFirstRepeatResponse = false
            throw new Error('The effect committed but its response was lost')
          }
          return result
        },
        async cancel() {
          return true
        },
      },
      events: eventPublisher(),
    })

    const first = await adapter.run({
      ...requestBase,
      graph: published.reference,
      idempotencyKey: 'declarative:segment:first',
    })
    expect(first).toMatchObject({ status: 'failed', failure: { code: 'GRAPH_FAILED' } })

    const saved = await checkpointer.getTuple({
      configurable: {
        thread_id: `${requestBase.workspaceId}:${requestBase.executionId}:${requestBase.threadId}`,
      },
    })
    expect(saved?.checkpoint.id).toBeString()

    const retry = await adapter.continue({
      executionId: requestBase.executionId,
      attemptId: 'att_01JABCDEF0123456789ABCDEFF',
      workspaceId: requestBase.workspaceId,
      workflowId: requestBase.workflowId,
      graph: published.reference,
      threadId: requestBase.threadId,
      checkpointId: saved.checkpoint.id,
      idempotencyKey: 'declarative:segment:retry',
    })
    expect(retry).toMatchObject({ status: 'failed', failure: { code: 'RESUME_FAILED' } })

    const repeatAttempts = attempts.filter(({ node }) => node === 'repeat')
    expect(repeatAttempts.length).toBeGreaterThan(1)
    expect(repeatAttempts[0]?.key).toBe(repeatAttempts[1]?.key)
    expect(repeatAttempts[0]?.payload).toBe(repeatAttempts[1]?.payload)

    const repeatEffects = [...effects.entries()].filter(([, effect]) => {
      return JSON.parse(effect.payload).node === 'repeat'
    })
    expect(repeatEffects.length).toBeGreaterThan(1)
    expect(new Set(repeatEffects.map(([key]) => key)).size).toBe(repeatEffects.length)
    expect(
      new Set(repeatEffects.map(([, effect]) => JSON.stringify(JSON.parse(effect.payload).input)))
        .size
    ).toBe(repeatEffects.length)
    expect(repeatEffects.map(([, effect]) => effect.result.count)).toContain(1)
    expect(repeatEffects.map(([, effect]) => effect.result.count)).toContain(2)
  })

  test('resolves new runs and pinned continuations by workspace and exact reference', async () => {
    const { catalog, published } = await publish()
    const workspaces = []
    const resolver = new CatalogBackedGraphDefinitionResolver({
      catalogForWorkspace(workspaceId) {
        workspaces.push(workspaceId)
        if (workspaceId !== requestBase.workspaceId) throw new Error('Unexpected workspace')
        return catalog
      },
      compatibility,
    })
    const calls = []
    const adapter = new LangGraphOrchestrationAdapter({
      graphs: [],
      graphDefinitionResolver: resolver,
      declarativeCompiler: compiler(),
      checkpointer: new MemorySaver(),
      operations: operationPort(calls),
      events: eventPublisher(),
    })

    const first = await adapter.run({ ...requestBase, graph: published.reference })
    expect(first).toMatchObject({ status: 'completed' })
    expect(first.checkpointId).toBeString()
    await catalog.deprecate({
      reference: published.reference,
      expectedRevision: published.revision,
      changedAt: '2026-09-30T12:01:00.000Z',
      reason: 'retained pinned execution test',
    })

    await expect(
      adapter.run({
        ...requestBase,
        executionId: 'exe_01JABCDEF0123456789ABCDEFF',
        attemptId: 'att_01JABCDEF0123456789ABCDEFF',
        workflowId: 'wfl_01JABCDEF0123456789ABCDEFF',
        graph: published.reference,
      })
    ).rejects.toBeInstanceOf(GraphCatalogError)
    await expect(
      adapter.cancel({
        executionId: requestBase.executionId,
        attemptId: requestBase.attemptId,
        workspaceId: requestBase.workspaceId,
        workflowId: requestBase.workflowId,
        graph: published.reference,
        threadId: requestBase.threadId,
        reason: 'user_request',
        idempotencyKey: 'declarative:cancel',
      })
    ).resolves.toBe(true)
    expect(workspaces).toEqual([
      requestBase.workspaceId,
      requestBase.workspaceId,
      requestBase.workspaceId,
    ])
    expect(calls).toHaveLength(5)
  })

  test('rejects operation results that would put credential material in checkpoints', async () => {
    const { published } = await publish()
    const checkpointer = new MemorySaver()
    const secretCanary = 'secret-canary-declarative-operation-7d3c'
    const adapter = new LangGraphOrchestrationAdapter({
      graphs: [compiler().compile(published)],
      checkpointer,
      operations: {
        async invoke() {
          return { authorization: `Bearer ${secretCanary}` }
        },
        async cancel() {
          return true
        },
      },
      events: eventPublisher(),
    })

    const result = await adapter.run({ ...requestBase, graph: published.reference })

    expect(result).toMatchObject({ status: 'failed', failure: { code: 'GRAPH_FAILED' } })
    expect(JSON.stringify(result)).not.toContain(secretCanary)
    expect(JSON.stringify(checkpointer.storage)).not.toContain(secretCanary)
  })
})

function forkLoopDefinition(conditional = false) {
  return {
    ...graphDefinition,
    graphDefinitionId: conditional ? 'terminating-fork-loop' : 'cyclic-fork-barrier',
    nodes: ['prepare', 'leftWait', 'left', 'right', 'join', 'finish'].map((node) => ({
      node: node.toLowerCase(),
      operation: { kind: 'tool', name: node.toLowerCase() },
    })),
    edges: [
      { from: '__start__', to: 'prepare' },
      { from: 'prepare', to: 'leftwait' },
      { from: 'leftwait', to: 'left' },
      { from: 'prepare', to: 'right' },
      { from: 'left', to: 'join' },
      { from: 'right', to: 'join' },
      {
        from: 'join',
        to: 'prepare',
        ...(conditional ? { when: { path: ['done'], equals: false } } : {}),
      },
      {
        from: 'join',
        to: 'finish',
        ...(conditional ? { when: { path: ['done'], equals: true } } : {}),
      },
      { from: 'finish', to: '__end__' },
    ],
  }
}

async function runForkLoop(conditional) {
  const definition = forkLoopDefinition(conditional)
  const { published } = await publish(definition)
  const joins = []
  const calls = []
  const adapter = new LangGraphOrchestrationAdapter({
    graphs: [
      compiler({
        operationAllowlist: definition.nodes.map(({ operation }) => operation),
        maximumSteps: 12,
      }).compile(published),
    ],
    checkpointer: new MemorySaver(),
    events: eventPublisher(),
    operations: {
      async invoke(operation) {
        calls.push(operation)
        const input = operation.input
        switch (operation.node) {
          case 'prepare':
            return { iteration: (input.join?.iteration ?? 0) + 1 }
          case 'leftwait':
            return { iteration: input.prepare.iteration }
          case 'left':
            return { iteration: input.leftwait.iteration }
          case 'right':
            return { iteration: input.prepare.iteration }
          case 'join': {
            if (!input.left || input.left.iteration !== input.right.iteration)
              throw new Error('join did not wait for both current branches')
            joins.push(input.left.iteration)
            return { iteration: input.left.iteration, done: input.left.iteration >= 2 }
          }
          case 'finish':
            return { summary: `joined:${input.join.iteration}` }
          default:
            throw new Error('unexpected node')
        }
      },
      async cancel() {
        return true
      },
    },
  })
  return { result: await adapter.run({ ...requestBase, graph: published.reference }), joins, calls }
}

test('preserves all-branch joins inside a feedback loop with staggered branch lengths', async () => {
  const { result, joins } = await runForkLoop(false)
  expect(joins.length).toBeGreaterThanOrEqual(2)
  expect(joins.slice(0, 2)).toEqual([1, 2])
  expect(result).toMatchObject({ status: 'failed', failure: { code: 'GRAPH_FAILED' } })
})

test('conditional loop exit completes after both branches join, with no extra feedback visit', async () => {
  const { result, joins, calls } = await runForkLoop(true)
  expect(result).toMatchObject({ status: 'completed', output: { summary: 'joined:2' } })
  expect(joins).toEqual([1, 2])
  expect(calls.filter(({ node }) => node === 'prepare')).toHaveLength(2)
  expect(calls.filter(({ node }) => node === 'finish')).toHaveLength(1)
})

test('routes exclusive branches through an explicit any-join without executing the other branch', async () => {
  const definition = {
    ...graphDefinition,
    graphDefinitionId: 'conditional-any-join',
    nodes: ['choose', 'left', 'right', 'finish'].map((node) => ({
      node,
      ...(node === 'finish' ? { join: 'any' } : {}),
      operation: { kind: 'tool', name: node },
    })),
    edges: [
      { from: '__start__', to: 'choose' },
      { from: 'choose', to: 'left', when: { path: ['route'], equals: 'left' } },
      { from: 'choose', to: 'right', when: { path: ['route'], equals: 'right' } },
      { from: 'left', to: 'finish' },
      { from: 'right', to: 'finish' },
      { from: 'finish', to: '__end__' },
    ],
  }
  const { published } = await publish(definition)
  const calls = []
  const graphCompiler = compiler({
    operationAllowlist: definition.nodes.map(({ operation }) => operation),
  })
  const adapter = new LangGraphOrchestrationAdapter({
    graphs: [graphCompiler.compile(published)],
    checkpointer: new MemorySaver(),
    events: eventPublisher(),
    operations: {
      async invoke(operation) {
        calls.push(operation.node)
        if (operation.node === 'choose') return { route: 'left' }
        if (operation.node === 'finish') return { summary: operation.input.left.summary }
        return { summary: 'selected left' }
      },
      async cancel() {
        return true
      },
    },
  })
  expect(await adapter.run({ ...requestBase, graph: published.reference })).toMatchObject({
    status: 'completed',
    output: { summary: 'selected left' },
  })
  expect(calls).toEqual(['choose', 'left', 'finish'])
  const mixed = await publish({
    ...definition,
    edges: definition.edges.map((edge) =>
      edge.from === 'choose' && edge.to === 'left' ? { from: 'choose', to: 'left' } : edge
    ),
  })
  expect(() => graphCompiler.compile(mixed.published)).toThrow(
    expect.objectContaining({ code: 'INVALID_GRAPH_TOPOLOGY' })
  )
})

test('conditional all-branch joins reject ambiguous conditional inputs; unmatched routes fail before later effects', async () => {
  const definition = forkLoopDefinition(true)
  const graphCompiler = compiler({
    operationAllowlist: definition.nodes.map(({ operation }) => operation),
  })
  const conditionalFanIn = await publish({
    ...definition,
    edges: definition.edges.map((edge) =>
      edge.from === 'left' && edge.to === 'join'
        ? { ...edge, when: { path: ['ready'], equals: true } }
        : edge
    ),
  })
  expect(() => graphCompiler.compile(conditionalFanIn.published)).toThrow(
    expect.objectContaining({ code: 'INVALID_GRAPH_TOPOLOGY' })
  )
  const { published } = await publish({
    ...definition,
    nodes: [{ node: 'prepare', operation: { kind: 'tool', name: 'prepare' } }],
    edges: [
      { from: '__start__', to: 'prepare' },
      { from: 'prepare', to: '__end__', when: { path: ['done'], equals: true } },
    ],
  })
  let calls = 0
  const adapter = new LangGraphOrchestrationAdapter({
    graphs: [graphCompiler.compile(published)],
    checkpointer: new MemorySaver(),
    events: eventPublisher(),
    operations: {
      async invoke() {
        calls += 1
        return { done: false }
      },
      async cancel() {
        return true
      },
    },
  })
  expect(await adapter.run({ ...requestBase, graph: published.reference })).toMatchObject({
    status: 'failed',
    failure: { retryable: false },
  })
  expect(calls).toBe(1)
})

test.each([false, true])(
  'only the selected conditional end route contributes terminal output (done=%s)',
  async (done) => {
    const definition = {
      ...graphDefinition,
      graphDefinitionId: 'conditional-direct-end',
      nodes: ['choose', 'finish'].map((node) => ({
        node,
        operation: { kind: 'tool', name: node },
      })),
      edges: [
        { from: '__start__', to: 'choose' },
        { from: 'choose', to: '__end__', when: { path: ['done'], equals: true } },
        { from: 'choose', to: 'finish', when: { path: ['done'], equals: false } },
        { from: 'finish', to: '__end__' },
      ],
    }
    const { published } = await publish(definition)
    const calls = []
    const expected = done ? { choose: { done: true } } : { finish: { summary: 'finished' } }
    const adapter = new LangGraphOrchestrationAdapter({
      graphs: [
        compiler({
          operationAllowlist: definition.nodes.map(({ operation }) => operation),
          schemaRegistry: createSchemaRegistry({
            'control-plane.graph-output.v1': (value) =>
              JSON.stringify(value) === JSON.stringify(expected),
          }),
        }).compile(published),
      ],
      checkpointer: new MemorySaver(),
      events: eventPublisher(),
      operations: {
        async invoke(operation) {
          calls.push(operation.node)
          return operation.node === 'choose' ? { done } : { summary: 'finished' }
        },
        async cancel() {
          return true
        },
      },
    })
    expect(await adapter.run({ ...requestBase, graph: published.reference })).toMatchObject({
      status: 'completed',
      output: expected,
    })
    expect(calls).toEqual(done ? ['choose'] : ['choose', 'finish'])
  }
)
