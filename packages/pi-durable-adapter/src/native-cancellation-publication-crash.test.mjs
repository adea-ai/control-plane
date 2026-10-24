import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(
  new URL('./native-cancellation-publication-crash.node.fixture.mjs', import.meta.url)
)
const prefix = 'PI_NATIVE_CRASH '
const outputLimit = 256 * 1024
const phaseTimeout = 5000

async function bounded(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`NATIVE_CRASH_TIMEOUT:${label}`)), phaseTimeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function worker(directory, mode, expectedKind) {
  const child = spawn('node', [fixture, mode, directory], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let buffered = ''
  let found = false
  let processError
  let resolveBoundary, rejectBoundary, resolveExit
  const boundary = new Promise((resolve, reject) => {
    resolveBoundary = resolve
    rejectBoundary = reject
  })
  // Cleanup can observe early failures even when another awaited phase failed.
  boundary.catch(() => {})
  const exited = new Promise((resolve) => {
    resolveExit = resolve
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > outputLimit) {
      processError ??= new Error('NATIVE_CRASH_STDOUT_LIMIT')
      rejectBoundary(processError)
      return
    }
    stdout += chunk
    buffered += chunk
    for (;;) {
      const end = buffered.indexOf('\n')
      if (end < 0) break
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      if (!line.startsWith(prefix)) continue
      try {
        const value = JSON.parse(line.slice(prefix.length))
        if (value.kind === expectedKind && !found) {
          found = true
          resolveBoundary(value)
        }
      } catch (error) {
        rejectBoundary(error)
      }
    }
  })
  child.stderr.on('data', (chunk) => {
    if (Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > outputLimit) {
      processError ??= new Error('NATIVE_CRASH_STDERR_LIMIT')
      rejectBoundary(processError)
      return
    }
    stderr += chunk
  })
  child.on('error', (error) => {
    processError = error
    rejectBoundary(error)
  })
  child.on('close', (code, signal) => {
    const result = { code, signal, stdout, stderr, error: processError }
    if (!found)
      rejectBoundary(new Error(`NATIVE_CRASH_EXIT_BEFORE_${expectedKind}:${stderr || stdout}`))
    resolveExit(result)
  })
  return { child, boundary, exited }
}

async function cleanup(owned, directory) {
  const failures = []
  for (const entry of owned) {
    try {
      if (entry.child.exitCode === null && entry.child.signalCode === null)
        entry.child.kill('SIGKILL')
      await bounded(entry.exited, 'owned-child-exit')
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      `Native crash cleanup incomplete; state preserved at ${directory}`
    )
  await rm(directory, { recursive: true, force: true })
}

// Negative safety only: no receipt reader is opened after the crash, and no
// positive cancellation settlement is inferred from the pre-crash N evidence.
test('SIGKILL after guarded native N and before journal publication stays unresolved without resending after two authorized restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-native-publication-crash-'))
  const owned = []
  let primaryFailure
  try {
    const initial = worker(directory, 'initial', 'N_COMMITTED')
    owned.push(initial)
    const boundary = await bounded(initial.boundary, 'native-N')
    expect(boundary.node).toBe('v24.21.0')
    expect(boundary.nativeReceipt.taskIds.length).toBeGreaterThan(0)
    expect(boundary.providerRequests).toBe(1)
    expect(boundary.streamAborts).toBe(1)
    expect(boundary.record.state).toBe('running')
    expect(boundary.record.detail.cancellationIntent).toBeUndefined()
    expect(boundary.record.detail.nativeCancellationReceipt).toBeUndefined()
    expect(
      JSON.parse(await readFile(join(directory, 'native-publication-crash-boundary.json'), 'utf8'))
    ).toEqual(boundary)
    expect(initial.child.kill('SIGKILL')).toBe(true)
    const killed = await bounded(initial.exited, 'initial-SIGKILL-exit')
    expect(killed.error).toBeUndefined()
    expect(killed.signal).toBe('SIGKILL')
    expect(killed.stderr).toBe('')

    let priorEpoch = boundary.record.epoch
    for (let incarnation = 0; incarnation < 2; incarnation++) {
      const recovery = worker(directory, 'recover', 'RECOVERED')
      owned.push(recovery)
      const report = await bounded(recovery.boundary, `authorized-recovery-${incarnation}`)
      const complete = await bounded(recovery.exited, `recovery-exit-${incarnation}`)
      expect(complete.error).toBeUndefined()
      expect(complete.stderr).toBe('')
      expect(complete.code).toBe(0)
      expect(complete.signal).toBeNull()
      expect(report.node).toBe('v24.21.0')
      expect(report.record.handleId).toBe(boundary.record.handleId)
      expect(report.record.epoch).toBeGreaterThan(priorEpoch)
      priorEpoch = report.record.epoch
      expect(report.record.state).toBe('unknown')
      expect(report.record.detail.activeInference).toEqual(boundary.record.detail.activeInference)
      expect(report.record.detail.inferencePending).toBe(true)
      for (const key of [
        'cancellationIntent',
        'nativeCancellationReceipt',
        'result',
        'terminalUsage',
      ])
        expect(report.record.detail[key]).toBeUndefined()
      expect(report.record.detail.safeResumeInferenceKey).toBeUndefined()
      expect(report.counters.authority).toBeGreaterThan(0)
      expect(report.counters.inferenceAuthorizations).toBe(0)
      expect(report.counters.engines).toBe(0)
      expect(report.counters.models).toBe(0)
      expect(report.counters.settlements).toBe(0)
      expect(report.providerRequests).toBe(0)
      expect(
        report.events.some((event) =>
          ['cancelled', 'completed', 'failed'].includes(event.data?.state)
        )
      ).toBe(false)
    }
  } catch (error) {
    primaryFailure = error
  }
  let cleanupFailure
  try {
    await cleanup(owned, directory)
  } catch (error) {
    cleanupFailure = error
  }
  if (primaryFailure && cleanupFailure)
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      'Native crash proof and cleanup failed'
    )
  if (primaryFailure) throw primaryFailure
  if (cleanupFailure) throw cleanupFailure
}, 30000)
