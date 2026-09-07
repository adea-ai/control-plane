import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { emptyCheckpoint } from '@langchain/langgraph'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import {
  LangGraphSqliteCheckpointSaver,
  LangGraphOrchestrationAdapter,
  deterministicInterruptGraph,
} from './index.ts'

test('SQLite checkpoints retain immutable state, pending writes, namespaces and scope after reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graph-sqlite-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    let saver = new LangGraphSqliteCheckpointSaver(provider, 'workspace-a')
    const config = { configurable: { thread_id: 'thread', checkpoint_ns: '' } }
    const checkpoint = {
      ...emptyCheckpoint(),
      channel_values: { content: 'durable', nested: { a: 1 } },
    }
    const metadata = { source: 'input', step: 0, parents: {} }
    const saved = await saver.put(config, checkpoint, metadata, {})
    await expect(saver.put(saved, checkpoint, metadata, {})).rejects.toThrow(
      'GRAPH_CHECKPOINT_PARENT_INVALID'
    )
    await expect(
      saver.put(
        { configurable: { ...config.configurable, checkpoint_id: 'missing' } },
        emptyCheckpoint(),
        metadata,
        {}
      )
    ).rejects.toThrow('GRAPH_CHECKPOINT_PARENT_MISSING')
    await Promise.all(Array.from({ length: 8 }, () => saver.put(config, checkpoint, metadata, {})))
    await saver.putWrites(saved, [['channel', { value: 1 }]], 'task')
    await saver.putWrites(saved, [['channel', { value: 2 }]], 'task')
    const first = await saver.getTuple(saved)
    expect(first.pendingWrites).toEqual([['task', 'channel', { value: 1 }]])
    const snapshot = await provider.backup()
    await provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    saver = new LangGraphSqliteCheckpointSaver(provider, 'workspace-a')
    expect(await saver.getTuple(saved)).toEqual(first)
    expect(
      await new LangGraphSqliteCheckpointSaver(provider, 'workspace-b').getTuple(saved)
    ).toBeUndefined()
    expect(
      await saver.getTuple({ configurable: { ...saved.configurable, checkpoint_ns: 'other' } })
    ).toBeUndefined()
    await expect(
      saver.put(config, { ...checkpoint, channel_values: { changed: true } }, metadata, {})
    ).rejects.toThrow('GRAPH_CHECKPOINT_CONFLICT')
    const child = { ...emptyCheckpoint(), id: `${checkpoint.id}-next` }
    const childConfig = await saver.put(saved, child, { ...metadata, step: 1 }, {})
    expect((await saver.getTuple(childConfig)).parentConfig).toEqual(saved)
    const listed = []
    for await (const tuple of saver.list(config, {
      before: childConfig,
      limit: 1,
      filter: { step: 0 },
    }))
      listed.push(tuple)
    expect(listed).toEqual([first])
    await saver.deleteThread('thread')
    expect(await saver.getTuple(config)).toBeUndefined()
    await provider.restore(snapshot)
    expect(await saver.getTuple(saved)).toEqual(first)
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('LangGraph resumes a SQLite interrupt after closing the database and reconstructing the adapter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graph-sqlite-interrupt-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  const request = {
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
    workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
    graph: {
      graphDefinitionId: 'sqlite-interrupt',
      graphVersion: '1.0.0',
      contentDigest: `sha256:${'a'.repeat(64)}`,
    },
    threadId: 'thread',
    input: { objective: 'recover approval' },
    idempotencyKey: 'sqlite:run',
  }
  const calls = []
  const adapter = () =>
    new LangGraphOrchestrationAdapter({
      graphs: [deterministicInterruptGraph(request.graph)],
      checkpointer: new LangGraphSqliteCheckpointSaver(provider, request.workspaceId),
      operations: {
        invoke: async ({ name }) => {
          calls.push(name)
          return { value: name }
        },
        cancel: async () => true,
      },
      events: { publish: async () => {} },
    })
  try {
    await provider.migrate()
    const interrupted = await adapter().run(request)
    expect(interrupted.status).toBe('awaiting_input')
    await provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    const { input: _input, ...resume } = request
    const result = await adapter().resume({
      ...resume,
      checkpointId: interrupted.checkpointId,
      response: { action: 'approve' },
      idempotencyKey: 'sqlite:resume',
    })
    expect(result).toMatchObject({ status: 'completed', output: { decision: 'approve' } })
    expect(calls).toEqual(['prepare', 'finalize'])
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('SQLite checkpoint writes roll back atomically and corrupted serialized state fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graph-sqlite-fault-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await provider.migrate()
    const config = { configurable: { thread_id: 'thread', checkpoint_ns: '' } }
    const checkpoint = emptyCheckpoint()
    const metadata = { source: 'input', step: 0, parents: {} }
    const broken = new LangGraphSqliteCheckpointSaver(
      {
        dialect: 'sqlite',
        transaction: (operation) =>
          provider.transaction(async (tx) => {
            await operation(tx)
            throw new Error('injected rollback')
          }),
      },
      'scope'
    )
    await expect(broken.put(config, checkpoint, metadata, {})).rejects.toThrow('injected rollback')
    const saver = new LangGraphSqliteCheckpointSaver(provider, 'scope')
    expect(await saver.getTuple(config)).toBeUndefined()
    const saved = await saver.put(config, checkpoint, metadata, {})
    await expect(
      broken.putWrites(
        saved,
        [
          ['one', 1],
          ['two', 2],
        ],
        'task'
      )
    ).rejects.toThrow('injected rollback')
    expect((await saver.getTuple(saved)).pendingWrites).toEqual([])
    const other = new LangGraphSqliteCheckpointSaver(provider, 'other-scope')
    await other.put(config, checkpoint, metadata, {})
    await saver.deleteThread('thread')
    expect(await other.getTuple(config)).toBeDefined()
    await provider.transaction(async (tx) => {
      const [record] = await tx.list('langgraph-checkpoints-v1')
      const value = structuredClone(record.value)
      value.checkpoint[1] = Buffer.from('{}').toString('base64')
      await tx.put({
        namespace: record.namespace,
        id: record.id,
        expectedRevision: record.revision,
        value,
      })
    })
    await expect(other.getTuple(config)).rejects.toThrow('GRAPH_CHECKPOINT_CORRUPT')
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
