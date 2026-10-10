import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { RuntimeAdapterError } from '@control-plane/runtime-sdk'
import { PiDurableRuntimeAdapter } from './adapter.ts'
import { createNodePiDurableRuntime } from './composition.ts'
import { at, fixture, result } from './recovery-races.fixture.mjs'

function typedUnavailable() {
  return new RuntimeAdapterError({
    code: 'PI_AUTHORITY_UNAVAILABLE',
    classification: 'unavailable',
    message: 'PI_AUTHORITY_UNAVAILABLE',
    retryable: true,
  })
}

// Failures an old owner can return after it has lost its claim. Each reports in memory only.
const oldOwnerFailures = [
  [
    'declared denial',
    () => new Error('PI_CANONICAL_AUTHORITY_REJECTED'),
    'PI_RECOVERY_AUTHORITY_BLOCKED',
  ],
  ['typed unavailable', typedUnavailable, 'PI_RECOVERY_UNAVAILABLE'],
  [
    'untyped transport',
    () => new Error('connect ECONNRESET secret-transport-token'),
    'PI_RECOVERY_UNCLASSIFIED',
  ],
]

// Transient probe failures. They must never persist a revocation marker, however often they recur.
const transientProbes = oldOwnerFailures.slice(1)

function withoutOwner(record) {
  return { ...record, detail: { ...record.detail, ownerPid: undefined, ownerEpoch: undefined } }
}

/** Retains one running execution the way an interrupted owner leaves it. */
async function retainRunning(setup, request = setup.request) {
  const seed = new PiDurableRuntimeAdapter({ ...setup.options })
  try {
    const handle = await seed.start(request)
    await seed.drain()
    const stored = seed.journal.get(handle.handleId)
    seed.journal.update(handle.handleId, stored.epoch, {
      state: 'running',
      detail: { inferencePending: true },
    })
    return { handle, retained: seed.journal.get(handle.handleId) }
  } finally {
    await seed.close()
  }
}

/** Usage port with the production idempotency contract: a repeated key with identical usage
 * returns the first receipt, and different usage for that key is refused. */
function keyedUsageLedger() {
  const receipts = new Map()
  const calls = []
  return {
    calls,
    receipts,
    settleUsage: async (_authority, key, usage) => {
      calls.push({ key, usage })
      const first = receipts.get(key)
      if (!first) {
        receipts.set(key, usage)
        return usage
      }
      if (canonicalJsonStringify(first) !== canonicalJsonStringify(usage))
        throw new Error('PI_USAGE_SETTLEMENT_CONFLICT')
      return first
    },
  }
}

function completingEngine(counter, run = async () => result) {
  return async () => {
    counter.engines += 1
    return { run, close: async () => {}, cancel: async () => {} }
  }
}

test.each(oldOwnerFailures)(
  'a competing cancel fences recovery whose authority then fails (%s): the current owner keeps its record',
  async (_label, failure, code) => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-competing-cancel-'))
    const setup = fixture(directory)
    let runtime
    try {
      const { handle, retained } = await retainRunning(setup)
      let adapter, current
      let raced = false
      runtime = await createNodePiDurableRuntime({
        ...setup.options,
        onAdapterReady: (ready) => {
          adapter = ready
        },
        assertAuthority: async () => {
          if (raced) return
          raced = true
          await adapter.cancel(handle, { idempotencyKey: 'cancel:competing', requestedAt: at })
          current = adapter.journal.get(handle.handleId)
          throw failure()
        },
        reconcileInference: async () => 'safe_to_resume',
      })
      // Retained E, recovery claim E+1, competing cancel E+2. The failed recovery writes nothing.
      const after = runtime.adapter.journal.get(handle.handleId)
      expect(after).toEqual(withoutOwner(current))
      expect(after.epoch).toBe(retained.epoch + 2)
      expect(after.state).toBe('cancelling')
      expect(after.detail.recoveryBlocked).toBeUndefined()
      expect(runtime.recoveryBlocked).toEqual([{ handleId: handle.handleId, code }])
      expect(JSON.stringify(runtime.recoveryBlocked)).not.toContain('secret-transport-token')
    } finally {
      await runtime?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test('a competing cancel outlives a successful old probe: the old owner resumes nothing, and a healthy restart resolves the cancellation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-competing-probe-'))
  const setup = fixture(directory)
  const counter = { engines: 0 }
  let runtime, restarted
  try {
    const { handle } = await retainRunning(setup)
    let adapter, current
    let raced = false
    runtime = await createNodePiDurableRuntime({
      ...setup.options,
      onAdapterReady: (ready) => {
        adapter = ready
      },
      assertAuthority: async () => {
        if (raced) return
        raced = true
        await adapter.cancel(handle, { idempotencyKey: 'cancel:competing', requestedAt: at })
        current = adapter.journal.get(handle.handleId)
      },
      reconcileInference: async () => 'safe_to_resume',
      engineFactory: completingEngine(counter),
    })
    expect(counter.engines).toBe(0)
    expect(runtime.recoveryBlocked).toEqual([])
    expect(runtime.adapter.journal.get(handle.handleId)).toEqual(withoutOwner(current))
    await runtime.close()
    runtime = undefined
    restarted = await createNodePiDurableRuntime({
      ...setup.options,
      reconcileInference: async () => 'safe_to_resume',
      engineFactory: completingEngine(counter),
    })
    await restarted.adapter.drain()
    expect(restarted.recoveryBlocked).toEqual([])
    expect(restarted.adapter.journal.get(handle.handleId).state).toBe('cancelled')
    expect(counter.engines).toBe(0)
  } finally {
    await runtime?.close()
    await restarted?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test.each(transientProbes)(
  'after a competing cancel, restarts with transient probes persist nothing and a healthy restart completes the cancellation (%s)',
  async (_label, failure, code) => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-competing-restart-'))
    const setup = fixture(directory)
    let runtime, restarted
    try {
      const { handle } = await retainRunning(setup)
      let adapter, current
      let raced = false
      runtime = await createNodePiDurableRuntime({
        ...setup.options,
        onAdapterReady: (ready) => {
          adapter = ready
        },
        assertAuthority: async () => {
          if (raced) return
          raced = true
          await adapter.cancel(handle, { idempotencyKey: 'cancel:competing', requestedAt: at })
          current = adapter.journal.get(handle.handleId)
          throw new Error('PI_CANONICAL_AUTHORITY_REJECTED')
        },
        reconcileInference: async () => 'safe_to_resume',
      })
      await runtime.close()
      runtime = undefined
      const fenced = withoutOwner(current)
      runtime = await createNodePiDurableRuntime({
        ...setup.options,
        reconcileInference: async () => {
          throw failure()
        },
      })
      expect(runtime.recoveryBlocked).toEqual([{ handleId: handle.handleId, code }])
      // The probe's undone claim leaves the competing cancellation exactly as it was.
      expect(runtime.adapter.journal.get(handle.handleId)).toEqual(fenced)
      await runtime.close()
      runtime = undefined
      restarted = await createNodePiDurableRuntime({
        ...setup.options,
        reconcileInference: async () => 'safe_to_resume',
      })
      await restarted.adapter.drain()
      expect(restarted.recoveryBlocked).toEqual([])
      expect(restarted.adapter.journal.get(handle.handleId).state).toBe('cancelled')
      expect(restarted.adapter.journal.get(handle.handleId).detail.recoveryBlocked).toBeUndefined()
    } finally {
      await runtime?.close()
      await restarted?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test.each(oldOwnerFailures)(
  'a competing owner in another live process keeps its claim when the old owner fails (%s); restarts observe it, and its death lets a restart resume',
  async (_label, failure, code) => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-competing-owner-'))
    const setup = fixture(directory)
    let runtime, observer, resumed
    try {
      const { handle, retained } = await retainRunning(setup)
      let adapter, competitor
      let raced = false
      runtime = await createNodePiDurableRuntime({
        ...setup.options,
        onAdapterReady: (ready) => {
          adapter = ready
        },
        assertAuthority: async () => {
          if (raced) return
          raced = true
          const current = adapter.journal.get(handle.handleId)
          const epoch = adapter.journal.claim(handle.handleId, current)
          adapter.journal.update(handle.handleId, epoch, {
            detail: { ...current.detail, ownerPid: process.ppid, ownerEpoch: epoch },
          })
          competitor = adapter.journal.get(handle.handleId)
          throw failure()
        },
        reconcileInference: async () => 'safe_to_resume',
      })
      // The old owner's release must not clear or rewrite a claim that names another process.
      expect(runtime.adapter.journal.get(handle.handleId)).toEqual(competitor)
      expect(competitor.epoch).toBe(retained.epoch + 2)
      expect(competitor.detail.ownerPid).toBe(process.ppid)
      expect(runtime.recoveryBlocked).toEqual([{ handleId: handle.handleId, code }])
      await runtime.close()
      runtime = undefined

      // While the competitor is alive, a restart only observes its claim: no authority, no probe.
      const calls = { authority: 0, probe: 0 }
      observer = await createNodePiDurableRuntime({
        ...setup.options,
        assertAuthority: async () => {
          calls.authority += 1
          throw new Error('OBSERVER_MUST_NOT_AUTHORIZE')
        },
        reconcileInference: async () => {
          calls.probe += 1
          throw new Error('OBSERVER_MUST_NOT_PROBE')
        },
      })
      expect(calls).toEqual({ authority: 0, probe: 0 })
      expect(observer.recoveryBlocked).toEqual([])
      expect(observer.adapter.journal.get(handle.handleId)).toEqual(competitor)
      await observer.close()
      observer = undefined

      // The competitor dies. Its recorded pid is no longer live, so a restart claims and resumes.
      const writer = new PiDurableRuntimeAdapter({ ...setup.options })
      writer.journal.update(handle.handleId, competitor.epoch, {
        detail: { ...competitor.detail, ownerPid: deadProcessId() },
      })
      await writer.close()
      resumed = await createNodePiDurableRuntime({
        ...setup.options,
        reconcileInference: async () => 'safe_to_resume',
      })
      await resumed.adapter.drain()
      expect(resumed.recoveryBlocked).toEqual([])
      expect(resumed.adapter.journal.get(handle.handleId).state).toBe('completed')
    } finally {
      await runtime?.close()
      await observer?.close()
      await resumed?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

function deadProcessId() {
  const child = spawnSync(process.execPath, ['-e', '0'])
  if (!Number.isSafeInteger(child.pid) || child.status !== 0)
    throw new Error('TEST_DEAD_PROCESS_UNAVAILABLE')
  return child.pid
}

test('a second composition that finds the live owner observes only, and the declared denial of the owner is still persisted under its claim', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-contended-denial-'))
  const setup = fixture(directory)
  let runtime, contender, resumed
  try {
    const { handle, retained } = await retainRunning(setup)
    const calls = { authority: 0, probe: 0 }
    let contended = false
    runtime = await createNodePiDurableRuntime({
      ...setup.options,
      assertAuthority: async () => {
        if (!contended) {
          contended = true
          contender = await createNodePiDurableRuntime({
            ...setup.options,
            assertAuthority: async () => {
              calls.authority += 1
              throw new Error('CONTENDER_MUST_NOT_AUTHORIZE')
            },
            reconcileInference: async () => {
              calls.probe += 1
              throw new Error('CONTENDER_MUST_NOT_PROBE')
            },
          })
        }
        throw new Error('PI_CANONICAL_AUTHORITY_REJECTED')
      },
      reconcileInference: async () => 'safe_to_resume',
    })
    expect(calls).toEqual({ authority: 0, probe: 0 })
    expect(contender.recoveryBlocked).toEqual([])
    await contender.close()
    contender = undefined
    expect(runtime.recoveryBlocked).toEqual([
      { handleId: handle.handleId, code: 'PI_RECOVERY_AUTHORITY_BLOCKED' },
    ])
    expect(runtime.adapter.journal.get(handle.handleId)).toEqual({
      ...retained,
      epoch: retained.epoch + 2,
      detail: { ...retained.detail, recoveryBlocked: 'PI_RECOVERY_AUTHORITY_BLOCKED' },
    })
    await runtime.close()
    runtime = undefined
    resumed = await createNodePiDurableRuntime({
      ...setup.options,
      reconcileInference: async () => 'safe_to_resume',
    })
    await resumed.adapter.drain()
    expect(resumed.adapter.journal.get(handle.handleId).state).toBe('completed')
  } finally {
    await contender?.close()
    await runtime?.close()
    await resumed?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test.each(transientProbes)(
  'repeated transient probe failures across restarts never persist a revocation marker (%s)',
  async (_label, failure, code) => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-transient-restarts-'))
    const setup = fixture(directory)
    let healthy
    try {
      const { handle, retained } = await retainRunning(setup)
      for (let restart = 0; restart < 2; restart += 1) {
        const runtime = await createNodePiDurableRuntime({
          ...setup.options,
          reconcileInference: async () => {
            throw failure()
          },
        })
        expect(runtime.recoveryBlocked).toEqual([{ handleId: handle.handleId, code }])
        expect(runtime.adapter.journal.get(handle.handleId)).toEqual(retained)
        await runtime.close()
      }
      healthy = await createNodePiDurableRuntime({
        ...setup.options,
        reconcileInference: async () => 'safe_to_resume',
      })
      await healthy.adapter.drain()
      expect(healthy.recoveryBlocked).toEqual([])
      expect(healthy.adapter.journal.get(handle.handleId).state).toBe('completed')
      expect(healthy.adapter.journal.get(handle.handleId).detail.recoveryBlocked).toBeUndefined()
    } finally {
      await healthy?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test('an old owner settles an inference and loses its claim before recording it; the current owner replays it into one receipt and one ledger entry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-duplicate-settlement-'))
  const setup = fixture(directory)
  const ledger = keyedUsageLedger()
  let seed, restarted, replay
  try {
    seed = new PiDurableRuntimeAdapter({
      ...setup.options,
      settleUsage: async (authority, key, usage, counts) => {
        const receipt = await ledger.settleUsage(authority, key, usage, counts)
        if (ledger.calls.length === 1) {
          // The current owner fences this run after its settlement is durable, before the receipt.
          const [record] = seed.journal.list()
          seed.journal.claim(record.handleId, record)
        }
        return receipt
      },
    })
    const handle = await seed.start(setup.request)
    await seed.drain()
    const orphaned = seed.journal.get(handle.handleId)
    expect(ledger.calls).toHaveLength(1)
    expect(orphaned.state).toBe('running')
    expect(orphaned.detail.inferenceReceipts).toBeUndefined()
    const key = ledger.calls[0].key
    await seed.close()
    seed = undefined

    replay = await createNodePiDurableRuntime({
      ...setup.options,
      settleUsage: ledger.settleUsage,
      reconcileInference: async () => 'safe_to_resume',
    })
    await replay.adapter.drain()
    const done = replay.adapter.journal.get(handle.handleId)
    expect(done.state).toBe('completed')
    expect(ledger.calls.map((call) => call.key)).toEqual([key, key])
    expect(ledger.receipts.size).toBe(1)
    expect(Object.keys(done.detail.inferenceReceipts)).toEqual([key])
    expect(done.detail.inferenceReceipts[key].usage).toEqual(ledger.receipts.get(key))
    await replay.close()
    replay = undefined

    // A later restart sees the completed record and settles nothing again.
    restarted = await createNodePiDurableRuntime({
      ...setup.options,
      settleUsage: ledger.settleUsage,
    })
    await restarted.adapter.drain()
    expect(ledger.calls).toHaveLength(2)
    expect(restarted.recoveryBlocked).toEqual([])
  } finally {
    await seed?.close()
    await replay?.close()
    await restarted?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a replay that settles the same inference with different usage fails closed without a second receipt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-conflicting-replay-'))
  const setup = fixture(directory)
  const ledger = keyedUsageLedger()
  let seed, replay
  try {
    seed = new PiDurableRuntimeAdapter({
      ...setup.options,
      settleUsage: async (authority, key, usage, counts) => {
        const receipt = await ledger.settleUsage(authority, key, usage, counts)
        if (ledger.calls.length === 1) {
          const [record] = seed.journal.list()
          seed.journal.claim(record.handleId, record)
        }
        return receipt
      },
    })
    const handle = await seed.start(setup.request)
    await seed.drain()
    await seed.close()
    seed = undefined
    const [first] = ledger.calls
    replay = await createNodePiDurableRuntime({
      ...setup.options,
      settleUsage: ledger.settleUsage,
      reconcileInference: async () => 'safe_to_resume',
      engineFactory: async () => ({
        run: async () => ({
          ...result,
          inferences: [
            {
              ...result.inferences[0],
              usage: { ...result.inferences[0].usage, inputTokens: 9 },
            },
          ],
        }),
        close: async () => {},
        cancel: async () => {},
      }),
    })
    await replay.adapter.drain()
    const failed = replay.adapter.journal.get(handle.handleId)
    expect(failed.state).toBe('unknown')
    expect(failed.detail.inferenceReceipts).toBeUndefined()
    expect(ledger.calls).toHaveLength(2)
    expect(ledger.receipts.get(first.key)).toEqual(first.usage)
    expect(replay.recoveryBlocked).toEqual([])
  } finally {
    await seed?.close()
    await replay?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test.each(oldOwnerFailures)(
  'a competing cancel during a run-path inference authorization that then fails (%s) leaves the cancel owner untouched and persists no revocation',
  async (_label, failure) => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-competing-authorization-'))
    const setup = fixture(directory)
    let handle, current
    let raced = false
    const seed = new PiDurableRuntimeAdapter({
      ...setup.options,
      authorizeInference: async (...args) => {
        if (raced) return setup.options.authorizeInference(...args)
        raced = true
        await seed.cancel(handle, { idempotencyKey: 'cancel:competing', requestedAt: at })
        current = seed.journal.get(handle.handleId)
        throw failure()
      },
      engineFactory: async (engineOptions) => ({
        run: async () => {
          await engineOptions.authorizeInference({ inferenceId: 'pi-generation:1' })
          return result
        },
        close: async () => {},
        cancel: async () => {},
      }),
    })
    try {
      handle = await seed.start(setup.request)
      await seed.drain()
      const after = seed.journal.get(handle.handleId)
      expect(after).toEqual(withoutOwner(current))
      expect(after.state).toBe('cancelling')
      expect(after.detail.recoveryBlocked).toBeUndefined()
    } finally {
      await seed.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test('a competing cancel on one retained execution never changes another retained execution', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-scoped-competing-'))
  const setup = fixture(directory)
  let runtime, resumed
  try {
    const first = await retainRunning(setup)
    const executionId = 'exe_01JBBCDEF0123456789ABCDEFG'
    const attemptId = 'att_01JBBCDEF0123456789ABCDEFG'
    const second = await retainRunning(setup, {
      ...setup.request,
      executionId,
      attemptId,
      idempotencyKey: 'race:start:two',
      attemptBudget: {
        ...setup.request.attemptBudget,
        executionId,
        attemptId,
        reservationKey: `runtime-attempt:${attemptId}`,
      },
    })
    let adapter, current
    let raced = false
    runtime = await createNodePiDurableRuntime({
      ...setup.options,
      onAdapterReady: (ready) => {
        adapter = ready
      },
      assertAuthority: async (authority) => {
        if (raced || authority.request.attemptId !== setup.request.attemptId) return
        raced = true
        await adapter.cancel(first.handle, { idempotencyKey: 'cancel:competing', requestedAt: at })
        current = adapter.journal.get(first.handle.handleId)
        throw new Error('PI_CANONICAL_AUTHORITY_REJECTED')
      },
      reconcileInference: async () => 'safe_to_resume',
    })
    await runtime.adapter.drain()
    expect(runtime.recoveryBlocked).toEqual([
      { handleId: first.handle.handleId, code: 'PI_RECOVERY_AUTHORITY_BLOCKED' },
    ])
    expect(runtime.adapter.journal.get(first.handle.handleId)).toEqual(withoutOwner(current))
    const other = runtime.adapter.journal.get(second.handle.handleId)
    expect(other.state).toBe('completed')
    expect(other.detail.recoveryBlocked).toBeUndefined()
    expect(other.epoch).toBe(second.retained.epoch + 1)
    await runtime.close()
    runtime = undefined
    resumed = await createNodePiDurableRuntime({
      ...setup.options,
      reconcileInference: async () => 'safe_to_resume',
    })
    await resumed.adapter.drain()
    expect(resumed.adapter.journal.get(first.handle.handleId).state).toBe('cancelled')
  } finally {
    await runtime?.close()
    await resumed?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
