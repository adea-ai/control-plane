import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InteractionService } from '@control-plane/domain'
import { fixture } from '../models/canonical-model-host-fixtures.mjs'
import {
  approverA,
  compose,
  interactionId,
  seedDatabase,
  taskFor,
  toolCallId,
  working,
} from './retained-approval-write.harness.mjs'

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-retained-approval-write-'))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('approval gates the authorized write, settles once, and replays after physical reopen without a second write', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0 }
    const clock = { now: working }
    const first = await compose(directory, f, { counter, clock })
    const task = taskFor(f)
    const pending = await first.runner.run(task)
    expect(pending).toMatchObject({ state: 'awaiting_approval' })
    expect(counter.invocations).toBe(0)

    await new InteractionService(first.interactions).respond({
      interactionId,
      executionId: f.intent.executionId,
      attemptId: f.intent.attemptId,
      responseId: 'cmd_01JABCDEF0123456789ABCDEFH',
      action: 'approve',
      respondingPrincipalId: approverA,
      expectedVersion: 1,
      respondedAt: '2026-10-08T12:05:00.000Z',
    })
    const settled = await first.runner.run(task)
    expect(settled).toMatchObject({ state: 'succeeded', call: { toolCallId } })
    expect(counter.invocations).toBe(1)
    first.close()

    const reopened = await compose(directory, f, { counter, clock })
    try {
      await expect(reopened.runner.run(task)).resolves.toEqual(settled)
      expect(counter.invocations).toBe(1)
    } finally {
      reopened.close()
    }
  })
})

test('a revoked approval cannot authorize the write', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0 }
    const clock = { now: working }
    const session = await compose(directory, f, { counter, clock })
    try {
      await session.runner.run(taskFor(f))
      await new InteractionService(session.interactions).resolveTerminal(interactionId, working)
      await expect(session.runner.run(taskFor(f))).rejects.toMatchObject({
        code: 'PI_EFFECT_AUTHORITY_REJECTED',
      })
      expect(counter.invocations).toBe(0)
    } finally {
      session.close()
    }
  })
})

test('changed pins after restart conflict with the retained effect instead of creating a second write', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0 }
    const clock = { now: working }
    const first = await compose(directory, f, { counter, clock })
    await first.runner.run(taskFor(f))
    await new InteractionService(first.interactions).respond({
      interactionId,
      executionId: f.intent.executionId,
      attemptId: f.intent.attemptId,
      responseId: 'cmd_01JABCDEF0123456789ABCDEFH',
      action: 'approve',
      respondingPrincipalId: approverA,
      expectedVersion: 1,
      respondedAt: '2026-10-08T12:05:00.000Z',
    })
    await first.runner.run(taskFor(f))
    expect(counter.invocations).toBe(1)
    first.close()

    const reopened = await compose(directory, f, { counter, clock })
    try {
      const changed = taskFor(f, { input: { headline: 'Changed after approval', labels: [] } })
      await expect(reopened.runner.run(changed)).rejects.toMatchObject({
        code: 'PI_EFFECT_IDENTITY_CONFLICT',
      })
      expect(counter.invocations).toBe(1)
    } finally {
      reopened.close()
    }
  })
})

test('a task pinned to a tool version the registry does not hold is denied before any write', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0 }
    const clock = { now: working }
    const session = await compose(directory, f, { counter, clock })
    try {
      const task = taskFor(f, {
        taskId: 'rwt_01JABCDEF0123456789ABCDEFH',
        version: 'tlv_01JABCDEF0123456789ABCDEFZ',
      })
      // The approval request is created first; admission then rejects the stale tool pin, before and after approval.
      await expect(session.runner.run(task)).rejects.toMatchObject({
        code: 'PI_EFFECT_AUTHORITY_REJECTED',
      })
      await new InteractionService(session.interactions).respond({
        interactionId,
        executionId: f.intent.executionId,
        attemptId: f.intent.attemptId,
        responseId: 'cmd_01JABCDEF0123456789ABCDEFH',
        action: 'approve',
        respondingPrincipalId: approverA,
        expectedVersion: 1,
        respondedAt: '2026-10-08T12:05:00.000Z',
      })
      await expect(session.runner.run(task)).rejects.toMatchObject({
        code: 'PI_EFFECT_AUTHORITY_REJECTED',
      })
      expect(counter.invocations).toBe(0)
    } finally {
      session.close()
    }
  })
})

test('concurrent runs of one approved task settle once', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0 }
    const clock = { now: working }
    const session = await compose(directory, f, { counter, clock })
    try {
      const task = taskFor(f)
      await session.runner.run(task)
      await new InteractionService(session.interactions).respond({
        interactionId,
        executionId: f.intent.executionId,
        attemptId: f.intent.attemptId,
        responseId: 'cmd_01JABCDEF0123456789ABCDEFH',
        action: 'approve',
        respondingPrincipalId: approverA,
        expectedVersion: 1,
        respondedAt: '2026-10-08T12:05:00.000Z',
      })
      const results = await Promise.allSettled([1, 2, 3].map(() => session.runner.run(task)))
      const fulfilled = results
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value)
      expect(fulfilled.length).toBeGreaterThanOrEqual(1)
      for (const outcome of fulfilled) expect(outcome).toEqual(fulfilled[0])
      expect(fulfilled[0]).toMatchObject({ state: 'succeeded' })
      expect(counter.invocations).toBe(1)
    } finally {
      session.close()
    }
  })
})

test('an uncertain write settles once as reconciliation and is never retried after reopen', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0, failNext: true }
    const clock = { now: working }
    const first = await compose(directory, f, { counter, clock })
    const task = taskFor(f, { taskId: 'rwt_01JABCDEF0123456789ABCDEFI' })
    await first.runner.run(task)
    await new InteractionService(first.interactions).respond({
      interactionId,
      executionId: f.intent.executionId,
      attemptId: f.intent.attemptId,
      responseId: 'cmd_01JABCDEF0123456789ABCDEFH',
      action: 'approve',
      respondingPrincipalId: approverA,
      expectedVersion: 1,
      respondedAt: '2026-10-08T12:05:00.000Z',
    })
    const uncertain = await first.runner.run(task)
    expect(uncertain).toMatchObject({ state: 'reconciliation_required' })
    expect(counter.invocations).toBe(1)
    first.close()

    const reopened = await compose(directory, f, { counter, clock })
    try {
      await expect(reopened.runner.run(task)).resolves.toEqual(uncertain)
      expect(counter.invocations).toBe(1)
    } finally {
      reopened.close()
    }
  })
})
