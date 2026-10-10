import { expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { InteractionService } from '@control-plane/domain'
import { SqliteDurableEffectGateStore } from '@control-plane/pi-durable-adapter'
import { fixture } from '../models/canonical-model-host-fixtures.mjs'
import {
  approverA,
  compose,
  interactionId,
  seedDatabase,
  taskFor,
  working,
} from './retained-approval-write.harness.mjs'

// Restart proofs: each step runs in its own child process against the same persisted
// directory. A crash is a real process exit with no cleanup.
const child = new URL('./retained-approval-write.child.mjs', import.meta.url).pathname
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

async function withState(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-retained-restart-'))
  try {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    return await run(directory, f)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function runChild(directory, scenario) {
  const spawned = Bun.spawn([process.execPath, child, directory, scenario], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(spawned.stdout).text(),
    new Response(spawned.stderr).text(),
    spawned.exited,
  ])
  const line = stdout.trim().split('\n').at(-1)
  return { code, stderr, result: line ? JSON.parse(line) : undefined }
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
