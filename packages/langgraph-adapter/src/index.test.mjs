import { describe, expect, test } from 'bun:test'
import { MemorySaver } from '@langchain/langgraph'
import {
  LangGraphOrchestrationAdapter,
  deterministicInterruptGraph,
  deterministicTestGraph,
} from './index.ts'
import { createTelemetry } from '@control-plane/telemetry'

const request = {
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
  graph: {
    graphDefinitionId: 'deterministic-test',
    graphVersion: '1.0.0',
    contentDigest: `sha256:${'a'.repeat(64)}`,
  },
  threadId: 'thread-test-1',
  input: { objective: 'verify boundaries' },
  idempotencyKey: 'test:segment:1',
}

describe('LangGraph orchestration adapter', () => {
  test('executes multiple nodes through the normalized operation port', async () => {
    const calls = []
    const events = []
    const adapter = new LangGraphOrchestrationAdapter({
      graphs: [deterministicTestGraph(request.graph)],
      checkpointer: new MemorySaver(),
      operations: {
        async invoke(operation) {
          calls.push(operation)
          return { value: `${operation.kind}:${operation.name}` }
        },
        async cancel() {
          return true
        },
      },
      events: {
        async publish(event) {
          events.push(event)
        },
      },
      now: () => '2026-08-25T12:00:00.000Z',
    })
    const result = await adapter.run(request)
    expect(result).toMatchObject({ status: 'completed', output: { summary: 'tool:lookup' } })
    expect(calls.map(({ kind }) => kind)).toEqual(['runtime', 'model', 'tool'])
    expect(events.map(({ type }) => type)).toContain('graph.node.completed')
  })

  test('keeps a secret canary out of graph checkpoints, operations, and traces', async () => {
    const secretCanary = 'secret-canary-langgraph-9f4a'
    const spans = []
    const operations = []
    const checkpointer = new MemorySaver()
    const checkpointConfig = {
      configurable: {
        thread_id: `${request.workspaceId}:${request.executionId}:${request.threadId}`,
      },
    }
    const telemetry = createTelemetry({
      serviceName: 'workflow-worker',
      traceAdapter: {
        startSpan(input) {
          const record = { input, outcome: undefined }
          spans.push(record)
          return { end: (outcome) => (record.outcome = outcome) }
        },
      },
    })
    const adapter = new LangGraphOrchestrationAdapter({
      graphs: [deterministicTestGraph(request.graph)],
      checkpointer,
      operations: {
        async invoke(operation) {
          operations.push(operation)
          return { value: `${operation.kind}:${operation.name}` }
        },
        async cancel() {
          return true
        },
      },
      events: { async publish() {} },
      telemetry,
    })

    await expect(
      adapter.run({
        ...request,
        input: { objective: 'verify boundaries', authorization: `Bearer ${secretCanary}` },
      })
    ).rejects.toMatchObject({ code: 'INVALID_GRAPH_REQUEST' })
    expect(await checkpointer.getTuple(checkpointConfig)).toBe(undefined)
    expect(operations).toEqual([])
    expect(spans).toEqual([])

    await expect(adapter.run(request)).resolves.toMatchObject({ status: 'completed' })

    const checkpoint = await checkpointer.getTuple(checkpointConfig)

    expect(spans.map(({ input }) => input.name)).toEqual([
      'graph.run',
      'graph.node',
      'runtime.start',
      'graph.node',
      'model.call',
      'graph.node',
      'tool.execute',
    ])
    expect(
      spans.every(
        ({ input }) =>
          input.attributes['execution.id'] === request.executionId &&
          input.attributes['workflow.id'] === request.workflowId
      )
    ).toBe(true)
    expect(spans.every(({ outcome }) => outcome.status === 'ok')).toBe(true)
    expect(JSON.stringify({ checkpoint, operations, spans })).not.toContain(secretCanary)
    expect(operations[0].input).toEqual(request.input)
  })

  test('normalizes graph failures and cancellation without exposing input', async () => {
    const cancellationKeys = []
    const adapter = new LangGraphOrchestrationAdapter({
      graphs: [deterministicTestGraph(request.graph)],
      checkpointer: new MemorySaver(),
      operations: {
        async invoke() {
          throw new Error('provider secret verify boundaries')
        },
        async cancel(_executionId, _threadId, idempotencyKey) {
          cancellationKeys.push(idempotencyKey)
          return true
        },
      },
      events: {
        async publish(event, idempotencyKey) {
          if (event.type === 'graph.cancelled') cancellationKeys.push(idempotencyKey)
        },
      },
    })
    await expect(adapter.run(request)).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'GRAPH_FAILED', retryable: true },
    })
    await expect(
      adapter.cancel({
        executionId: request.executionId,
        attemptId: request.attemptId,
        workspaceId: request.workspaceId,
        workflowId: request.workflowId,
        graph: request.graph,
        threadId: request.threadId,
        reason: 'user_request',
        idempotencyKey: 'workflow:cancel:stable',
      })
    ).resolves.toBe(true)
    expect(cancellationKeys).toEqual(['workflow:cancel:stable', 'workflow:cancel:stable'])
  })

  test('resumes an interrupt from its exact durable checkpoint after adapter restart', async () => {
    const checkpointer = new MemorySaver()
    const calls = []
    const options = {
      graphs: [deterministicInterruptGraph(request.graph)],
      checkpointer,
      operations: {
        async invoke(operation) {
          calls.push(operation)
          return { value: operation.name }
        },
        async cancel() {
          return true
        },
      },
      events: { async publish() {} },
      now: () => '2026-08-25T12:00:00.000Z',
    }
    const first = await new LangGraphOrchestrationAdapter(options).run(request)
    expect(first).toMatchObject({
      status: 'awaiting_input',
      interrupt: { interactionKey: 'approval-1', kind: 'approval' },
    })
    expect(first.checkpointId).toBeString()

    await expect(
      new LangGraphOrchestrationAdapter(options).resume({
        executionId: request.executionId,
        attemptId: request.attemptId,
        workspaceId: request.workspaceId,
        workflowId: request.workflowId,
        graph: request.graph,
        threadId: request.threadId,
        checkpointId: first.checkpointId,
        response: { authorization: 'Bearer secret-resume-canary-9f4a' },
        idempotencyKey: 'test:segment:resume:rejected-secret',
      })
    ).rejects.toMatchObject({ code: 'INVALID_GRAPH_REQUEST' })

    const resumed = await new LangGraphOrchestrationAdapter(options).resume({
      executionId: request.executionId,
      attemptId: request.attemptId,
      workspaceId: request.workspaceId,
      workflowId: request.workflowId,
      graph: request.graph,
      threadId: request.threadId,
      checkpointId: first.checkpointId,
      response: { action: 'approve' },
      idempotencyKey: 'test:segment:resume:approval-1',
    })
    expect(resumed).toMatchObject({ status: 'completed', output: { decision: 'approve' } })
    expect(calls.map(({ name }) => name)).toEqual(['prepare', 'finalize'])
  })

  test('keeps node side-effect idempotency keys stable across activity retry', async () => {
    const effects = new Set()
    const adapter = new LangGraphOrchestrationAdapter({
      graphs: [deterministicTestGraph(request.graph)],
      checkpointer: new MemorySaver(),
      operations: {
        async invoke(operation) {
          effects.add(operation.idempotencyKey)
          return { value: operation.name }
        },
        async cancel() {
          return true
        },
      },
      events: { async publish() {} },
    })
    await adapter.run(request)
    await adapter.run(request)
    expect(effects.size).toBe(3)
    expect([...effects].every((key) => /^graph-op-v1:[a-f0-9]{64}$/.test(key))).toBe(true)
  })
})
