import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  createRegistry,
  defineDoc,
  defineTask,
  Harness,
  InboxDoc,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

// Test-only capability probe. This is NOT PiNativeCancellationBoundaryPort:
// a host document guards only participating callbacks, not Pi's ordinary abort,
// scheduler or other writers. No independent authority or production grant exists.
const ProbeDoc = defineDoc({
  kind: 'cp.test.native-fence-public-api-probe',
  scope: 'session',
  version: 1,
  initial: () => ({ restrictions: [], observations: [] }),
})
const CompletedTask = defineTask({
  name: 'cp.test.public-probe-completed',
  version: 1,
  initial: () => ({ phase: 'work' }),
  phases: {
    async work(_task, runtime, context) {
      await runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        context
      )
    },
  },
  async abort(_task, runtime, context) {
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context)
  },
})

async function open(path) {
  const storage = await openNodeSqliteStorage(path)
  const registry = createRegistry()
  registry.install({ name: 'cp.test.public-probe', tasks: [CompletedTask] })
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry, settings: { compaction: { enabled: false } } },
    BACKGROUND_CONTEXT
  )
  const root = await harness.root(BACKGROUND_CONTEXT)
  return {
    harness,
    root,
    async close() {
      await harness.close(BACKGROUND_CONTEXT)
      await storage.close(BACKGROUND_CONTEXT)
    },
  }
}

async function fixture(use) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-public-fence-probe-'))
  const path = join(directory, 'native.sqlite')
  let current = await open(path)
  try {
    await use(current, async () => {
      await current.close()
      current = await open(path)
      return current
    })
  } finally {
    await current.close()
    await rm(directory, { recursive: true, force: true })
  }
}

async function installRestriction(root, mutationId) {
  return root.commit(async (tx) => {
    const doc = await tx.doc(ProbeDoc)
    if (!doc.restrictions.includes(mutationId)) doc.restrictions.push(mutationId)
    return [...doc.restrictions]
  }, BACKGROUND_CONTEXT)
}

async function scanAll(scan) {
  const values = []
  let cursor
  do {
    const page = await scan(cursor)
    values.push(...page.items)
    cursor = page.next
  } while (cursor)
  return values
}

// Deliberately rejects children/live work/queued input: the public transaction
// can observe these records and write a host receipt, but has no guarded abort
// operation. This proves only an exact closed-world test-store observation.
async function observeEmptyOrTerminal(root, observationId, beforeCommit) {
  return root.commit(async (tx) => {
    const conversations = await scanAll((cursor) => tx.scanConversations({}, 1, cursor))
    const tasks = await scanAll((cursor) => tx.scanTasks({}, 1, cursor))
    const inbox = await tx.doc(InboxDoc, root.id)
    const doc = await tx.doc(ProbeDoc)
    if (conversations.length !== 1 || conversations[0].id !== root.id)
      throw new Error('PROBE_SCOPE_NOT_ROOT_ONLY')
    if (tasks.some((task) => task.conversationId !== root.id || task.state.status !== 'terminal'))
      throw new Error('PROBE_NATIVE_ABORT_UNAVAILABLE')
    if (inbox.items.length !== 0) throw new Error('PROBE_NATIVE_ABORT_UNAVAILABLE')
    if (doc.restrictions.length !== 0) throw new Error('PROBE_RESTRICTED')
    const existing = doc.observations.find((item) => item.id === observationId)
    if (existing) return JSON.parse(JSON.stringify(existing))
    const observation = {
      id: observationId,
      conversationId: root.id,
      taskIds: tasks.map((task) => task.id),
      outcome: 'observed-empty-or-terminal',
      qualifiedAuthorization: false,
    }
    doc.observations.push(observation)
    await beforeCommit?.()
    return observation
  }, BACKGROUND_CONTEXT)
}

const snapshot = ({ harness }) => harness.snapshot(ProbeDoc, BACKGROUND_CONTEXT)

describe('public Pi SQLite transaction capability probe, not qualified cancellation', () => {
  test('empty observation before two restrictions retains immutable evidence and union after reopen', async () => {
    await fixture(async (current, reopen) => {
      const observation = await observeEmptyOrTerminal(current.root, 'observation-1')
      expect(observation).toMatchObject({ taskIds: [], qualifiedAuthorization: false })
      expect(await observeEmptyOrTerminal(current.root, 'observation-1')).toEqual(observation)
      await installRestriction(current.root, 'revoke-membership')
      await installRestriction(current.root, 'shorten-deadline')
      await installRestriction(current.root, 'revoke-membership')
      const reopened = await reopen()
      expect(await snapshot(reopened)).toEqual({
        restrictions: ['revoke-membership', 'shorten-deadline'],
        observations: [observation],
      })
      await expect(observeEmptyOrTerminal(reopened.root, 'observation-2')).rejects.toThrow(
        'PROBE_RESTRICTED'
      )
      expect((await snapshot(reopened)).observations).toEqual([observation])
    })
  })

  test('restriction before observation rejects without a host receipt', async () => {
    await fixture(async (current, reopen) => {
      await installRestriction(current.root, 'revoke')
      await expect(observeEmptyOrTerminal(current.root, 'denied')).rejects.toThrow(
        'PROBE_RESTRICTED'
      )
      expect(await snapshot(await reopen())).toEqual({ restrictions: ['revoke'], observations: [] })
    })
  })

  test('failed native transaction rolls back its host observation', async () => {
    await fixture(async (current, reopen) => {
      await expect(
        observeEmptyOrTerminal(current.root, 'rolled-back', () => {
          throw new Error('PROBE_ROLLBACK')
        })
      ).rejects.toThrow('PROBE_ROLLBACK')
      expect(await snapshot(await reopen())).toBeUndefined()
    })
  })

  test('only exact already-terminal records are observed, including paginated scans', async () => {
    await fixture(async (current, reopen) => {
      const taskIds = []
      for (let index = 0; index < 2; index++) {
        const id = await current.root.commit(
          (tx) => tx.createTask(CompletedTask, null, { ownership: { kind: 'conversation' } }),
          BACKGROUND_CONTEXT
        )
        taskIds.push(id)
      }
      await expect(observeEmptyOrTerminal(current.root, 'not-terminal')).rejects.toThrow(
        'PROBE_NATIVE_ABORT_UNAVAILABLE'
      )
      for (const id of taskIds) {
        const task = await current.harness.waitForTask(id, BACKGROUND_CONTEXT)
        expect(task.state.outcome.status).toBe('completed')
      }
      const receipt = await observeEmptyOrTerminal(current.root, 'terminal')
      expect(receipt.taskIds).toEqual(taskIds)
      expect((await snapshot(await reopen())).observations).toEqual([receipt])
    })
  })

  test('a broader conversation set is rejected rather than treated as an empty root scope', async () => {
    await fixture(async (current) => {
      await current.root.commit(
        (tx) => tx.createConversation({ ownership: { kind: 'ownerless' } }),
        BACKGROUND_CONTEXT
      )
      await expect(observeEmptyOrTerminal(current.root, 'wrong-scope')).rejects.toThrow(
        'PROBE_SCOPE_NOT_ROOT_ONLY'
      )
      expect(await snapshot(current)).toBeUndefined()
    })
  })

  test('ordinary abort still withdraws queued input despite the unrelated host restriction', async () => {
    await fixture(async (current) => {
      await installRestriction(current.root, 'revoke')
      const submissionId = await current.root.commit(async (tx) => {
        const inbox = await tx.doc(InboxDoc, current.root.id)
        const record = await tx.createSubmission({
          conversationId: current.root.id,
          requestId: 'probe-queued-input',
          type: 'input',
          status: 'queued',
        })
        inbox.items.push({ id: record.id, mode: 'followUp', content: 'test-only queued input' })
        return record.id
      }, BACKGROUND_CONTEXT)
      await current.root.abort(BACKGROUND_CONTEXT)
      const settled = await current.root.commit(
        (tx) => tx.submissionByRequest(current.root.id, 'probe-queued-input'),
        BACKGROUND_CONTEXT
      )
      expect(settled).toMatchObject({ id: submissionId, status: 'unanswered', reason: 'aborted' })
      expect(await current.harness.snapshot(InboxDoc, current.root.id, BACKGROUND_CONTEXT)).toEqual(
        {
          items: [],
        }
      )
      expect(await snapshot(current)).toEqual({ restrictions: ['revoke'], observations: [] })
    })
  })
})
