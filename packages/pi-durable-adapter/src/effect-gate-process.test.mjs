import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { createHash } from 'node:crypto'

const node = process.env.CONTROL_PLANE_TEST_NODE ?? 'node'
const fixture = fileURLToPath(new URL('./effect-gate-process.fixture.mjs', import.meta.url))

function worker(directory, mode) {
  const child = spawn(node, ['--experimental-transform-types', fixture, directory, mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '',
    stderr = '',
    observed
  let resolveBoundary, rejectBoundary
  const boundary = new Promise((resolve, reject) => {
    resolveBoundary = resolve
    rejectBoundary = reject
  })
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    rejectBoundary(new Error(`Effect gate boundary timeout: ${stderr}`))
  }, 10000)
  child.stdout.on('data', (data) => {
    stdout += data
    if (observed || !stdout.includes('\n')) return
    try {
      observed = JSON.parse(stdout.slice(0, stdout.indexOf('\n')))
    } catch (error) {
      clearTimeout(timer)
      rejectBoundary(error)
      return
    }
    clearTimeout(timer)
    resolveBoundary(observed)
  })
  child.stderr.on('data', (data) => {
    stderr += data
  })
  const complete = new Promise((resolve) => {
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectBoundary(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (!observed) rejectBoundary(new Error(stderr || stdout || 'Child exited before boundary'))
      resolve({ code, signal, stderr })
    })
  })
  return { child, boundary, complete }
}

async function finish(directory, mode) {
  const owned = worker(directory, mode)
  const watchdog = setTimeout(() => owned.child.kill('SIGKILL'), 10000)
  try {
    const result = await owned.boundary
    const completed = await owned.complete
    expect(completed.code, completed.stderr).toBe(0)
    expect(completed.signal, completed.stderr).toBeNull()
    expect(result.boundary).toBe('finished')
    return result
  } finally {
    clearTimeout(watchdog)
    if (owned.child.exitCode === null && owned.child.signalCode === null)
      owned.child.kill('SIGKILL')
    await owned.complete
  }
}

function retained(evidence) {
  return {
    gateRecord: evidence.gateRecord,
    call: evidence.call,
    approval: evidence.approval,
    effects: evidence.effects,
  }
}

test('935: SIGKILL after a governed effect commit retains ambiguity across fresh-process redelivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-effect-process-crash-'))
  let owned
  try {
    const { request } = await finish(directory, 'seed')
    owned = worker(directory, 'crash')
    const committed = await owned.boundary
    expect(committed.boundary).toBe('effect_committed')
    expect(committed.gateRecord).toMatchObject({
      state: 'invoking',
      toolCallId: request.toolCallId,
      key: JSON.stringify([request.workspaceId, request.idempotencyKey]),
      requestDigest: `sha256:${createHash('sha256').update(canonicalJsonStringify(request)).digest('hex')}`,
      effectAdmittedAt: expect.any(String),
    })
    expect(committed.gateRecord.outcome).toBeUndefined()
    expect(committed.call).toMatchObject({
      status: 'executing',
      attemptId: request.attemptId,
      toolCallId: request.toolCallId,
    })
    expect(committed.approval).toMatchObject({
      state: 'responded',
      response: { action: 'approve', respondingPrincipalId: 'principal:owner' },
    })
    expect(committed.effects).toHaveLength(1)
    expect(committed.effects[0].identity).toMatchObject({
      executionId: request.executionId,
      attemptId: request.attemptId,
      input: request.input,
      workspaceId: request.workspaceId,
      toolVersionId: request.toolVersionId,
    })
    expect(committed.authorityChecks).toContain('approval')
    expect(committed.authorityChecks).toContain('effect')
    expect(committed.authorityChecks).not.toContain('publication')
    expect(owned.child.kill('SIGKILL')).toBe(true)
    expect((await owned.complete).signal).toBe('SIGKILL')

    for (let delivery = 0; delivery < 2; delivery++) {
      const replay = await finish(directory, 'replay')
      expect(replay.outcome).toEqual({
        state: 'reconciliation_required',
        reasonCode: 'PI_EFFECT_OUTCOME_UNKNOWN',
        toolCallId: request.toolCallId,
      })
      expect(retained(replay)).toEqual(retained(committed))
      expect(replay.authorityChecks).toEqual(['admission'])
    }
    const changed = await finish(directory, 'changed')
    expect(changed.error).toBe('PI_EFFECT_IDENTITY_CONFLICT')
    expect(retained(changed)).toEqual(retained(committed))
    const revoked = await finish(directory, 'revoked')
    expect(revoked.error).toBe('PI_EFFECT_AUTHORITY_REJECTED')
    expect(retained(revoked)).toEqual(retained(committed))
  } finally {
    if (owned) {
      owned.child.kill('SIGKILL')
      await owned.complete
    }
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test('935: a committed successful receipt replays in a fresh process without another effect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-effect-process-settled-'))
  try {
    await finish(directory, 'seed')
    const completed = await finish(directory, 'complete')
    expect(completed.outcome).toMatchObject({
      state: 'succeeded',
      result: { output: { saved: true } },
    })
    expect(completed.gateRecord).toMatchObject({ state: 'settled', outcome: completed.outcome })
    expect(completed.call.status).toBe('succeeded')
    expect(completed.effects).toHaveLength(1)
    for (let delivery = 0; delivery < 2; delivery++) {
      const replay = await finish(directory, 'replay')
      expect(replay.outcome).toEqual(completed.outcome)
      expect(retained(replay)).toEqual(retained(completed))
      expect(replay.authorityChecks).toEqual(['admission', 'publication'])
    }
    const revoked = await finish(directory, 'revoked')
    expect(revoked.error).toBe('PI_EFFECT_AUTHORITY_REJECTED')
    expect(revoked.outcome).toBeUndefined()
    expect(retained(revoked)).toEqual(retained(completed))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test('935: a pending canonical approval prevents the process fixture executor from committing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-effect-process-approval-'))
  try {
    await finish(directory, 'seed_pending')
    const pending = await finish(directory, 'complete')
    expect(pending.outcome.state).toBe('awaiting_approval')
    expect(pending.approval.state).toBe('pending')
    expect(pending.gateRecord.effectAdmittedAt).toBeUndefined()
    expect(pending.effects).toEqual([])
    const revoked = await finish(directory, 'revoked')
    expect(revoked.error).toBe('PI_EFFECT_AUTHORITY_REJECTED')
    expect(retained(revoked)).toEqual(retained(pending))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
