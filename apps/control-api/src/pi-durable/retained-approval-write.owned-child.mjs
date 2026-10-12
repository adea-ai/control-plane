// Owned-child bounds shared by the retained approval-write process proofs. A
// child still running at the deadline is stopped through its own handle, and
// every cleanup wait is bounded by CHILD_CLEANUP_MS. When an owned child's exit
// cannot be confirmed, the state directory is preserved behind the UNCONFIRMED
// marker so evidence survives for inspection, and the body's original failure
// is retained as the cleanup error's cause.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture } from '../models/canonical-model-host-fixtures.mjs'
import { seedDatabase } from './retained-approval-write.harness.mjs'

export const CHILD_DEADLINE_MS = 30_000
export const CHILD_CLEANUP_MS = 10_000
// Written into a state directory when an owned child's exit could not be confirmed.
export const UNCONFIRMED = 'owned-child-unconfirmed.json'

// Settles to the promise's outcome, or to { state: 'pending' } once ms elapse. It never rejects and
// clears its timer, so a timed-out wait leaves no dangling timer behind.
export function settledWithin(promise, ms) {
  let timer
  const pending = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, { state: 'pending' })
  })
  const settled = promise.then(
    (value) => ({ state: 'fulfilled', value }),
    (reason) => ({ state: 'rejected', reason })
  )
  return Promise.race([settled, pending]).finally(() => clearTimeout(timer))
}

export class ChildDeadlineError extends Error {
  constructor(scenario, deadlineMs, exit) {
    super(`owned child "${scenario}" was still running after ${deadlineMs} ms; it was stopped`)
    this.name = 'ChildDeadlineError'
    this.code = 'CHILD_DEADLINE_EXCEEDED'
    this.scenario = scenario
    this.exit = exit
  }
}

export class ChildCleanupError extends Error {
  constructor(directory, { scenario, cleanupMs }, options) {
    super(
      `owned child "${scenario}" was not confirmed exited within ${cleanupMs} ms after SIGKILL; its state directory is preserved at ${directory}`,
      options
    )
    this.name = 'ChildCleanupError'
    this.code = 'CHILD_CLEANUP_UNCONFIRMED'
    this.directory = directory
    this.scenario = scenario
  }
}

/**
 * Binds one child script to the owned-child bounds. The returned runner spawns
 * `[process.execPath, childPath, directory, scenario]` and is stopped through
 * this handle only, and only while it is alive. Every spawned child is tracked
 * per state directory until its runner settles.
 */
export function ownedChildRunner(childPath) {
  return function runChild(
    directory,
    scenario,
    {
      deadlineMs = CHILD_DEADLINE_MS,
      cleanupMs = CHILD_CLEANUP_MS,
      launch = (command, options) => Bun.spawn(command, options),
    } = {}
  ) {
    const settlement = (async () => {
      const spawned = launch([process.execPath, childPath, directory, scenario], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const output = Promise.all([
        new Response(spawned.stdout).text(),
        new Response(spawned.stderr).text(),
        spawned.exited,
      ])
      const first = await settledWithin(output, deadlineMs)
      if (first.state === 'fulfilled') {
        const [stdout, stderr, code] = first.value
        const line = stdout.trim().split('\n').at(-1)
        return { code, stderr, result: line ? JSON.parse(line) : undefined }
      }
      if (spawned.exitCode === null && spawned.signalCode === null) spawned.kill('SIGKILL')
      const exit = await settledWithin(spawned.exited, cleanupMs)
      if (exit.state !== 'fulfilled') {
        await writeFile(
          join(directory, UNCONFIRMED),
          JSON.stringify({ scenario, deadlineMs, cleanupMs })
        )
        throw new ChildCleanupError(
          directory,
          { scenario, cleanupMs },
          first.state === 'rejected' ? { cause: first.reason } : undefined
        )
      }
      const drained = await settledWithin(output, cleanupMs)
      if (first.state === 'rejected') throw first.reason
      throw new ChildDeadlineError(scenario, deadlineMs, {
        exitCode: spawned.exitCode,
        signalCode: spawned.signalCode,
        outputDrained: drained.state === 'fulfilled',
      })
    })()
    trackOwnedChild(directory, settlement)
    return settlement
  }
}

// Owned children per state directory, tracked from spawn until their runner
// settles. A body that settles early (Promise.all over several children rejects
// on the first failure) leaves its siblings tracked here.
const ownedChildren = new Map()

function trackOwnedChild(directory, settlement) {
  let tracked = ownedChildren.get(directory)
  if (!tracked) {
    tracked = new Set()
    ownedChildren.set(directory, tracked)
  }
  const record = {
    settled: settlement.then(
      () => {},
      () => {}
    ),
  }
  tracked.add(record)
  record.settled.then(() => {
    tracked.delete(record)
    if (tracked.size === 0) ownedChildren.delete(directory)
  })
}

/** Number of owned children of one state directory whose runner has not settled yet. */
export function unsettledOwnedChildren(directory) {
  return ownedChildren.get(directory)?.size ?? 0
}

/**
 * Test-only: tracks a fake owned child for one state directory without
 * spawning a process. The returned handle settles the fake explicitly, so a
 * test can release it and leave nothing tracked or pending behind.
 */
export function registerFakeOwnedChild(directory) {
  let release
  const settlement = new Promise((_resolve, reject) => {
    release = reject
  })
  trackOwnedChild(directory, settlement)
  return {
    settle: (reason) => release(reason),
    done: settlement.then(
      () => 'fulfilled',
      () => 'rejected'
    ),
  }
}

/**
 * Waits, bounded by cleanupMs, for every owned child of the directory to settle.
 * A body that settles early — Promise.all over several children rejects on the
 * first failure — leaves its siblings running; cleanup must not start until
 * they are done.
 */
export async function awaitSettledOwnedChildren(directory, cleanupMs = CHILD_CLEANUP_MS) {
  const tracked = ownedChildren.get(directory)
  if (!tracked || tracked.size === 0) return
  await settledWithin(Promise.allSettled([...tracked].map((record) => record.settled)), cleanupMs)
}

/**
 * Runs one test body over a fresh seeded state directory. The directory is
 * removed only after the body has settled AND every owned child — including
 * siblings still running after an early body failure — has settled or
 * confirmed its exit; otherwise it is kept for inspection and
 * ChildCleanupError is thrown even if the body swallowed the failure,
 * retaining the body's original error as the cause.
 */
export async function withOwnedChildState(
  run,
  { prefix = 'pi-retained-owned-child-', cleanupWaitMs = CHILD_CLEANUP_MS } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  let failure
  let value
  try {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    value = await run(directory, f)
  } catch (error) {
    failure = { error }
  }
  await awaitSettledOwnedChildren(directory, cleanupWaitMs)
  const stillRunning = unsettledOwnedChildren(directory)
  const unconfirmed = await readFile(join(directory, UNCONFIRMED), 'utf8').then(
    (text) => JSON.parse(text),
    () => undefined
  )
  if (unconfirmed || stillRunning > 0) {
    if (failure?.error instanceof ChildCleanupError) throw failure.error
    throw new ChildCleanupError(
      directory,
      unconfirmed ?? {
        scenario: `${stillRunning} owned child(ren) unsettled after cleanup wait`,
        cleanupMs: cleanupWaitMs,
      },
      failure && { cause: failure.error }
    )
  }
  await rm(directory, { recursive: true, force: true })
  if (failure) throw failure.error
  return value
}
