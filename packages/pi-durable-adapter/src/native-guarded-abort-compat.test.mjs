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
    hostDocuments: [{ token: FenceDoc, mode: 'write' }],
    async prepare(tx, scope) {
      expect(scope.conversationId).toBe(root.id)
      expect(Object.isFrozen(scope)).toBe(true)
      expect(Object.isFrozen(scope.tasks)).toBe(true)
      expect(Object.isFrozen(scope.queuedInputs)).toBe(true)
      expect(Object.isFrozen(scope.conversations)).toBe(true)
      for (const task of scope.tasks) expect(Object.isFrozen(task)).toBe(true)
      const doc = await tx.doc(FenceDoc)
      await tx.replaceDoc(FenceDoc, { ...doc, admissions: [...doc.admissions, id] })
      // Preparation receives detached snapshots; retain a scalar restriction
      // from this serialized Session mutation for final SQL admission.
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
  test('preparation facet exposes no native transaction capabilities', async () => {
    await fixture(async (f) => {
      const { taskId } = await f.seed()
      const before = await state(f.current, taskId)
      await expect(
        f.current.root.commitAbort(
          {
            requestId: 'facet-capabilities',
            requestDigest: digest,
            prepare(facet) {
              for (const name of [
                'createTask',
                'createSubmission',
                'createConversation',
                'forkConversation',
                'appendEntry',
                'settleSubmission',
                'placeSubmission',
                'setTask',
                'retireDoc',
                'conversation',
                'entry',
                'task',
                'scanConversations',
                'scanEntries',
                'scanTasks',
                'latestHeadMarker',
                'submissionByRequest',
                'commit',
                'commitWith',
                'commitGuarded',
                'storage',
              ])
                expect(facet[name]).toBeUndefined()
              expect(Object.getPrototypeOf(facet)).toBeNull()
              expect(Object.isFrozen(facet)).toBe(true)
              expect(Object.keys(facet).toSorted()).toEqual(['doc', 'replaceDoc'])
              expect(Object.getPrototypeOf(facet.doc)).toBeNull()
              expect(Object.isFrozen(facet.doc)).toBe(true)
              expect(Object.getPrototypeOf(facet.replaceDoc)).toBeNull()
              expect(Object.isFrozen(facet.replaceDoc)).toBe(true)
              return () => {
                throw new Error('FACET_VERIFIED_NO_ABORT')
              }
            },
          },
          context
        )
      ).rejects.toThrow('FACET_VERIFIED_NO_ABORT')
      expect(await state(f.current, taskId)).toEqual(before)
      expect(await f.current.root.readAbortReceipt('facet-capabilities', context)).toBeUndefined()
    })
  })

  test('a queued input cannot be added after scope capture and silently omitted from the abort receipt', async () => {
    await fixture(async (f) => {
      const { taskId, submissionId } = await f.seed()
      const before = await state(f.current, taskId)
      await expect(
        f.current.root.commitAbort(
          {
            requestId: 'late-queued-input',
            requestDigest: digest,
            hostDocuments: [{ token: FenceDoc, mode: 'write' }],
            async prepare(facet, scope) {
              expect(scope.queuedInputs.map((input) => input.id)).toEqual([submissionId])
              const doc = await facet.doc(FenceDoc)
              await facet.replaceDoc(FenceDoc, { ...doc, admissions: ['must-roll-back'] })
              // This was possible with the full Tx: the new input was withdrawn by N
              // but absent from N's captured queuedInputIds. It must now be impossible.
              await facet.createSubmission({
                conversationId: f.current.root.id,
                requestId: 'created-after-capture',
                type: 'input',
                status: 'queued',
              })
              return () => {}
            },
          },
          context
        )
      ).rejects.toThrow('createSubmission')
      expect(await state(f.current, taskId)).toEqual(before)
      expect(await f.current.root.readAbortReceipt('late-queued-input', context)).toBeUndefined()
      expect(
        await f.current.root.commit(
          (tx) => tx.submissionByRequest(f.current.root.id, 'created-after-capture'),
          context
        )
      ).toBeUndefined()
      expect(
        (await f.current.harness.snapshot(InboxDoc, f.current.root.id, context)).items.map(
          (item) => item.id
        )
      ).toEqual([submissionId])
      expect(f.calls).toEqual({ work: [], abort: [] })
    })
  })

  test('host documents require an exact explicitly declared token and access mode', async () => {
    await fixture(async (f) => {
      const { taskId } = await f.seed()
      const before = await state(f.current, taskId)
      const sameAddress = defineDoc({
        kind: FenceDoc.definition.kind,
        scope: 'session',
        version: 1,
        initial: () => ({ restrictions: [], admissions: [] }),
      })
      for (const [id, declarations, token] of [
        ['undeclared-host', [], FenceDoc],
        ['forged-host-identity', [{ token: FenceDoc, mode: 'write' }], sameAddress],
      ]) {
        await expect(
          f.current.root.commitAbort(
            {
              requestId: id,
              requestDigest: digest,
              hostDocuments: declarations,
              async prepare(facet) {
                await facet.doc(token)
                return () => {}
              },
            },
            context
          )
        ).rejects.toThrow()
        expect(await state(f.current, taskId)).toEqual(before)
        expect(await f.current.root.readAbortReceipt(id, context)).toBeUndefined()
      }
    })
  })

  for (const [label, token, conversationScoped] of [
    ['genuine-inbox', InboxDoc, true],
    [
      'forged-inbox',
      defineDoc({
        kind: 'pi.inbox',
        scope: 'conversation',
        history: 'latest',
        fork: 'initial',
        version: 1,
        initial: () => ({ items: [] }),
      }),
      true,
    ],
    [
      'forged-receipts',
      defineDoc({
        kind: 'pi.guarded-abort-receipts',
        scope: 'session',
        version: 1,
        initial: () => ({ receipts: [] }),
      }),
      false,
    ],
  ])
    test(`preparation rejects reserved SDK document address ${label} even when explicitly declared`, async () => {
      await fixture(async (f) => {
        const { taskId } = await f.seed()
        const before = await state(f.current, taskId)
        let acquiredReserved = false
        const declaration = {
          token,
          mode: 'write',
          ...(conversationScoped ? { conversationId: f.current.root.id } : {}),
        }
        await expect(
          f.current.root.commitAbort(
            {
              requestId: label,
              requestDigest: digest,
              hostDocuments: [declaration],
              async prepare(facet) {
                const value = conversationScoped
                  ? await facet.doc(token, f.current.root.id)
                  : await facet.doc(token)
                acquiredReserved = true
                if (conversationScoped) value.items.length = 0
                else value.receipts.push({ requestId: 'forged-success' })
                return () => {}
              },
            },
            context
          )
        ).rejects.toThrow()
        expect(await state(f.current, taskId)).toEqual(before)
        expect(acquiredReserved).toBe(false)
        expect(await f.current.root.readAbortReceipt(label, context)).toBeUndefined()
        expect(await f.current.root.readAbortReceipt('forged-success', context)).toBeUndefined()
        expect(f.calls).toEqual({ work: [], abort: [] })
      })
    })

  test('duplicate canonical host addresses and getter-based definitions reject before preparation', async () => {
    await fixture(async (f) => {
      const { taskId } = await f.seed()
      const before = await state(f.current, taskId)
      const alias = defineDoc({ ...FenceDoc.definition })
      const newerAlias = defineDoc({ ...FenceDoc.definition, version: 2 })
      let getterReads = 0
      const getterDefinition = { scope: 'session', version: 1, initial: () => ({}) }
      Object.defineProperty(getterDefinition, 'kind', {
        enumerable: true,
        get() {
          getterReads += 1
          return 'pi.inbox'
        },
      })
      for (const [label, hostDocuments, error] of [
        [
          'same-token-read-write',
          [
            { token: FenceDoc, mode: 'read' },
            { token: FenceDoc, mode: 'write' },
          ],
          'PI_GUARDED_ABORT_DUPLICATE_HOST_DOCUMENT',
        ],
        [
          'alias-read-write',
          [
            { token: FenceDoc, mode: 'read' },
            { token: alias, mode: 'write' },
          ],
          'PI_GUARDED_ABORT_DUPLICATE_HOST_DOCUMENT',
        ],
        [
          'alias-different-version',
          [
            { token: FenceDoc, mode: 'read' },
            { token: newerAlias, mode: 'write' },
          ],
          'PI_GUARDED_ABORT_DUPLICATE_HOST_DOCUMENT',
        ],
        [
          'getter-definition',
          [{ token: { definition: getterDefinition }, mode: 'write' }],
          'own data fields',
        ],
      ]) {
        let prepared = false
        await expect(
          f.current.root.commitAbort(
            {
              requestId: label,
              requestDigest: digest,
              hostDocuments,
              prepare() {
                prepared = true
                return () => {}
              },
            },
            context
          )
        ).rejects.toThrow(error)
        expect(prepared).toBe(false)
        expect(await state(f.current, taskId)).toEqual(before)
        expect(await f.current.root.readAbortReceipt(label, context)).toBeUndefined()
      }
      expect(getterReads).toBe(0)
      expect(f.calls).toEqual({ work: [], abort: [] })
    })
  })

  test('mutating an allowed token definition cannot redirect its captured host address to native documents', async () => {
    await fixture(async (f) => {
      const previous = await f.current.root.commitAbort(
        request(f.current.root, 'retained-before-token-mutation'),
        context
      )
      await f.current.root.commit((tx) => tx.doc(InboxDoc, f.current.root.id), context)
      const inbox = await f.current.harness.snapshot(InboxDoc, f.current.root.id, context)
      for (const reserved of ['pi.inbox', 'pi.guarded-abort-receipts']) {
        const label = reserved === 'pi.inbox' ? 'inbox' : 'receipts'
        const definition = {
          kind: `cp.test.captured-host-${label}`,
          scope: 'session',
          version: 1,
          initial: () => ({ nested: { pin: 'original' } }),
        }
        const token = defineDoc(definition)
        const stableReader = defineDoc({ ...definition })
        await f.current.root.commit((tx) => tx.doc(stableReader), context)
        const receipt = await f.current.root.commitAbort(
          {
            requestId: `mutated-token-${label}`,
            requestDigest: digest,
            hostDocuments: [{ token, mode: 'write' }],
            async prepare(facet) {
              definition.kind = reserved
              if (reserved === 'pi.inbox') {
                definition.scope = 'conversation'
                definition.history = 'latest'
                definition.fork = 'initial'
              }
              expect(await facet.doc(token)).toEqual({ nested: { pin: 'original' } })
              await facet.replaceDoc(token, { nested: { pin: 'updated-host-only' } })
              return () => {}
            },
          },
          context
        )
        expect(receipt).toMatchObject({
          requestId: `mutated-token-${label}`,
          taskIds: [],
          queuedInputIds: [],
        })
        expect(await f.current.harness.snapshot(stableReader, context)).toEqual({
          nested: { pin: 'updated-host-only' },
        })
        expect(await f.current.harness.snapshot(InboxDoc, f.current.root.id, context)).toEqual(
          inbox
        )
        expect(
          await f.current.root.readAbortReceipt('retained-before-token-mutation', context)
        ).toEqual(previous)
        expect(await f.current.root.readAbortReceipt(`mutated-token-${label}`, context)).toEqual(
          receipt
        )
        expect(await f.current.root.readAbortReceipt('forged-success', context)).toBeUndefined()
      }
      expect(f.calls).toEqual({ work: [], abort: [] })
    })
  })

  test('read-only host document copies and nested native scope records cannot mutate retained state', async () => {
    await fixture(async (f) => {
      const { taskId } = await f.seed()
      await f.current.root.commit(async (tx) => {
        const doc = await tx.doc(FenceDoc)
        doc.admissions.push('retained')
      }, context)
      const before = await state(f.current, taskId)
      await expect(
        f.current.root.commitAbort(
          {
            requestId: 'read-only',
            requestDigest: digest,
            hostDocuments: [{ token: FenceDoc, mode: 'read' }],
            async prepare(facet, scope) {
              const doc = await facet.doc(FenceDoc)
              expect(Object.isFrozen(doc)).toBe(true)
              expect(Object.isFrozen(doc.admissions)).toBe(true)
              expect(() => doc.admissions.push('forged-write')).toThrow()
              await expect(
                Promise.resolve().then(() =>
                  facet.replaceDoc(FenceDoc, { ...doc, admissions: ['forged-write'] })
                )
              ).rejects.toThrow('PI_GUARDED_ABORT_HOST_DOCUMENT_DENIED')
              expect(Object.isFrozen(scope.tasks[0].state)).toBe(true)
              expect(Object.isFrozen(scope.tasks[0].state.checkpoint)).toBe(true)
              expect(() => {
                scope.tasks[0].state.checkpoint.label = 'forged-task'
              }).toThrow()
              expect(Object.isFrozen(scope.queuedInputs[0])).toBe(true)
              expect(() => {
                scope.queuedInputs[0].status = 'unanswered'
              }).toThrow()
              return () => {
                throw new Error('READ_ONLY_VERIFIED_NO_ABORT')
              }
            },
          },
          context
        )
      ).rejects.toThrow('READ_ONLY_VERIFIED_NO_ABORT')
      expect(await state(f.current, taskId)).toEqual(before)
      expect(await f.current.root.readAbortReceipt('read-only', context)).toBeUndefined()
    })
  })

  test('read-only host document access cannot migrate and rewrite a retained older document', async () => {
    await fixture(async (f) => {
      const { taskId } = await f.seed()
      let migrations = 0
      const v1 = defineDoc({
        kind: 'cp.test.read-only-host-version',
        scope: 'session',
        version: 1,
        initial: () => ({ nested: { pin: 'original' } }),
      })
      const v2 = defineDoc({
        kind: 'cp.test.read-only-host-version',
        scope: 'session',
        version: 2,
        initial: () => ({ nested: { pin: 'v2' } }),
        migrate(value) {
          migrations += 1
          return { ...value, nested: { pin: 'migrated' } }
        },
      })
      await f.current.root.commit((tx) => tx.doc(v1), context)
      const before = await state(f.current, taskId)
      await expect(
        f.current.root.commitAbort(
          {
            requestId: 'read-version-conflict',
            requestDigest: digest,
            hostDocuments: [{ token: v2, mode: 'read' }],
            async prepare(facet) {
              await facet.doc(v2)
              return () => {}
            },
          },
          context
        )
      ).rejects.toThrow('PI_GUARDED_ABORT_HOST_DOCUMENT_VERSION_CONFLICT')
      expect(migrations).toBe(0)
      expect(await state(f.current, taskId)).toEqual(before)
      expect(await f.current.harness.snapshot(v1, context)).toEqual({ nested: { pin: 'original' } })
      expect(
        await f.current.root.readAbortReceipt('read-version-conflict', context)
      ).toBeUndefined()
      const reopened = await f.reopen()
      // The v1 reader rejects newer stored versions; this successful reread also
      // proves that the failed read neither migrated nor rewrote retained bytes.
      expect(await reopened.harness.snapshot(v1, context)).toEqual({ nested: { pin: 'original' } })
      expect(migrations).toBe(0)
      expect(await reopened.root.readAbortReceipt('read-version-conflict', context)).toBeUndefined()
      expect(f.calls).toEqual({ work: [], abort: [] })
    })
  })

  test('replaceDoc detaches nested caller-owned candidates before asynchronous staging', async () => {
    await fixture(async (f) => {
      await f.current.root.commitAbort(
        {
          requestId: 'detached-candidate',
          requestDigest: digest,
          hostDocuments: [{ token: FenceDoc, mode: 'write' }],
          async prepare(facet) {
            const doc = await facet.doc(FenceDoc)
            const candidate = { ...doc, admissions: ['prepared'] }
            const staged = facet.replaceDoc(FenceDoc, candidate)
            candidate.admissions.push('mutated-after-call')
            await staged
            return () => {}
          },
        },
        context
      )
      expect((await f.current.harness.snapshot(FenceDoc, context)).admissions).toEqual(['prepared'])
      expect(await f.current.root.readAbortReceipt('detached-candidate', context)).toMatchObject({
        taskIds: [],
        queuedInputIds: [],
      })
    })
  })

  for (const outcome of ['resolved', 'rejected'])
    test(`preparation ${outcome} revokes cached facade and nested host document references`, async () => {
      await fixture(async (f) => {
        let savedFacet
        let nested
        let lateChecked = false
        const attempt = {
          requestId: `deferred-${outcome}`,
          requestDigest: digest,
          hostDocuments: [{ token: FenceDoc, mode: 'write' }],
          async prepare(facet) {
            savedFacet = facet
            const doc = await facet.doc(FenceDoc)
            nested = doc.admissions
            await facet.replaceDoc(FenceDoc, {
              ...doc,
              admissions: [...doc.admissions, 'prepared'],
            })
            if (outcome === 'rejected') throw new Error('PREPARATION_REJECTED')
            return () => {}
          },
        }
        if (outcome === 'resolved')
          f.afterSqlPreparation(async () => {
            expect(Object.isFrozen(nested)).toBe(true)
            expect(() => nested.push('late-before-commit')).toThrow()
            await expect(Promise.resolve().then(() => savedFacet.doc(FenceDoc))).rejects.toThrow(
              'PI_GUARDED_ABORT_PREPARATION_REVOKED'
            )
            await expect(
              Promise.resolve().then(() =>
                savedFacet.replaceDoc(FenceDoc, { restrictions: [], admissions: ['late'] })
              )
            ).rejects.toThrow('PI_GUARDED_ABORT_PREPARATION_REVOKED')
            lateChecked = true
          })
        if (outcome === 'resolved') await f.current.root.commitAbort(attempt, context)
        else
          await expect(f.current.root.commitAbort(attempt, context)).rejects.toThrow(
            'PREPARATION_REJECTED'
          )
        f.afterSqlPreparation(undefined)
        expect(Object.isFrozen(nested)).toBe(true)
        expect(() => nested.push('late-after-return')).toThrow()
        await expect(Promise.resolve().then(() => savedFacet.doc(FenceDoc))).rejects.toThrow(
          'PI_GUARDED_ABORT_PREPARATION_REVOKED'
        )
        await expect(
          Promise.resolve().then(() =>
            savedFacet.replaceDoc(FenceDoc, { restrictions: [], admissions: ['late'] })
          )
        ).rejects.toThrow('PI_GUARDED_ABORT_PREPARATION_REVOKED')
        if (outcome === 'resolved') {
          expect(lateChecked).toBe(true)
          expect((await f.current.harness.snapshot(FenceDoc, context)).admissions).toEqual([
            'prepared',
          ])
        } else {
          expect(await f.current.harness.snapshot(FenceDoc, context)).toBeUndefined()
          expect(await f.current.root.readAbortReceipt(attempt.requestId, context)).toBeUndefined()
          expect((await f.current.harness.inspect(context)).scheduling).toBe('paused')
        }
      })
    })

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
