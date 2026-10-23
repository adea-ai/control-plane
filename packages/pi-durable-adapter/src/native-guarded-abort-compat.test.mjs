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
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node'

// Compatibility tests for the explicit patched SDK API, not CP production wiring,
// complete writer registration, independent restore authority, or live qualification.
const FenceDoc = defineDoc({
  kind: 'cp.test.guarded-abort-compat',
  scope: 'session',
  version: 1,
  initial: () => ({ restrictions: [], admissions: [] }),
})
const context = BACKGROUND_CONTEXT
const digest = `sha256:${'a'.repeat(64)}`

function deferred() {
  let resolve
  const promise = new Promise((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

async function fixture(use, { withoutGuard = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-guarded-abort-compat-'))
  const path = join(directory, 'native.sqlite')
  const abortEntered = deferred()
  const releaseAbort = deferred()
  const releaseWork = deferred()
  const calls = { work: [], abort: [] }
  let afterSqlPreparation
  const Task = defineTask({
    name: 'cp.test.guarded-abort-task',
    version: 1,
    initial: (label) => ({ phase: 'work', label }),
    phases: {
      async work(task, runtime, callContext) {
        calls.work.push(task.input)
        await releaseWork.promise
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          callContext
        )
      },
    },
    async abort(task, runtime, callContext) {
      calls.abort.push(task.input)
      abortEntered.resolve()
      await releaseAbort.promise
      await runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'aborted' } }),
        callContext
      )
    },
  })
  async function open() {
    const db = await openNodeSqliteDatabase(path)
    if (withoutGuard) db.transactionGuarded = undefined
    if (db.transactionGuarded) {
      const guarded = db.transactionGuarded.bind(db)
      db.transactionGuarded = (callback, guard) =>
        guarded(async (tx) => {
          const value = await callback(tx)
          await afterSqlPreparation?.()
          return value
        }, guard)
    }
    const storage = await SqliteStorage.open(db)
    const registry = createRegistry()
    registry.install({ name: 'cp.test.guarded-abort-compat', tasks: [Task] })
    const harness = await Harness.open(
      storage,
      { models: createModels(), registry, settings: { compaction: { enabled: false } } },
      context
    )
    const root = await harness.root(context)
    return {
      harness,
      root,
      storage,
      async close() {
        await harness.close(context)
        await storage.close(context)
      },
    }
  }
  let current = await open()
  const api = {
    calls,
    abortEntered,
    releaseAbort,
    releaseWork,
    async createTask(label) {
      return current.root.commit(
        (tx) => tx.createTask(Task, label, { ownership: { kind: 'conversation' } }),
        context
      )
    },
    get current() {
      return current
    },
    afterSqlPreparation(callback) {
      afterSqlPreparation = callback
    },
    async reopen() {
      await current.close()
      current = await open()
      return current
    },
    async seed() {
      return current.root.commit(async (tx) => {
        const taskId = await tx.createTask(Task, 'original', {
          ownership: { kind: 'conversation' },
        })
        const submission = await tx.createSubmission({
          conversationId: current.root.id,
          requestId: 'queued-input',
          type: 'input',
          status: 'queued',
        })
        const inbox = await tx.doc(InboxDoc, current.root.id)
        inbox.items.push({
          id: submission.id,
          mode: 'followUp',
          content: 'queued compatibility input',
        })
        return { taskId, submissionId: submission.id }
      }, context)
    },
  }
  try {
    await use(api)
  } finally {
    afterSqlPreparation = undefined
    releaseAbort.resolve()
    releaseWork.resolve()
    await current.close()
    await rm(directory, { recursive: true, force: true })
  }
}

async function state(current, taskId) {
  return {
    task: taskId ? await current.harness.getTask(taskId, context) : undefined,
    inbox: await current.harness.snapshot(InboxDoc, current.root.id, context),
    doc: await current.harness.snapshot(FenceDoc, context),
    inspection: await current.harness.inspect(context),
  }
}

function request(root, id, guard = () => {}) {
  return {
    requestId: id,
    requestDigest: digest,
    metadata: { test: 'guarded-native-abort' },
    async prepare(tx, scope) {
      expect(scope.conversationId).toBe(root.id)
      expect(Object.isFrozen(scope)).toBe(true)
      expect(Object.isFrozen(scope.tasks)).toBe(true)
      expect(Object.isFrozen(scope.queuedInputs)).toBe(true)
      expect(Object.isFrozen(scope.conversations)).toBe(true)
      for (const task of scope.tasks) expect(Object.isFrozen(task)).toBe(true)
      const doc = await tx.doc(FenceDoc)
      doc.admissions.push(id)
      // Draft overlays settle before final SQL admission; retain a scalar snapshot
      // from this serialized Session mutation, not a live draft reference.
      const restricted = doc.restrictions.length !== 0
      return () => {
        if (restricted) throw new Error('FENCED')
        return guard()
      }
    },
  }
}

const installFence = (root, id) =>
  root.commitGuarded(
    async (tx) => {
      const doc = await tx.doc(FenceDoc)
      if (!doc.restrictions.includes(id)) doc.restrictions.push(id)
    },
    () => {},
    context
  )

describe('explicit guarded native abort SDK compatibility on disposable Node SQLite', () => {
  test('guard rejection rolls back task, input, host document and receipt without resuming a paused harness', async () => {
    await fixture(async (f) => {
      const { taskId } = await f.seed()
      const before = await state(f.current, taskId)
      expect(before.inspection.scheduling).toBe('paused')
      await expect(
        f.current.root.commitAbort(
          request(f.current.root, 'denied', () => {
            throw new Error('REVOKED')
          }),
          context
        )
      ).rejects.toThrow('REVOKED')
      expect(await state(f.current, taskId)).toEqual(before)
      expect(await f.current.root.readAbortReceipt('denied', context)).toBeUndefined()
      expect(f.calls).toEqual({ work: [], abort: [] })
      const reopened = await f.reopen()
      expect((await state(reopened, taskId)).task).toEqual(before.task)
      expect(await reopened.root.readAbortReceipt('denied', context)).toBeUndefined()
    })
  })

  for (const change of ['revocation', 'expiry'])
    test(`final guard observes ${change} after all asynchronous SQL preparation and rolls back`, async () => {
      await fixture(async (f) => {
        const { taskId } = await f.seed()
        const before = await state(f.current, taskId)
        let active = true
        let now = 1
        let prepared = false
        f.afterSqlPreparation(() => {
          prepared = true
          if (change === 'revocation') active = false
          else now = 10
        })
        await expect(
          f.current.root.commitAbort(
            request(f.current.root, change, () => {
              expect(prepared).toBe(true)
              if (!active) throw new Error('REVOKED')
              if (now >= 5) throw new Error('EXPIRED')
            }),
            context
          )
        ).rejects.toThrow(change === 'revocation' ? 'REVOKED' : 'EXPIRED')
        f.afterSqlPreparation(undefined)
        expect(await state(f.current, taskId)).toEqual(before)
        expect(await f.current.root.readAbortReceipt(change, context)).toBeUndefined()
        expect(f.calls).toEqual({ work: [], abort: [] })
      })
    })

  test('thenable final guards are refused with no native or host effects', async () => {
    await fixture(async (f) => {
      const { taskId } = await f.seed()
      const before = await state(f.current, taskId)
      await expect(
        f.current.root.commitAbort(
          request(f.current.root, 'async-guard', () => Promise.resolve()),
          context
        )
      ).rejects.toThrow('Final guard must return undefined synchronously')
      expect(await state(f.current, taskId)).toEqual(before)
      expect(await f.current.root.readAbortReceipt('async-guard', context)).toBeUndefined()
      expect(f.calls).toEqual({ work: [], abort: [] })
    })
  })

  test('undefined final guard rejects public commitGuarded without running its callback', async () => {
    await fixture(async (f) => {
      let invoked = false
      await expect(
        f.current.root.commitGuarded(
          async (tx) => {
            invoked = true
            const doc = await tx.doc(FenceDoc)
            doc.restrictions.push('must-not-write')
          },
          undefined,
          context
        )
      ).rejects.toThrow('Guard must be a synchronous function')
      expect(invoked).toBe(false)
      expect(await f.current.harness.snapshot(FenceDoc, context)).toBeUndefined()
      expect((await f.current.harness.inspect(context)).scheduling).toBe('paused')
    })
  })

  test('MemoryStorage refuses guarded abort before preparation and scheduling', async () => {
    const storage = new MemoryStorage()
    const harness = await Harness.open(
      storage,
      {
        models: createModels(),
        registry: createRegistry(),
        settings: { compaction: { enabled: false } },
      },
      context
    )
    try {
      const root = await harness.root(context)
      let invoked = false
      const input = request(root, 'unsupported-memory')
      input.prepare = () => {
        invoked = true
        return () => {}
      }
      await expect(root.commitAbort(input, context)).rejects.toThrow(
        'PI_GUARDED_COMMIT_UNAVAILABLE'
      )
      expect(invoked).toBe(false)
      expect((await harness.inspect(context)).scheduling).toBe('paused')
      expect(await root.readAbortReceipt('unsupported-memory', context)).toBeUndefined()
    } finally {
      await harness.close(context)
      await storage.close(context)
    }
  })

  test('SQLite database without atomic guard support fails closed without persisted effects', async () => {
    await fixture(
      async (f) => {
        const { taskId } = await f.seed()
        const before = await state(f.current, taskId)
        await expect(
          f.current.root.commitAbort(request(f.current.root, 'unsupported-sqlite'), context)
        ).rejects.toThrow('PI_GUARDED_COMMIT_UNAVAILABLE')
        expect(await state(f.current, taskId)).toEqual(before)
        expect(await f.current.root.readAbortReceipt('unsupported-sqlite', context)).toBeUndefined()
        expect(f.calls).toEqual({ work: [], abort: [] })
      },
      { withoutGuard: true }
    )
  })

  test('F before N refuses admission and preserves the exact queued input and task', async () => {
    await fixture(async (f) => {
      const { taskId } = await f.seed()
      await installFence(f.current.root, 'revoke')
      const before = await state(f.current, taskId)
      await expect(
        f.current.root.commitAbort(request(f.current.root, 'after-fence'), context)
      ).rejects.toThrow('FENCED')
      expect(await state(f.current, taskId)).toEqual(before)
      expect(await f.current.root.readAbortReceipt('after-fence', context)).toBeUndefined()
    })
  })

  test('N before F retains one exact receipt and lets F commit while D is held; drain excludes successor work', async () => {
    await fixture(async (f) => {
      const { taskId, submissionId } = await f.seed()
      const receipt = await f.current.root.commitAbort(request(f.current.root, 'admitted'), context)
      expect(receipt).toMatchObject({
        requestId: 'admitted',
        requestDigest: digest,
        taskIds: [taskId],
        queuedInputIds: [submissionId],
      })
      await f.abortEntered.promise
      let drained = false
      const drain = f.current.root.drainAbortReceipt('admitted', context).then((value) => {
        drained = true
        return value
      })
      await installFence(f.current.root, 'later-revoke')
      expect(drained).toBe(false)
      const successor = await f.createTask('successor')
      // A successor created through the ordinary public API is not part of the immutable receipt.
      expect(receipt.taskIds).toEqual([taskId])
      expect(receipt.taskIds).not.toContain(successor)
      f.releaseAbort.resolve()
      expect(await drain).toEqual(receipt)
      expect(await f.current.root.readAbortReceipt('admitted', context)).toEqual(receipt)
      expect((await f.current.harness.snapshot(FenceDoc, context)).restrictions).toEqual([
        'later-revoke',
      ])
      expect(f.calls.abort).toEqual(['original'])
      expect((await f.current.harness.getTask(successor, context)).state.status).not.toBe(
        'terminal'
      )
      f.releaseWork.resolve()
      expect((await f.current.harness.waitForTask(successor, context)).state.outcome.status).toBe(
        'completed'
      )
    })
  })

  test('request replay bypasses prepare, conflicting pins reject, and lost-response receipt survives reopen', async () => {
    await fixture(async (f) => {
      const first = await f.current.root.commitAbort(request(f.current.root, 'replay'), context)
      const replay = request(f.current.root, 'replay')
      replay.prepare = () => {
        throw new Error('REPLAY_MUST_NOT_PREPARE')
      }
      expect(await f.current.root.commitAbort(replay, context)).toEqual(first)
      await expect(
        f.current.root.commitAbort(
          { ...replay, requestDigest: `sha256:${'b'.repeat(64)}` },
          context
        )
      ).rejects.toThrow('PI_GUARDED_ABORT_REQUEST_CONFLICT')
      await expect(
        f.current.root.commitAbort({ ...replay, metadata: { test: 'changed' } }, context)
      ).rejects.toThrow('PI_GUARDED_ABORT_REQUEST_CONFLICT')
      const reopened = await f.reopen()
      expect(await reopened.root.readAbortReceipt('replay', context)).toEqual(first)
      expect(await reopened.root.drainAbortReceipt('replay', context)).toEqual(first)
      expect((await reopened.harness.snapshot(FenceDoc, context)).admissions).toEqual(['replay'])
    })
  })

  test('empty and already-terminal scopes receive exact empty-live-work receipts', async () => {
    await fixture(async (f) => {
      const empty = await f.current.root.commitAbort(request(f.current.root, 'empty'), context)
      expect(empty.taskIds).toEqual([])
      expect(empty.queuedInputIds).toEqual([])
      expect(await f.current.root.drainAbortReceipt('empty', context)).toEqual(empty)
      const completedTask = await f.createTask('completed')
      f.releaseWork.resolve()
      expect(
        (await f.current.harness.waitForTask(completedTask, context)).state.outcome.status
      ).toBe('completed')
      const terminal = await f.current.root.commitAbort(
        request(f.current.root, 'terminal'),
        context
      )
      expect(terminal.taskIds).toEqual([])
      expect(terminal.queuedInputIds).toEqual([])
      expect(await f.current.root.drainAbortReceipt('terminal', context)).toEqual(terminal)
    })
  })
})
