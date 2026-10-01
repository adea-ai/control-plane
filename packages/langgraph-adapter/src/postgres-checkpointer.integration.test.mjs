import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { LangGraphOrchestrationAdapter, deterministicInterruptGraph } from './index.ts'
import { LangGraphPostgresCheckpointProvider } from './postgres-checkpointer.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const connectionString = process.env.DATABASE_MIGRATION_URL

describe.skipIf(!enabled)('LangGraph PostgreSQL checkpointer', () => {
  let provider
  const threadId = `m8-checkpoint-${process.pid}`
  const executionThreadId = `m8-interrupt-${process.pid}`
  const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
  const executionId = 'exe_01JABCDEF0123456789ABCDEFG'

  beforeAll(async () => {
    if (!connectionString) throw new Error('DATABASE_MIGRATION_URL_REQUIRED')
    provider = LangGraphPostgresCheckpointProvider.fromConnectionString(connectionString)
    await provider.setup()
  })

  afterAll(async () => {
    await provider?.deleteThread(threadId)
    await provider?.deleteThread(`${workspaceId}:${executionId}:${executionThreadId}`)
    await provider?.close()
  })

  test('persists checkpoint state across provider restart with graph lineage metadata', async () => {
    const config = { configurable: { thread_id: threadId } }
    const checkpoint = {
      v: 4,
      id: '1f06b7a0-1234-6000-8000-000000000001',
      ts: '2026-08-25T13:00:00.000Z',
      channel_values: { state: { phase: 'approval' } },
      channel_versions: { state: 1 },
      versions_seen: { manager: { state: 1 } },
    }
    await provider.checkpointer.put(
      config,
      checkpoint,
      {
        source: 'input',
        step: 1,
        parents: {},
        graphDefinitionId: 'manager-graph',
        graphVersion: '1.0.0',
      },
      { state: 1 }
    )
    await provider.close()

    provider = LangGraphPostgresCheckpointProvider.fromConnectionString(connectionString)
    const recovered = await provider.latest(threadId)
    expect(recovered).toMatchObject({
      checkpointId: checkpoint.id,
      threadId,
      metadata: { graphDefinitionId: 'manager-graph', graphVersion: '1.0.0' },
    })
    expect(recovered.state).toEqual({ state: { phase: 'approval' } })
  })

  test('resumes a real interrupted graph after PostgreSQL-backed worker restart', async () => {
    const graph = {
      graphDefinitionId: 'durable-interrupt',
      graphVersion: '1.0.0',
      contentDigest: `sha256:${'c'.repeat(64)}`,
    }
    const request = {
      executionId,
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      workspaceId,
      workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
      graph,
      threadId: executionThreadId,
      input: { objective: 'survive restart' },
      idempotencyKey: 'postgres:segment:1',
    }
    const effects = new Map()
    const deliveries = []
    const adapterOptions = () => ({
      graphs: [deterministicInterruptGraph(graph)],
      checkpointer: provider.checkpointer,
      operations: {
        async invoke(operation) {
          deliveries.push(operation)
          if (!effects.has(operation.idempotencyKey)) {
            effects.set(operation.idempotencyKey, { value: operation.name })
          }
          return effects.get(operation.idempotencyKey)
        },
        async cancel() {
          return true
        },
      },
      events: { async publish() {} },
    })
    const interrupted = await new LangGraphOrchestrationAdapter(adapterOptions()).run(request)
    expect(interrupted.status).toBe('awaiting_input')
    await provider.close()

    provider = LangGraphPostgresCheckpointProvider.fromConnectionString(connectionString)
    const resumed = await new LangGraphOrchestrationAdapter(adapterOptions()).resume({
      executionId: request.executionId,
      attemptId: request.attemptId,
      workspaceId: request.workspaceId,
      workflowId: request.workflowId,
      graph,
      threadId: request.threadId,
      checkpointId: interrupted.checkpointId,
      response: { action: 'approve' },
      idempotencyKey: 'postgres:segment:resume',
    })
    expect(resumed).toMatchObject({ status: 'completed', output: { decision: 'approve' } })
    expect(deliveries.map(({ node, kind }) => ({ node, kind }))).toEqual([
      { node: 'prepare', kind: 'runtime' },
      { node: 'finalize', kind: 'tool' },
    ])
    const effectKeys = [...effects.keys()]
    expect(effectKeys).toHaveLength(2)
    for (const key of effectKeys) expect(key).toMatch(/^graph-op-v1:[a-f0-9]{64}$/)

    await provider.close()
    provider = LangGraphPostgresCheckpointProvider.fromConnectionString(connectionString)
    const replayed = await new LangGraphOrchestrationAdapter(adapterOptions()).resume({
      executionId,
      workspaceId,
      workflowId: request.workflowId,
      graph,
      threadId: executionThreadId,
      attemptId: 'att_01JABCDEF0123456789ABCDEFH',
      checkpointId: interrupted.checkpointId,
      response: { action: 'approve' },
      idempotencyKey: 'postgres:segment:redelivery',
    })
    expect(replayed).toMatchObject({ status: 'completed', output: { decision: 'approve' } })
    expect(deliveries.map(({ node }) => node)).toEqual(['prepare', 'finalize', 'finalize'])
    expect(deliveries.at(-1).attemptId).toBe('att_01JABCDEF0123456789ABCDEFH')
    expect([...effects.keys()]).toEqual(effectKeys)
    for (const delivery of deliveries) {
      expect(delivery.idempotencyKey).toBe(
        deliveries.find(({ node }) => node === delivery.node).idempotencyKey
      )
      expect(delivery.workspaceId).toBe(workspaceId)
      expect(delivery.executionId).toBe(executionId)
    }
  })
})
