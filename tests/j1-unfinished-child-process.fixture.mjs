// Test-owned process harness. Only children spawned here may be signalled.
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const worker = fileURLToPath(
  new URL('./pi-child-continuation-process.fixture.mjs', import.meta.url)
)
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export function assertJ1ImmutableReplay(snapshot) {
  assert.equal(snapshot.replayOriginalRetained, true)
  assert.equal(snapshot.replayChangedDenied, true)
  assert.deepEqual(
    snapshot.replayMutationRejections,
    ['expiresAt', 'requestDigest', 'externalSessionId'].map((mutation) => ({
      mutation,
      code: 'PI_CHILD_CONTINUATION_DENIED',
      classification: 'immutable_conflict',
      persistenceFailureCode: null,
    }))
  )
}

export function assertJ1DeniedRecovery(snapshot, reason) {
  assert.ok(['PI_CHILD_CONTINUATION_REJECTED', 'PI_CHILD_CONTINUATION_DENIED'].includes(reason))
  const classification =
    reason === 'PI_CHILD_CONTINUATION_REJECTED' ? 'missing_grant' : 'expired_grant'
  assert.equal(snapshot.schemaVersion, 'pi-child-recovery-evidence/v1')
  assert.equal(snapshot.recoveryOutcome, 'expected_denial')
  assert.equal(snapshot.recoveryBoundary, 'assert_resume')
  assert.equal(snapshot.blocked, true)
  assert.equal(snapshot.reason, reason)
  assert.deepEqual(snapshot.rejection, { stage: 'assert_resume', code: reason, classification })
  const condition = snapshot.expectedCanonicalCondition
  assert.equal(condition.kind, classification)
  assert.equal(condition.parentState, 'completed')
  assert.equal(condition.parentState, snapshot.parentState)
  assert.equal(condition.grantPresent, classification === 'expired_grant')
  if (classification === 'missing_grant') assert.equal(snapshot.grant, null)
  if (classification === 'expired_grant') {
    assert.equal(condition.expiresAt, snapshot.grant.expiresAt)
    assert.ok(Number.isFinite(Date.parse(condition.now)))
    assert.ok(Date.parse(condition.now) >= Date.parse(condition.expiresAt))
  }
}

export function assertJ1QuarantinedRecovery(snapshot) {
  assert.equal(snapshot.schemaVersion, 'pi-child-recovery-evidence/v1')
  assert.equal(snapshot.recoveryOutcome, 'pending_physical_send')
  assert.equal(snapshot.recoveryBoundary, 'runtime_recover')
  assert.equal(snapshot.pendingReason, 'PI_PROCESS_PHYSICAL_SEND_PENDING')
  assert.equal(snapshot.runtimeConstructed, true)
  assert.equal(snapshot.drainCompleted, true)
  assert.notEqual(snapshot.blocked, true)
  assert.equal(snapshot.reason, undefined)
  assert.equal(snapshot.reconciled, false)
  assert.equal(snapshot.state, 'unknown')
}

export function assertJ1ConcurrentRecovery(snapshots) {
  assert.equal(snapshots.length, 2)
  assert.notEqual(snapshots[0].pid, snapshots[1].pid)
  for (const snapshot of snapshots) {
    assert.ok(Number.isSafeInteger(snapshot.pid))
    assert.ok(snapshot.pid > 0)
    assert.equal(snapshot.schemaVersion, 'pi-child-recovery-evidence/v1')
    assert.equal(snapshot.recoveryBoundary, 'runtime_recover')
    assert.equal(snapshot.runtimeConstructed, true)
    assert.equal(snapshot.drainCompleted, true)
    assert.notEqual(snapshot.blocked, true)
    assert.equal(snapshot.reason, undefined)
    assert.ok(['starting', 'running', 'completed'].includes(snapshot.state))
    assert.ok(Number.isSafeInteger(snapshot.journalOwnership.epoch))
    assert.ok(snapshot.journalOwnership.epoch > 0)
    if (snapshot.state === 'completed') {
      assert.equal(snapshot.recoveryOutcome, 'completed')
      assert.equal(snapshot.reconciled, true)
    } else {
      assert.equal(snapshot.recoveryOutcome, 'competing_owner')
      assert.ok(Number.isSafeInteger(snapshot.journalOwnership.ownerPid))
      assert.ok(snapshot.journalOwnership.ownerPid > 0)
      assert.notEqual(snapshot.journalOwnership.ownerPid, snapshot.pid)
      assert.equal(snapshot.journalOwnership.ownerEpoch, snapshot.journalOwnership.epoch)
    }
  }
  assert.ok(snapshots.some((snapshot) => snapshot.state === 'completed'))
}

export async function createUnfinishedChildProcessHarness(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'j1-unfinished-child-'))
  const children = new Set()
  let releaseResponses = () => {}
  const responseGate = new Promise((resolve) => {
    releaseResponses = resolve
  })
  let transport
  try {
    const { createChildProcessTransport } =
      await import('./pi-child-continuation-process.fixture.mjs')
    transport = await createChildProcessTransport({
      ...options,
      ...(options.holdResponsesForRecovery ? { beforeResponse: () => responseGate } : {}),
    })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  async function evidence() {
    try {
      return (await readFile(join(directory, 'process-evidence.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse)
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }
  function start(mode, runtime = 'node') {
    const command = runtime === 'bun' ? process.execPath : 'node'
    const args = runtime === 'bun' ? [] : ['--experimental-transform-types']
    const child = spawn(command, [...args, worker, directory, mode, transport.baseUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        PI_CHILD_PROCESS_EMITTED: runtime === 'node' ? 'true' : 'false',
      },
    })
    let output = ''
    let stdout = ''
    const events = []
    child.stdout.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(-16384)
      stdout += chunk
      const lines = stdout.split('\n')
      stdout = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('{')) continue
        events.push(JSON.parse(line))
      }
    })
    child.stderr.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(-16384)
    })
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    // Attach a handler immediately; callers still observe the original failure.
    exit.catch(() => {})
    const owned = { child, exit, events, output: () => output }
    children.add(owned)
    return owned
  }
  async function waitFor(predicate, owned, timeout = 20000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const rows = await evidence()
      const result = predicate([...rows, ...(owned?.events ?? [])])
      if (result) return result
      if (owned && (owned.child.exitCode !== null || owned.child.signalCode !== null)) {
        throw new Error(`J1_WORKER_EXIT_BEFORE_EVIDENCE: ${owned.output()}`)
      }
      await delay(10)
    }
    throw new Error(`J1_PROCESS_EVIDENCE_TIMEOUT: ${owned?.output() ?? ''}`)
  }
  async function kill(owned) {
    if (!children.has(owned)) throw new Error('J1_FOREIGN_PROCESS_SIGNAL_DENIED')
    if (owned.child.exitCode === null && owned.child.signalCode === null)
      owned.child.kill('SIGKILL')
    return owned.exit
  }
  return {
    directory,
    transport,
    evidence,
    start,
    waitFor,
    kill,
    releaseResponses,
    async setClock(now) {
      await writeFile(join(directory, 'current-time.json'), JSON.stringify(now))
    },
    async descriptor() {
      return JSON.parse(await readFile(join(directory, 'child-descriptor.json'), 'utf8'))
    },
    async close() {
      await Promise.all(
        [...children].map(async ({ child, exit }) => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL')
          }
          await exit.catch(() => {})
        })
      )
      releaseResponses()
      await transport.close()
      if (process.env.J1_PROOF_EVIDENCE_DIR) {
        const target = join(process.env.J1_PROOF_EVIDENCE_DIR, basename(directory))
        await mkdir(target, { recursive: true })
        // All owned writers have exited. Retain the complete synthetic fixture,
        // including SQLite WAL/SHM sidecars, before removing the original.
        await cp(directory, join(target, 'fixture'), { recursive: true })
        await writeFile(
          join(target, 'transport-counters.json'),
          JSON.stringify({
            schemaVersion: 1,
            capturedAfterOwnedExitAndTransportClose: true,
            parsedChildModelRequests: transport.requests.length,
          })
        )
        await writeFile(
          join(target, 'worker-output.json'),
          JSON.stringify(
            [...children].map(({ child, output }) => ({
              pid: child.pid,
              exitCode: child.exitCode,
              signalCode: child.signalCode,
              output: output(),
            }))
          )
        )
      }
      await rm(directory, { recursive: true, force: true })
    },
  }
}
