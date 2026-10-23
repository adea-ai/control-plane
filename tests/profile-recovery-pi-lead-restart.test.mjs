// M17.02.2 (#1025): Pi lead composition crash/restart proof through the production startup path.
// A child process admits one run and holds its scripted model turn open. The parent SIGKILLs that
// process, reaps it, and a second child opens the same directory. Construction must adopt the
// retained run without resending or admitting anything new. Loopback only; no provider or live resource.
import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boundedWait, stopChild } from './fixtures/self-hosted-simple-sigkill.mjs'
import { openRestartComposition } from './fixtures/pi-lead-restart/composition.mjs'

const hostPath = new URL('./fixtures/pi-lead-restart/host.mjs', import.meta.url).pathname
const CHILD_EXIT_BOUND_MS = 10_000
const STREAM_CANCEL_BOUND_MS = 1_000
const STDERR_READ_BOUND_MS = 500
const STDERR_MAX_CHARS = 16_384

function spawnHost(mode, directory) {
  return Bun.spawn([process.execPath, hostPath, mode, directory], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

async function closeStreamReader(reader, label) {
  const failures = []
  let cancellation
  try {
    cancellation = reader.cancel()
  } catch (error) {
    failures.push(error)
  }
  if (cancellation) {
    cancellation.catch(() => {})
    try {
      await boundedWait(cancellation, STREAM_CANCEL_BOUND_MS, `HOST_STREAM_CANCEL:${label}`)
    } catch (error) {
      failures.push(error)
    }
  }
  try {
    reader.releaseLock()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length > 0) throw new AggregateError(failures, `HOST_STREAM_CLEANUP_FAILED:${label}`)
}

async function readBoundedStderr(stream, timeoutMs) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + timeoutMs
  let text = ''
  let note
  let primaryFailure
  let failed = false
  try {
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        note = '[stderr read timed out]'
        break
      }
      let next
      try {
        next = await boundedWait(reader.read(), remaining, 'HOST_STDERR_READ')
      } catch (error) {
        if (error.message?.startsWith('BOUNDED_WAIT_TIMEOUT:HOST_STDERR_READ')) {
          note = '[stderr read timed out]'
          break
        }
        throw error
      }
      if (next.done) break
      text += decoder.decode(next.value, { stream: true })
      if (text.length >= STDERR_MAX_CHARS) {
        text = `${text.slice(0, STDERR_MAX_CHARS)}…`
        note = '[stderr output truncated]'
        break
      }
    }
    text += decoder.decode()
  } catch (error) {
    failed = true
    primaryFailure = error
  }
  let cleanupFailure
  try {
    await closeStreamReader(reader, 'stderr')
  } catch (error) {
    cleanupFailure = error
  }
  if (failed && cleanupFailure)
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      'HOST_STDERR_READ_AND_CLEANUP_FAILED',
      {
        cause: primaryFailure,
      }
    )
  if (failed) throw primaryFailure
  if (cleanupFailure) throw cleanupFailure
  return [text.trim(), note].filter(Boolean).join('\n')
}

// Reads complete newline-delimited records; bounds and closes both child pipe readers.
async function readLabelled(
  child,
  label,
  timeoutMs = 60_000,
  stderrTimeoutMs = STDERR_READ_BOUND_MS
) {
  const decoder = new TextDecoder()
  const reader = child.stdout.getReader()
  const deadline = Date.now() + timeoutMs
  let buffer = ''
  let result
  let found = false
  let primaryFailure
  let failed = false
  let stderrCaptured = false
  let childExitObserved = false
  let childExitStatus
  const childExit = child.exited.then(
    (status) => {
      childExitObserved = true
      childExitStatus = { status }
    },
    (error) => {
      childExitObserved = true
      childExitStatus = { error }
    }
  )
  const readStderr = async () => {
    stderrCaptured = true
    try {
      return await readBoundedStderr(child.stderr, stderrTimeoutMs)
    } catch (error) {
      return `[stderr capture failed: ${error.message}]`
    }
  }
  try {
    for (;;) {
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith(`${label} `)) continue
        result = JSON.parse(line.slice(label.length + 1))
        found = true
        break
      }
      if (found) break
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`HOST_TIMEOUT:${label}`)
      const next = await boundedWait(reader.read(), remaining, `HOST_TIMEOUT:${label}`)
      if (next.done) {
        const exitRemaining = deadline - Date.now()
        if (!childExitObserved) {
          if (exitRemaining <= 0) throw new Error(`HOST_TIMEOUT:${label}`)
          await boundedWait(childExit, exitRemaining, `HOST_EXIT:${label}`)
        }
        if (childExitStatus?.error) throw childExitStatus.error
        throw new Error(`HOST_EXITED_BEFORE:${label}:${await readStderr()}`)
      }
      buffer += decoder.decode(next.value, { stream: true })
    }
  } catch (error) {
    failed = true
    primaryFailure = error
  }
  if (failed && childExitObserved && !stderrCaptured) {
    const stderr = await readStderr()
    if (stderr)
      primaryFailure = new Error(`${primaryFailure.message}:${stderr}`, { cause: primaryFailure })
  }
  let cleanupFailure
  try {
    await closeStreamReader(reader, 'stdout')
  } catch (error) {
    cleanupFailure = error
  }
  if (failed && cleanupFailure)
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      `HOST_READ_AND_CLEANUP_FAILED:${label}`,
      {
        cause: primaryFailure,
      }
    )
  if (failed) throw primaryFailure
  if (cleanupFailure) throw cleanupFailure
  return result
}

async function cleanupHosts(hosts, directory, timeoutMs = CHILD_EXIT_BOUND_MS) {
  const failures = []
  for (const { label, child } of hosts) {
    if (!child) continue
    try {
      await stopChild({ child, exited: child.exited }, { label, timeoutMs })
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      [...failures, new Error(`state preserved until child exits are confirmed: ${directory}`)],
      `Pi lead restart child cleanup incomplete; state preserved at ${directory}`
    )
  }
  await rm(directory, { recursive: true, force: true })
}

test('a SIGKILLed Pi lead run is adopted by a restarted composition with no resend and no second admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-lead-restart-'))
  let initial
  let recovery
  let primaryFailure
  let failed = false
  try {
    initial = spawnHost('initial', directory)
    const held = await readLabelled(initial, 'HELD')
    expect(held.requests).toBe(1)
    expect(held.state).toBe('running')
    initial.kill('SIGKILL')
    await boundedWait(initial.exited, CHILD_EXIT_BOUND_MS, 'initial Pi lead host exit')
    expect(initial.signalCode).toBe('SIGKILL')

    recovery = spawnHost('recover', directory)
    const report = await readLabelled(recovery, 'REPORT')
    expect(
      await boundedWait(recovery.exited, CHILD_EXIT_BOUND_MS, 'recovery Pi lead host exit')
    ).toBe(0)

    // Adoption: the same retained run, the same attempt and execution, no new admission.
    expect(report.records).toHaveLength(1)
    const [record] = report.records
    expect(record.handleId).toBe(held.handleId)
    expect(record.attemptId).toBe(held.attemptId)
    expect(record.executionId).toBe(held.executionId)
    expect(record.epoch).toBeGreaterThan(held.epoch)
    expect(record.ownerPid).toBeUndefined()
    expect(report.resolvePlanCalls).toBe(0)

    // Fencing: the uncertain send is not resent, and the restarted process reports no authority block.
    expect(report.requests).toBe(0)
    expect(report.streams).toBe(0)
    expect(report.recoveryBlocked).toEqual([])
    expect(record.state).toBe('unknown')
    expect(record.inferencePending).toBe(true)

    // A duplicate submission after restart reaches neither the model nor a second run.
    expect(report.requestsAfterDuplicate).toBe(0)
    expect(report.journalAfterDuplicate).toBe(report.records.length)
    expect(report.duplicate).toEqual({ ok: true, dispatchId: held.dispatchId })
  } catch (error) {
    failed = true
    primaryFailure = error
  }
  let cleanupFailure
  try {
    await cleanupHosts(
      [
        { label: 'initial Pi lead host exit', child: initial },
        { label: 'recovery Pi lead host exit', child: recovery },
      ],
      directory
    )
  } catch (error) {
    cleanupFailure = error
  }
  if (cleanupFailure !== undefined) {
    if (failed)
      throw new AggregateError([primaryFailure, cleanupFailure], 'Pi lead restart proof failed', {
        cause: primaryFailure,
      })
    throw cleanupFailure
  }
  if (failed) throw primaryFailure
}, 120_000)

// A kill before the native HTTP dispatch does not resume from advisory process logs.
// The retained usage hold remains uncertain without an independently current no-send proof.
// No private hold-reuse permission is minted, no second admission is attempted, and the
// record remains held for reconciliation. The usage-ledger suite separately pins refusal
// of an ordinary second physical-dispatch admission.
test('a SIGKILL before HTTP dispatch fails closed after composition restart: no resend, no second admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-lead-restart-safe-'))
  let initial
  let recovery
  let primaryFailure
  let failed = false
  try {
    initial = spawnHost('before-send', directory)
    const held = await readLabelled(initial, 'HELD')
    expect(held.state).toBe('running')
    expect(held.requests).toBe(0)
    expect(held.inferenceKey).toMatch(/^pi-turn:att_[^:]+:initial:pi-generation:/)
    initial.kill('SIGKILL')
    await boundedWait(initial.exited, CHILD_EXIT_BOUND_MS, 'pre-send Pi lead host exit')
    expect(initial.signalCode).toBe('SIGKILL')

    recovery = spawnHost('recover-safe', directory)
    const report = await readLabelled(recovery, 'REPORT')
    expect(await boundedWait(recovery.exited, CHILD_EXIT_BOUND_MS, 'safe recovery host exit')).toBe(
      0
    )

    expect(report.records).toHaveLength(1)
    const [record] = report.records
    expect(record.handleId).toBe(held.handleId)
    expect(record.attemptId).toBe(held.attemptId)
    expect(record.executionId).toBe(held.executionId)
    // The logs record the checkpoint, but do not independently authorize hold reuse.
    expect(report.reconcileEvidence).toEqual({
      key: held.inferenceKey,
      beforeDispatch: true,
      alreadyForwarded: false,
      decision: 'unresolved',
    })
    // Recovery keeps the original uncertain hold without attempting another admission.
    expect(record.state).toBe('unknown')
    expect(record.inferencePending).toBe(true)
    expect(report.recoveryBlocked).toEqual([])
    expect(report.requests).toBe(0)
    expect(report.streams).toBe(0)
    expect(report.authorizedInferenceKeys).toEqual([])
    expect(report.resolvePlanCalls).toBe(0)

    expect(report.requestsAfterDuplicate).toBe(0)
    expect(report.journalAfterDuplicate).toBe(1)
    expect(report.duplicate).toEqual({ ok: true, dispatchId: held.dispatchId })

    const evidence = (await readFile(join(directory, 'process-evidence.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(evidence.filter((entry) => entry.phase === 'forwarded')).toEqual([])
    expect(evidence.filter((entry) => entry.phase === 'before_dispatch')).toEqual([
      { boundary: 'native_fetch', phase: 'before_dispatch', inferenceKey: held.inferenceKey },
    ])
    // The adapter never asks the spending port to authorize a second inference.
    // Do not manufacture a ledger rejection for an operation it did not attempt.
    expect(evidence.filter((entry) => entry.boundary === 'authority')).toEqual([])
  } catch (error) {
    failed = true
    primaryFailure = error
  }
  let cleanupFailure
  try {
    await cleanupHosts(
      [
        { label: 'pre-send Pi lead host exit', child: initial },
        { label: 'safe recovery host exit', child: recovery },
      ],
      directory
    )
  } catch (error) {
    cleanupFailure = error
  }
  if (cleanupFailure !== undefined) {
    if (failed)
      throw new AggregateError([primaryFailure, cleanupFailure], 'Pi lead safe restart failed', {
        cause: primaryFailure,
      })
    throw cleanupFailure
  }
  if (failed) throw primaryFailure
}, 120_000)

test('labelled child output releases its stdout reader on success and timeout', async () => {
  let successCancelled = false
  const successChild = {
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('HELD {"ready":true}\n'))
      },
      cancel() {
        successCancelled = true
      },
    }),
    stderr: new ReadableStream({ start: (controller) => controller.close() }),
    exited: new Promise(() => {}),
  }
  expect(await readLabelled(successChild, 'HELD')).toEqual({ ready: true })
  expect(successCancelled).toBe(true)

  let timeoutCancelled = false
  const timeoutChild = {
    stdout: new ReadableStream({
      cancel() {
        timeoutCancelled = true
      },
    }),
    stderr: new ReadableStream({ start: (controller) => controller.close() }),
    exited: new Promise(() => {}),
  }
  const failure = await readLabelled(timeoutChild, 'HELD', 1).catch((error) => error)
  expect(failure.message).toContain('BOUNDED_WAIT_TIMEOUT:HOST_TIMEOUT:HELD')
  expect(timeoutCancelled).toBe(true)
})

test('labelled child output waits for a fragmented label and JSON record to finish', async () => {
  const fragments = ['RE', 'PORT {"ready":', 'true}\n']
  const child = {
    stdout: new ReadableStream({
      pull(controller) {
        const fragment = fragments.shift()
        if (fragment === undefined) controller.close()
        else controller.enqueue(new TextEncoder().encode(fragment))
      },
    }),
    stderr: new ReadableStream({ start: (controller) => controller.close() }),
    exited: Promise.resolve(0),
  }
  expect(await readLabelled(child, 'REPORT')).toEqual({ ready: true })
})

test('labelled child output drains a buffered report after the exit signal resolves', async () => {
  let releaseReport
  const child = {
    stdout: new ReadableStream({
      start(controller) {
        releaseReport = () => {
          controller.enqueue(new TextEncoder().encode('REPORT {"buffered":true}\n'))
          controller.close()
        }
      },
    }),
    stderr: new ReadableStream({ start: (controller) => controller.close() }),
    exited: Promise.resolve(0),
  }
  const report = readLabelled(child, 'REPORT', 1_000)
  await new Promise((resolve) => setTimeout(resolve, 0))
  releaseReport()
  expect(await report).toEqual({ buffered: true })
})

test('child exit diagnostics bound stderr reads when an inherited pipe stays open', async () => {
  let stdoutCancelled = false
  let stderrCancelled = false
  const child = {
    stdout: new ReadableStream({
      cancel() {
        stdoutCancelled = true
      },
    }),
    stderr: new ReadableStream({
      cancel() {
        stderrCancelled = true
      },
    }),
    exited: Promise.resolve(1),
  }
  const failure = await readLabelled(child, 'REPORT', 50, 10).catch((error) => error)
  expect(failure.message).toContain('BOUNDED_WAIT_TIMEOUT:HOST_TIMEOUT:REPORT')
  expect(failure.message).toContain('[stderr read timed out]')
  expect(stdoutCancelled).toBe(true)
  expect(stderrCancelled).toBe(true)
}, 2_000)

test('restart fixture closes persistence after initialization failure and preserves both failures', async () => {
  const primaryFailure = new Error('fixture migration failure')
  const closeFailure = new Error('persistence close failure')
  let closeCalls = 0
  const failure = await openRestartComposition({
    directory: '/unused/restart-fixture',
    seed: false,
    baseUrl: 'http://127.0.0.1',
    createPersistenceProvider: () => ({
      dialect: 'sqlite',
      migrate: async () => {
        throw primaryFailure
      },
      close: async () => {
        closeCalls += 1
        throw closeFailure
      },
    }),
  }).catch((error) => error)

  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.errors).toEqual([primaryFailure, closeFailure])
  expect(failure.cause).toBe(primaryFailure)
  expect(closeCalls).toBe(1)
})

test('restart fixture attempts persistence close even when composition close fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-lead-close-failure-'))
  const compositionFailure = new Error('composition close failure')
  const persistenceFailure = new Error('persistence close failure')
  const closeCalls = []
  try {
    await writeFile(
      join(directory, 'restart-fixture-state.json'),
      JSON.stringify({ evidence: { workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG' } })
    )
    const opened = await openRestartComposition({
      directory,
      seed: false,
      baseUrl: 'http://127.0.0.1',
      createPersistenceProvider: () => ({
        dialect: 'sqlite',
        migrate: async () => {},
        close: async () => {
          closeCalls.push('persistence')
          throw persistenceFailure
        },
      }),
      createLeadComposition: async () => ({
        close: async () => {
          closeCalls.push('composition')
          throw compositionFailure
        },
      }),
    })
    const failure = await opened.close().catch((error) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toEqual([compositionFailure, persistenceFailure])
    expect(closeCalls).toEqual(['composition', 'persistence'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('restart child cleanup preserves its SQLite state until exit is confirmed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-lead-unconfirmed-exit-'))
  const sqlitePath = join(directory, 'cp-state.sqlite')
  const signals = []
  let confirmExit
  const child = {
    exitCode: null,
    signalCode: null,
    exited: new Promise((resolve) => {
      confirmExit = resolve
    }),
    kill(signal) {
      signals.push(signal)
      return true
    },
  }
  try {
    await writeFile(sqlitePath, 'retained state')
    const failure = await cleanupHosts(
      [{ label: 'unconfirmed Pi lead host', child }],
      directory,
      1
    ).catch((error) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.message).toContain(directory)
    expect(failure.errors[0].message).toContain('BOUNDED_WAIT_TIMEOUT')
    expect(signals).toEqual(['SIGKILL'])
    expect(await readFile(sqlitePath, 'utf8')).toBe('retained state')
  } finally {
    child.exitCode = 0
    confirmExit(0)
    await cleanupHosts([{ label: 'confirmed Pi lead host', child }], directory)
  }
})
