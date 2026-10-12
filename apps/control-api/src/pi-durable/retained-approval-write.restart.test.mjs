import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { InteractionService } from '@control-plane/domain'
import { SqliteDurableEffectGateStore } from '@control-plane/pi-durable-adapter'
import {
  ChildCleanupError,
  ChildDeadlineError,
  ownedChildRunner,
  registerFakeOwnedChild,
  UNCONFIRMED,
  unsettledOwnedChildren,
  withOwnedChildState,
} from './retained-approval-write.owned-child.mjs'
import {
  approverA,
  compose,
  interactionId,
  taskFor,
  working,
} from './retained-approval-write.harness.mjs'

// Restart proofs: each step runs in its own child process against the same persisted
// directory. A crash is a real process exit with no cleanup. Children are owned:
// the shared runner bounds every wait, stops a child past its deadline through
// this handle, and the state directory is removed only once every exit is
// confirmed — an unconfirmed exit preserves the directory behind its marker and
// retains the body's original failure as the cleanup error's cause.
const child = new URL('./retained-approval-write.child.mjs', import.meta.url).pathname
const runChild = ownedChildRunner(child)
const approvalResponse = {
  interactionId,
  executionId: undefined,
  attemptId: undefined,
  responseId: 'cmd_01JABCDEF0123456789ABCDEFH',
  action: 'approve',
  respondingPrincipalId: approverA,
  expectedVersion: 1,
  respondedAt: '2026-10-08T12:05:00.000Z',
}

function withState(run) {
  return withOwnedChildState(run, { prefix: 'pi-retained-restart-' })
}

async function respond(directory, f, overrides = {}) {
  const session = await compose(directory, f, {
    counter: { invocations: 0 },
    clock: { now: working },
  })
  try {
    return await new InteractionService(session.interactions).respond({
      ...approvalResponse,
      executionId: f.intent.executionId,
      attemptId: f.intent.attemptId,
      ...overrides,
    })
  } finally {
    session.close()
  }
}

// The filesystem object store keeps a body and a conditional-write marker per object, sharing one digest prefix.
async function objectCount(directory) {
  const names = await readdir(join(directory, 'objects')).catch(() => [])
  return new Set(names.map((name) => name.split('.')[0])).size
}

function gateRecord(directory, f, taskId = 'rwt_01JABCDEF0123456789ABCDEFG') {
  const key = JSON.stringify([f.intent.workspaceId, `retained-write:${taskId}`])
  const database = new DatabaseSync(join(directory, 'effect-gate.sqlite'))
  return new SqliteDurableEffectGateStore(database).get(key).finally(() => database.close())
}

test(
  'approval boundary: an approval pending across process exit settles once after a later response',
  () =>
    withState(async (directory, f) => {
      const pending = await runChild(directory, 'run')
      expect(pending.code).toBe(0)
      expect(pending.result).toMatchObject({
        outcome: { state: 'awaiting_approval' },
        invocations: 0,
      })

      await respond(directory, f)
      const settled = await runChild(directory, 'run')
      expect(settled.result).toMatchObject({ outcome: { state: 'succeeded' }, invocations: 1 })

      const replayed = await runChild(directory, 'run')
      expect(replayed.result).toEqual({ outcome: settled.result.outcome, invocations: 0 })
      expect(await objectCount(directory)).toBe(1)
    }),
  120_000
)

test(
  'write boundary: a crash after the object write reconciles after restart without a second write',
  () =>
    withState(async (directory, f) => {
      await runChild(directory, 'run')
      await respond(directory, f)

      const crashed = await runChild(directory, 'crash-after-write')
      expect(crashed.code).toBe(137)
      expect(crashed.result).toBeUndefined()
      expect(await objectCount(directory)).toBe(1)

      const restarted = await runChild(directory, 'run')
      expect(restarted.result).toMatchObject({
        outcome: { state: 'reconciliation_required' },
        invocations: 0,
      })
      const again = await runChild(directory, 'run')
      expect(again.result).toEqual(restarted.result)
      expect(await objectCount(directory)).toBe(1)
    }),
  120_000
)

test(
  'receipt boundary: a settled receipt survives restart and later revoked authority denies replay without re-execution',
  () =>
    withState(async (directory, f) => {
      await runChild(directory, 'run')
      await respond(directory, f)
      const settled = await runChild(directory, 'run')
      expect(settled.result).toMatchObject({ outcome: { state: 'succeeded' } })
      const before = await gateRecord(directory, f)

      // Revocation of an approved request: the real store writes the cancelled state with no response.
      const session = await compose(directory, f, {
        counter: { invocations: 0 },
        clock: { now: working },
      })
      try {
        const approved = await session.interactions.get(interactionId)
        const { response: _response, ...unanswered } = approved
        expect(
          await session.interactions.compareAndSet(approved.version, {
            ...unanswered,
            state: 'cancelled',
            version: approved.version + 1,
            resolvedAt: working,
          })
        ).toBe(true)
      } finally {
        session.close()
      }

      const replay = await runChild(directory, 'run')
      expect(replay.result).toMatchObject({ error: 'PI_EFFECT_AUTHORITY_REJECTED', invocations: 0 })
      expect(await objectCount(directory)).toBe(1)
      expect(await gateRecord(directory, f)).toEqual(before)
    }),
  120_000
)

test(
  'duplicate delivery: a repeated approval response is idempotent and a conflicting one is rejected',
  () =>
    withState(async (directory, f) => {
      await runChild(directory, 'run')
      await respond(directory, f)
      await expect(respond(directory, f)).resolves.toMatchObject({ state: 'responded' })
      await expect(
        respond(directory, f, { responseId: 'cmd_01JABCDEF0123456789ABCDEFJ', action: 'deny' })
      ).rejects.toMatchObject({ code: 'INTERACTION_RESPONSE_CONFLICT' })

      const settled = await runChild(directory, 'run')
      expect(settled.result).toMatchObject({ outcome: { state: 'succeeded' }, invocations: 1 })
      expect(await objectCount(directory)).toBe(1)
    }),
  120_000
)

test(
  'immutable pins: a restarted task with a changed audience or approval expiry conflicts without a write',
  () =>
    withState(async (directory, f) => {
      await runChild(directory, 'run')
      await respond(directory, f)
      expect((await runChild(directory, 'run')).result).toMatchObject({
        outcome: { state: 'succeeded' },
      })

      const session = await compose(directory, f, {
        counter: { invocations: 0 },
        clock: { now: working },
      })
      try {
        const audience = taskFor(f)
        audience.request.approval.allowedPrincipalIds = [
          'user:22222222-2222-4222-8222-222222222222',
        ]
        await expect(session.runner.run(audience)).rejects.toMatchObject({
          code: 'PI_EFFECT_IDENTITY_CONFLICT',
        })

        const expiry = taskFor(f)
        expiry.request.approval.expiresAt = '2026-10-08T12:45:00.000Z'
        await expect(session.runner.run(expiry)).rejects.toMatchObject({
          code: 'PI_EFFECT_IDENTITY_CONFLICT',
        })
      } finally {
        session.close()
      }
      expect(await objectCount(directory)).toBe(1)
    }),
  120_000
)

test(
  'an owned child that outlives its deadline is stopped and reported as a deadline error, never as an exit code',
  () =>
    withState(async (directory) => {
      const error = await runChild(directory, 'hang', { deadlineMs: 500 }).then(
        () => undefined,
        (caught) => caught
      )
      expect(error).toBeInstanceOf(ChildDeadlineError)
      expect(error).toMatchObject({ code: 'CHILD_DEADLINE_EXCEEDED', scenario: 'hang' })
      // Stopped by signal and awaited before the helper threw: no exit code was produced.
      expect(error.exit).toMatchObject({ exitCode: null, signalCode: 'SIGKILL' })
    }),
  30_000
)

test('an early failure waits for its still-running owned sibling before the state directory is removed', async () => {
  let directory
  const caught = await withOwnedChildState(async (stateDirectory) => {
    directory = stateDirectory
    const early = runChild(stateDirectory, 'hang', { deadlineMs: 500 })
    // The sibling keeps running long after the early failure settles — the
    // shape Promise.all over several children produces when one loses first.
    runChild(stateDirectory, 'hang', { deadlineMs: 3000 })
    const failure = await early.then(
      () => undefined,
      (caughtError) => caughtError
    )
    expect(failure).toBeInstanceOf(ChildDeadlineError)
    // Promise.all semantics: the body settles with the first failure while
    // the sibling is still owned and running.
    throw failure
  }).then(
    () => undefined,
    (caughtError) => caughtError
  )

  // The body's original failure is what surfaces, after cleanup waited for
  // the sibling to settle: nothing owned is left unsettled, and the state
  // directory was removed only once every exit was confirmed.
  expect(caught).toBeInstanceOf(ChildDeadlineError)
  expect(caught).toMatchObject({ code: 'CHILD_DEADLINE_EXCEEDED', scenario: 'hang' })
  expect(unsettledOwnedChildren(directory)).toBe(0)
  await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' })
}, 30_000)

test('a sibling still unsettled beyond the cleanup window preserves the directory and retains the body failure as its cause', async () => {
  let directory
  let fake
  const bodyFailure = new Error('BODY_FAILURE_BEFORE_CLEANUP')
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  let released = false
  try {
    const caught = await withOwnedChildState(
      (stateDirectory) => {
        directory = stateDirectory
        // A tracked child whose runner never settles inside the (shortened)
        // cleanup window: the shape a surviving sibling produces after an
        // early body failure. No process and no timer are involved.
        fake = registerFakeOwnedChild(stateDirectory)
        throw bodyFailure
      },
      { prefix: 'pi-retained-owned-unsettled-', cleanupWaitMs: 150 }
    ).then(
      () => undefined,
      (caughtError) => caughtError
    )

    // The unsettled-sibling branch exactly: directory preserved, the body's
    // original failure retained as the cause, and not the unconfirmed-exit
    // marker path.
    expect(caught).toBeInstanceOf(ChildCleanupError)
    expect(caught.code).toBe('CHILD_CLEANUP_UNCONFIRMED')
    expect(caught.cause).toBe(bodyFailure)
    expect(caught.scenario).toContain('unsettled')
    expect(existsSync(join(directory, 'state.sqlite'))).toBe(true)
    expect(existsSync(join(directory, UNCONFIRMED))).toBe(false)

    // Release the fake exactly as a real sibling fails after the body settled,
    // and prove the rejection is observed rather than escaping unhandled.
    process.on('unhandledRejection', onUnhandled)
    released = true
    fake.settle(new Error('LATE_SIBLING_REJECTION'))
    await fake.done
    // One macrotask turn for any late rejection to surface if it would.
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    process.off('unhandledRejection', onUnhandled)
    if (!released) fake?.settle(new Error('TEST_FAKE_RELEASED_UNOBSERVED'))
    if (fake) await fake.done
    // The test owns the preserved directory and leaves nothing live behind.
    if (directory) await rm(directory, { recursive: true, force: true })
  }
  expect(unhandled).toEqual([])
  expect(unsettledOwnedChildren(directory)).toBe(0)
}, 30_000)

test(
  'one logical settlement: concurrent restarted processes for one approved task execute and settle once',
  () =>
    withState(async (directory, f) => {
      await runChild(directory, 'run')
      await respond(directory, f)

      const results = await Promise.all([1, 2, 3].map(() => runChild(directory, 'run')))
      // Exactly one process executes the write. A duplicate that arrives while that effect is in
      // flight sees the invocation barrier and reports reconciliation without writing. A later
      // duplicate reads the retained receipt. Lost races may also see a store conflict.
      const executed = results.filter((r) => r.result?.invocations === 1)
      expect(executed).toHaveLength(1)
      expect(executed[0].result.outcome).toMatchObject({ state: 'succeeded' })
      for (const r of results) {
        if (r.result?.outcome) {
          expect(['succeeded', 'reconciliation_required']).toContain(r.result.outcome.state)
          if (r.result.outcome.state === 'reconciliation_required')
            expect(r.result.invocations).toBe(0)
        } else {
          expect(r.result.error).toBe('PI_EFFECT_STORE_CONFLICT')
          expect(r.result.invocations).toBe(0)
        }
      }
      const settled = await runChild(directory, 'run')
      expect(settled.result).toEqual({ outcome: executed[0].result.outcome, invocations: 0 })
      expect(await objectCount(directory)).toBe(1)
    }),
  120_000
)
