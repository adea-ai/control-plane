import { expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { InteractionService } from '@control-plane/domain'
import { SqliteDurableEffectGateStore } from '@control-plane/pi-durable-adapter'
import {
  SqlitePersistenceProvider,
  SqliteToolCallRepository,
} from '@control-plane/sqlite-persistence'
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

// Crash-window proof, kept apart from the other retained approval-write proofs. The process exits
// after the tool-success record commits and before the effect gate settles. Each run is a child
// process over one persisted directory, so the exit is real and runs no cleanup. Restarts reopen
// the same SQLite and filesystem stores in this process through the same harness composition.
const child = new URL('./retained-approval-write.crash-window.child.mjs', import.meta.url).pathname
const approvalResponse = {
  interactionId,
  responseId: 'cmd_01JABCDEF0123456789ABCDEFH',
  action: 'approve',
  respondingPrincipalId: approverA,
  expectedVersion: 1,
  respondedAt: '2026-10-08T12:05:00.000Z',
}

async function withState(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-retained-crash-window-'))
  try {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    return await run(directory, f)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

// Owned-child deadline. A child still running at the deadline is stopped by this test, and the
// caller gets this diagnostic instead of an exit code.
const CHILD_DEADLINE_MS = 30_000

class ChildDeadlineError extends Error {
  constructor(scenario, deadlineMs, exit) {
    super(
      `crash-window child "${scenario}" was still running after ${deadlineMs} ms; it was stopped`
    )
    this.name = 'ChildDeadlineError'
    this.code = 'CHILD_DEADLINE_EXCEEDED'
    this.scenario = scenario
    this.exit = exit
  }
}

// Runs one owned child and returns its exit code, stderr, and last stdout line. The finally block
// stops this child only if it is still alive, then awaits its exit and output, so the caller can
// remove the directory afterwards. No other process is inspected or signalled.
async function runChild(directory, scenario, { deadlineMs = CHILD_DEADLINE_MS } = {}) {
  const spawned = Bun.spawn([process.execPath, child, directory, scenario], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = Promise.all([
    new Response(spawned.stdout).text(),
    new Response(spawned.stderr).text(),
    spawned.exited,
  ])
  const expired = Symbol('expired')
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, deadlineMs, expired)
  })
  let finished
  try {
    finished = await Promise.race([output, deadline])
  } finally {
    clearTimeout(timer)
    if (spawned.exitCode === null && spawned.signalCode === null) spawned.kill('SIGKILL')
    await output.catch(() => undefined)
  }
  if (finished === expired) {
    throw new ChildDeadlineError(scenario, deadlineMs, {
      exitCode: spawned.exitCode,
      signalCode: spawned.signalCode,
    })
  }
  const [stdout, stderr, code] = finished
  const line = stdout.trim().split('\n').at(-1)
  return { code, stderr, result: line ? JSON.parse(line) : undefined }
}

async function respond(directory, f) {
  const session = await compose(directory, f, {
    counter: { invocations: 0 },
    clock: { now: working },
  })
  try {
    return await new InteractionService(session.interactions).respond({
      ...approvalResponse,
      executionId: f.intent.executionId,
      attemptId: f.intent.attemptId,
    })
  } finally {
    session.close()
  }
}

// Restart in this process: the same composition the child uses, over the same persisted directory.
async function restart(directory, f) {
  const counter = { invocations: 0 }
  const session = await compose(directory, f, { counter, clock: { now: working } })
  try {
    const outcome = await session.runner.run(taskFor(f))
    return { outcome, invocations: counter.invocations }
  } finally {
    session.close()
  }
}

// The filesystem object store keeps a body and a conditional-write marker per object, sharing one
// digest prefix, so the distinct prefixes count the objects written.
async function objectCount(directory) {
  const names = await readdir(join(directory, 'objects')).catch(() => [])
  return new Set(names.map((name) => name.split('.')[0])).size
}

// Reads the committed tool call through the production repository, not raw SQL.
async function toolCall(directory, f) {
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    // The provider opens its connection in migrate(); the composition calls it the same way.
    await provider.migrate()
    return await new SqliteToolCallRepository(provider, f.intent.workspaceId).get(toolCallId)
  } finally {
    provider.close()
  }
}

// The gate record for the task's effect key, read through the production store.
async function gateRecord(directory, f, taskId = 'rwt_01JABCDEF0123456789ABCDEFG') {
  const key = JSON.stringify([f.intent.workspaceId, `retained-write:${taskId}`])
  const database = new DatabaseSync(join(directory, 'effect-gate.sqlite'))
  try {
    return await new SqliteDurableEffectGateStore(database).get(key)
  } finally {
    database.close()
  }
}

test(
  'crash window: an exit after the tool-success record commits and before settlement restarts with one retained outcome and no second write',
  () =>
    withState(async (directory, f) => {
      const pending = await runChild(directory, 'run')
      expect(pending.code).toBe(0)
      expect(pending.result).toMatchObject({ outcome: { state: 'awaiting_approval' } })
      await respond(directory, f)

      const crashed = await runChild(directory, 'crash-before-settlement')
      expect(crashed.code).toBe(137)
      expect(crashed.result).toBeUndefined()

      // The window, observed on disk: the write and the success record are committed, and settlement is not.
      expect(await objectCount(directory)).toBe(1)
      const call = await toolCall(directory, f)
      expect(call).toMatchObject({ toolCallId, status: 'succeeded' })
      const retained = await gateRecord(directory, f)
      expect(retained).toMatchObject({ state: 'invoking', toolCallId })
      expect(retained.effectAdmittedAt).toEqual(expect.any(String))

      // The gate never invokes an invoking effect again. Its retained outcome is the conservative
      // unknown, and it does not settle from the committed success record. That is a separate decision.
      const restarted = await restart(directory, f)
      expect(restarted).toEqual({
        outcome: {
          state: 'reconciliation_required',
          reasonCode: 'PI_EFFECT_OUTCOME_UNKNOWN',
          toolCallId,
        },
        invocations: 0,
      })
      expect(await objectCount(directory)).toBe(1)
      expect(await gateRecord(directory, f)).toEqual(retained)
      expect(await toolCall(directory, f)).toEqual(call)

      // Replays return the same single retained outcome and never write again.
      expect(await restart(directory, f)).toEqual(restarted)
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
      expect(error.exit).toEqual({ exitCode: null, signalCode: 'SIGKILL' })
    }),
  30_000
)
