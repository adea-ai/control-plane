// M17.02.2 (#1025): Pi lead composition crash/restart proof through the production startup path.
// A child process admits one run and holds its scripted model turn open. The parent SIGKILLs that
// process, reaps it, and a second child opens the same directory. Construction must adopt the
// retained run without resending or admitting anything new. Loopback only; no provider or live resource.
import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hostPath = new URL('./fixtures/pi-lead-restart/host.mjs', import.meta.url).pathname

function spawnHost(mode, directory) {
  return Bun.spawn([process.execPath, hostPath, mode, directory], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

// Reads stdout until a line with `label` arrives; fails with the child's stderr if it exits first.
async function readLabelled(child, label, timeoutMs = 60_000) {
  const decoder = new TextDecoder()
  const reader = child.stdout.getReader()
  const deadline = Date.now() + timeoutMs
  let buffer = ''
  for (;;) {
    const line = buffer.split('\n').find((candidate) => candidate.startsWith(`${label} `))
    if (line) return JSON.parse(line.slice(label.length + 1))
    if (Date.now() > deadline) throw new Error(`HOST_TIMEOUT:${label}`)
    const next = await Promise.race([
      reader.read(),
      child.exited.then(() => ({ done: true, value: undefined })),
    ])
    if (next.done)
      throw new Error(`HOST_EXITED_BEFORE:${label}:${await new Response(child.stderr).text()}`)
    buffer += decoder.decode(next.value, { stream: true })
  }
}

test('a SIGKILLed Pi lead run is adopted by a restarted composition with no resend and no second admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-lead-restart-'))
  let initial
  let recovery
  try {
    initial = spawnHost('initial', directory)
    const held = await readLabelled(initial, 'HELD')
    expect(held.requests).toBe(1)
    expect(held.state).toBe('running')
    initial.kill('SIGKILL')
    await initial.exited
    expect(initial.signalCode).toBe('SIGKILL')

    recovery = spawnHost('recover', directory)
    const report = await readLabelled(recovery, 'REPORT')
    expect(await recovery.exited).toBe(0)

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
  } finally {
    if (initial && initial.exitCode === null && initial.signalCode === null) initial.kill('SIGKILL')
    if (recovery && recovery.exitCode === null && recovery.signalCode === null)
      recovery.kill('SIGKILL')
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)
