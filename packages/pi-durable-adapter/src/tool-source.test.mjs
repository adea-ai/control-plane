import { expect, test } from 'bun:test'
import { piDurableToolSourceKey, verifyPiDurableToolSource } from './tool-source.ts'

function fixture() {
  const source = {
    schemaVersion: 'pi-tool-source/v1',
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
    parentExecutionId: 'exe_01JABCDEF0123456789ABCDEFG',
    parentAttemptId: 'att_01JABCDEF0123456789ABCDEFG',
    runtimeHandleId: 'pi:retained-handle',
    externalSessionId: 'ses_01JABCDEF0123456789ABCDEFG',
    admittedTurnKey: 'pi-turn:admitted-initial',
    conversationId: 'conversation:one',
    taskId: 'task:one',
    assistantEntryId: 'entry:one',
    callId: 'call:one',
  }
  const objective = { objective: 'Inspect the bounded child target' }
  const task = {
    id: source.taskId,
    conversationId: source.conversationId,
    kind: 'pi.tool',
    version: 1,
    abortRequested: false,
    input: { assistant: source.assistantEntryId, callId: source.callId },
    state: {
      status: 'running',
      checkpoint: { phase: 'execute', arguments: structuredClone(objective), replay: 'safe' },
    },
  }
  const entry = {
    id: source.assistantEntryId,
    conversationId: source.conversationId,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: source.callId,
            name: 'delegate_child',
            arguments: structuredClone(objective),
          },
        ],
      },
    ],
  }
  let authorityReads = 0
  const reader = {
    assertCurrent: async () => {
      authorityReads++
    },
    readTask: async () => structuredClone(task),
    readAssistantEntry: async () => structuredClone(entry),
  }
  return { source, objective, task, entry, reader, authorityReads: () => authorityReads }
}

test('native source binds replay identity and rereads authority without admitting effects', async () => {
  const setup = fixture()
  const first = await verifyPiDurableToolSource(setup.source, setup.objective, setup.reader)
  const replay = await verifyPiDurableToolSource(setup.source, setup.objective, setup.reader)
  expect(first).toEqual(replay)
  expect(first.sourceKey).toMatch(/^pi-tool:[a-f0-9]{64}$/)
  expect(setup.authorityReads()).toBe(6)
  for (const field of [
    'parentAttemptId',
    'admittedTurnKey',
    'taskId',
    'assistantEntryId',
    'callId',
  ]) {
    const changed = {
      ...setup.source,
      [field]:
        field === 'parentAttemptId'
          ? 'att_01JABCDEF0123456789ABCDEFA'
          : `${setup.source[field]}-changed`,
    }
    expect(piDurableToolSourceKey(changed)).not.toBe(first.sourceKey)
  }
})

test('Pi1.1 numeric durable identities normalize without accepting foreign records', async () => {
  const setup = fixture()
  Object.assign(setup.source, {
    taskId: '2',
    conversationId: '1',
    assistantEntryId: '3',
    callId: 'call_one|fc_one',
  })
  Object.assign(setup.task, {
    id: 2,
    conversationId: 1,
    input: { assistant: 3, callId: setup.source.callId },
  })
  Object.assign(setup.entry, { id: 3, conversationId: 1 })
  setup.entry.model[0].content[0].id = setup.source.callId
  const result = await verifyPiDurableToolSource(setup.source, setup.objective, setup.reader)
  expect(result.sourceKey).toBe(piDurableToolSourceKey(setup.source))
  setup.entry.id = 4
  await expect(
    verifyPiDurableToolSource(setup.source, setup.objective, setup.reader)
  ).rejects.toThrow('PI_TOOL_SOURCE_REJECTED')
})

test.each([
  'wrong_task',
  'aborted',
  'terminal',
  'unsafe',
  'objective',
  'duplicate_call',
  'foreign_tool',
  'foreign_entry',
  'foreign_conversation',
  'foreign_entry_kind',
  'missing_entry_identity',
])('native source rejects %s before a host receipt exists', async (fault) => {
  const setup = fixture()
  if (fault === 'wrong_task') setup.task.id = 'task:foreign'
  if (fault === 'aborted') setup.task.abortRequested = true
  if (fault === 'terminal') setup.task.state.status = 'terminal'
  if (fault === 'unsafe') setup.task.state.checkpoint.replay = 'unsafe'
  if (fault === 'objective') setup.task.state.checkpoint.arguments.objective = 'changed'
  if (fault === 'duplicate_call') setup.entry.model[0].content.push(setup.entry.model[0].content[0])
  if (fault === 'foreign_tool') setup.entry.model[0].content[0].name = 'shell'
  if (fault === 'foreign_entry') setup.entry.id = 'entry:foreign'
  if (fault === 'foreign_conversation') setup.entry.conversationId = 'conversation:foreign'
  if (fault === 'foreign_entry_kind') setup.entry.kind = 'pi.user'
  if (fault === 'missing_entry_identity') delete setup.entry.id
  await expect(
    verifyPiDurableToolSource(setup.source, setup.objective, setup.reader)
  ).rejects.toThrow('PI_TOOL_SOURCE_REJECTED')
})

test('revocation or native task change during an awaited read fails closed', async () => {
  for (const fault of ['revocation', 'native_change']) {
    const setup = fixture()
    let reads = 0
    if (fault === 'revocation') {
      setup.reader.assertCurrent = async () => {
        if (++reads === 2) throw new Error('private authority detail')
      }
    }
    if (fault === 'native_change') {
      setup.reader.readTask = async () => {
        const current = structuredClone(setup.task)
        if (++reads === 2) current.abortRequested = true
        return current
      }
    }
    await expect(
      verifyPiDurableToolSource(setup.source, setup.objective, setup.reader)
    ).rejects.toThrow('PI_TOOL_SOURCE_REJECTED')
  }
})
