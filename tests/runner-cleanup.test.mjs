// Portable extraction of the unique published #1048 runner cleanup proof at
// e635101384587b6d9e66dd6d1dbfb0eec8666883. No legacy Restate/LangGraph bootstrap,
// provider calls, external database or PID lookup. Original historical tests are preserved.
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'bun:test'
import { createCleanupRunner, installSignalCleanup } from './fixtures/runner-cleanup.mjs'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const EXIT_BOUND_MS = 15_000
const delayMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const cleanup = []
const runCleanup = createCleanupRunner(cleanup, 'portable runner test cleanup')
afterEach(runCleanup)

function processExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

async function boundedWait(work, milliseconds, label) {
  let timer
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('runner cleanup shared by afterEach and signals', () => {
  function heldCleanup() {
    const events = []
    const queue = []
    let release
    const held = new Promise((resolve) => {
      release = resolve
    })
    queue.push(async () => {
      events.push('held-start')
      await held
      events.push('held-done')
    })
    return { events, queue, release }
  }
  const signals = [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ]

  test('a signal during an in-flight afterEach cleanup waits for it before exiting', async () => {
    const { events, queue, release } = heldCleanup()
    const run = createCleanupRunner(queue, 'test cleanup')
    const target = new EventEmitter()
    const exits = []
    installSignalCleanup({
      run,
      signals,
      target,
      exit: (status) => exits.push(status),
    })

    const afterEachRun = run()
    await delayMs(20)
    expect(events).toEqual(['held-start'])
    // The queue is already taken: a runner that drained it only once would see nothing left.
    expect(queue).toEqual([])

    target.emit('SIGTERM')
    target.emit('SIGINT')
    await delayMs(50)
    expect(exits).toEqual([])

    release()
    await afterEachRun
    await delayMs(20)
    expect(events).toEqual(['held-start', 'held-done'])
    expect(exits.toSorted()).toEqual([130, 143])
    // Cleanup ran once, not once per delivery.
    expect(events.filter((event) => event === 'held-start')).toHaveLength(1)
  })

  test('cleanup registered while another cleanup runs is still run, and failures do not stop later callbacks', async () => {
    const queue = []
    const events = []
    const run = createCleanupRunner(queue, 'test cleanup')
    queue.push(async () => {
      events.push('first')
      queue.push(async () => {
        events.push('registered-late')
      })
      throw new Error('first failed')
    })
    queue.push(async () => {
      events.push('second')
    })
    const outcome = await run().catch((error) => error)
    expect(outcome).toBeInstanceOf(AggregateError)
    expect(outcome.message).toBe('test cleanup')
    expect(outcome.errors.map((error) => error.message)).toEqual(['first failed'])
    expect(events).toEqual(['first', 'second', 'registered-late'])
  })

  describe('with real process signals', () => {
    const childPath = join(repositoryRoot, 'tests/fixtures/runner-cleanup-signal.child.mjs')

    async function startCleanupChild(mode) {
      const work = await mkdtemp(join(tmpdir(), 'runner-cleanup-signal-'))
      const releasePath = join(work, 'release')
      const markerPath = join(work, 'markers')
      const child = spawn(process.execPath, [childPath, releasePath, markerPath, mode], {
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      const exited = processExit(child)
      cleanup.push(async () => {
        // Handle-only: the child belongs to this test and is ended through its ChildProcess.
        try {
          await writeFile(releasePath, 'release')
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
          await boundedWait(exited, EXIT_BOUND_MS, 'cleanup signal child teardown')
        } catch (error) {
          throw new Error(`Cleanup unconfirmed; retained ${work}`, { cause: error })
        }
        await rm(work, { recursive: true, force: true })
      })
      let output = ''
      child.stdout.setEncoding('utf8')
      const ready = new Promise((resolve) => {
        child.stdout.on('data', (chunk) => {
          output += chunk
          if (output.includes('ready')) resolve()
        })
      })
      await boundedWait(ready, EXIT_BOUND_MS, 'cleanup signal child ready')
      const markers = async () =>
        existsSync(markerPath) ? (await readFile(markerPath, 'utf8')).trim().split('\n') : []
      return { child, exited, releasePath, markers }
    }

    for (const [signal, status] of [
      ['SIGTERM', 143],
      ['SIGINT', 130],
      ['SIGHUP', 129],
    ]) {
      for (const mode of ['in-flight', 'idle']) {
        test(`${signal} during ${mode} cleanup holds the process until cleanup finishes, then exits ${status}`, async () => {
          const { child, exited, releasePath, markers } = await startCleanupChild(mode)
          expect(child.kill(signal)).toBe(true)

          // The cleanup callback is held. The process must still be alive while it runs, and
          // must have started it exactly once.
          for (let attempt = 0; attempt < 200; attempt += 1) {
            if ((await markers()).includes('cleanup-start')) break
            await delayMs(10)
          }
          await delayMs(300)
          expect(child.exitCode).toBeNull()
          expect(child.signalCode).toBeNull()
          expect(await markers()).toEqual(['cleanup-start'])

          await writeFile(releasePath, 'release')
          expect(await boundedWait(exited, EXIT_BOUND_MS, 'cleanup signal child exit')).toEqual({
            code: status,
            signal: null,
          })
          expect(await markers()).toEqual(['cleanup-start', 'cleanup-done', `exit:${status}`])
        })
      }
    }

    test('a second, different signal while cleanup is held neither exits early nor repeats cleanup', async () => {
      const { child, exited, releasePath, markers } = await startCleanupChild('in-flight')
      expect(child.kill('SIGTERM')).toBe(true)
      expect(child.kill('SIGHUP')).toBe(true)
      await delayMs(300)
      expect(child.exitCode).toBeNull()
      expect(await markers()).toEqual(['cleanup-start'])
      await writeFile(releasePath, 'release')
      const exit = await boundedWait(exited, EXIT_BOUND_MS, 'cleanup signal child exit')
      // Whichever signal's listener finishes first decides the status; both are signal statuses.
      expect([143, 129]).toContain(exit.code)
      expect(exit.signal).toBeNull()
      const finalMarkers = await markers()
      expect(finalMarkers.slice(0, 2)).toEqual(['cleanup-start', 'cleanup-done'])
      expect(finalMarkers.filter((line) => line === 'cleanup-start')).toHaveLength(1)
    })
  })

  test('a signal exits with its status after a failed cleanup and reports it', async () => {
    const queue = [
      async () => {
        throw new Error('stuck owner')
      },
    ]
    const target = new EventEmitter()
    const exits = []
    const reports = []
    installSignalCleanup({
      run: createCleanupRunner(queue, 'test cleanup'),
      signals,
      target,
      exit: (status) => exits.push(status),
      report: (message) => reports.push(message),
    })
    target.emit('SIGHUP')
    await delayMs(30)
    expect(exits).toEqual([129])
    expect(reports).toEqual(['runner SIGHUP cleanup incomplete: test cleanup'])
  })
})
