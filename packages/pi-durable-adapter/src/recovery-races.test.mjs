import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { PiDurableRuntimeAdapter } from './adapter.ts'
import { createNodePiDurableRuntime } from './composition.ts'
import { writeRecoverySourceOverride } from './recovery-races.fixture.mjs'

const at = '2026-10-08T00:00:00.000Z'
const interactionId = 'int_01JABCDEF0123456789ABCDEFG'
const result = {
  text: 'Scripted race result',
  submissionId: 'race-result',
  usage: { inputTokens: 3, outputTokens: 4, durationMs: 2 },
  inferences: [
    {
      inferenceId: 'pi-generation:1',
      usage: {
        inputTokens: 3,
        outputTokens: 4,
        durationMs: 2,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
    },
  ],
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

// Fake engines intentionally isolate scheduler races; no provider verification is claimed.
function fixture(directory, overrides = {}) {
  const plan = createExecutionPlanTestFixture({
    profileCapabilityRequirements: [],
    skillRequiredCapabilities: [],
  })
  const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
  const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
  const request = {
    executionId,
    attemptId,
    idempotencyKey: 'race:start:one',
    executionPlan: plan,
    attemptBudget: {
      schemaVersion: 1,
      workspaceId: plan.correlation.workspaceId,
      executionId,
      attemptId,
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
      reservationKey: `runtime-attempt:${attemptId}`,
      currency: 'USD',
      maximumMicrounits: 10000,
      maximumTokens: 100,
    },
  }
  const admission = {
    schemaVersion: 'pi-durable-admission/v1',
    prompt: 'Canonical race input',
    selection: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 },
    authority: {
      revision: 1,
      principalRef: 'principal:one',
      scopeRef: 'scope:one',
      expiresAt: '2027-01-01T00:00:00.000Z',
    },
  }
  const options = {
    directory,
    now: () => at,
    resolveAdmission: async () => admission,
    assertAuthority: async () => {},
    resolveProvider: async () => ({
      selectionRef: admission.selection.selectionRef,
      selectionRevision: 1,
      workspaceId: plan.correlation.workspaceId,
      provider: 'scripted',
      providerModel: 'race-model',
      location: 'remote_host',
      harness: 'pi_durable',
      harnessVersion: '1.1.0',
      providerBinding: 'pi_durable_models',
      withModels: async (use) => use({}),
    }),
    authorizeInference: async () => ({
      maxOutputTokens: 10,
      maximumInputTokens: 64,
      assertActive: async () => {},
    }),
    settleUsage: async (_authority, _key, usage) => usage,
    reconcileInference: async () => 'unresolved',
    engineFactory: async () => ({
      run: async () => result,
      close: async () => {},
      cancel: async () => {},
    }),
    ...overrides,
  }
  return { request, options }
}

test.each(['running', 'unknown', 'cancelling'])(
  'reopened %s inference cannot become a fresh input or approval while reconciliation is unresolved',
  async (state) => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-input-uncertain-'))
    let sends = 0
    const setup = fixture(directory, {
      engineFactory: async () => ({
        run: async () => {
          sends++
          return result
        },
        close: async () => {},
        cancel: async () => {},
      }),
    })
    let adapter = new PiDurableRuntimeAdapter(setup.options)
    try {
      const handle = await adapter.start(setup.request)
      await adapter.drain()
      const prior = adapter.journal.get(handle.handleId)
      adapter.journal.update(handle.handleId, prior.epoch, {
        state,
        detail: { ...prior.detail, result: undefined, inferencePending: true },
      })
      await adapter.close()
      adapter = new PiDurableRuntimeAdapter(setup.options)
      await adapter.reconcile(handle)
      const retained = adapter.journal.get(handle.handleId)
      const events = adapter.journal.events(handle.handleId, 0)
      await expect(adapter.awaitInput(handle, interactionId)).rejects.toThrow(
        'PI_RECONCILIATION_REQUIRED'
      )
      await expect(
        adapter.submitInput(handle, {
          interactionId,
          idempotencyKey: 'input:bypass',
          text: 'Unsafe new request',
        })
      ).rejects.toThrow()
      await expect(adapter.awaitApproval(handle, interactionId, 'effect:bypass')).rejects.toThrow(
        'PI_RECONCILIATION_REQUIRED'
      )
      await adapter.drain()
      expect(adapter.journal.get(handle.handleId)).toEqual(retained)
      expect(adapter.journal.events(handle.handleId, 0)).toEqual(events)
      expect(sends).toBe(1)
    } finally {
      await adapter.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test('retained pending input cannot clear unresolved inference or replace an outstanding approval', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-input-pending-fence-'))
  const setup = fixture(directory)
  let adapter = new PiDurableRuntimeAdapter(setup.options)
  try {
    const handle = await adapter.start(setup.request)
    await adapter.drain()
    await adapter.awaitInput(handle, interactionId)
    const pending = adapter.journal.get(handle.handleId)
    adapter.journal.update(handle.handleId, pending.epoch, {
      detail: { ...pending.detail, inferencePending: true },
    })
    await adapter.close()
    adapter = new PiDurableRuntimeAdapter(setup.options)
    const retained = adapter.journal.get(handle.handleId)
    await expect(
      adapter.submitInput(handle, {
        interactionId,
        idempotencyKey: 'input:unresolved',
        text: 'Unsafe input',
      })
    ).rejects.toThrow('PI_RECONCILIATION_REQUIRED')
    expect(adapter.journal.get(handle.handleId)).toEqual(retained)
    // A legitimate approval may be created once the prior inference has a committed resolution.
    adapter.journal.update(handle.handleId, retained.epoch, {
      detail: { ...retained.detail, inferencePending: false, pendingInput: undefined },
    })
    await adapter.awaitApproval(handle, interactionId, 'effect:pending')
    const approval = adapter.journal.get(handle.handleId)
    await expect(adapter.awaitInput(handle, interactionId)).rejects.toThrow(
      'PI_APPROVAL_NOT_RESOLVED'
    )
    expect(adapter.journal.get(handle.handleId)).toEqual(approval)
  } finally {
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('pending approval replay preserves its exact interaction and effect without replacing evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-approval-identity-fence-'))
  const setup = fixture(directory)
  const adapter = new PiDurableRuntimeAdapter(setup.options)
  try {
    const handle = await adapter.start(setup.request)
    await adapter.drain()
    await adapter.awaitApproval(handle, interactionId, 'effect:exact-pending')
    const retained = adapter.journal.get(handle.handleId)
    const events = adapter.journal.events(handle.handleId, 0)
    await expect(
      adapter.awaitApproval(handle, interactionId, 'effect:replacement')
    ).rejects.toThrow('PI_APPROVAL_IDENTITY_CONFLICT')
    await expect(
      adapter.awaitApproval(handle, 'int_01JABCDEF0123456789ABCDEFH', 'effect:exact-pending')
    ).rejects.toThrow('PI_APPROVAL_IDENTITY_CONFLICT')
    await adapter.awaitApproval(handle, interactionId, 'effect:exact-pending')
    expect(adapter.journal.get(handle.handleId)).toEqual(retained)
    expect(adapter.journal.events(handle.handleId, 0)).toEqual(events)
  } finally {
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('pending input replay keeps exact identity and cannot be replaced by input or approval', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-input-identity-fence-'))
  const setup = fixture(directory)
  const adapter = new PiDurableRuntimeAdapter(setup.options)
  try {
    const handle = await adapter.start(setup.request)
    await adapter.drain()
    await adapter.awaitInput(handle, interactionId)
    const retained = adapter.journal.get(handle.handleId)
    const events = adapter.journal.events(handle.handleId, 0)
    await expect(adapter.awaitInput(handle, 'int_01JABCDEF0123456789ABCDEFH')).rejects.toThrow(
      'PI_INPUT_IDENTITY_CONFLICT'
    )
    await expect(
      adapter.awaitApproval(handle, interactionId, 'effect:replace-input')
    ).rejects.toThrow('PI_INPUT_NOT_RESOLVED')
    await adapter.awaitInput(handle, interactionId)
    expect(adapter.journal.get(handle.handleId)).toEqual(retained)
    expect(adapter.journal.events(handle.handleId, 0)).toEqual(events)
  } finally {
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('cancelled attempts remain final after reopen and cannot reopen interaction gates', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-input-cancel-final-'))
  const setup = fixture(directory)
  let adapter = new PiDurableRuntimeAdapter(setup.options)
  try {
    const handle = await adapter.start(setup.request)
    await adapter.drain()
    await adapter.awaitInput(handle, interactionId)
    await adapter.cancel(handle, { idempotencyKey: 'cancel:final', requestedAt: at })
    await adapter.close()
    adapter = new PiDurableRuntimeAdapter(setup.options)
    const cancelled = adapter.journal.get(handle.handleId)
    await expect(adapter.awaitInput(handle, interactionId)).rejects.toThrow('PI_EXECUTION_TERMINAL')
    await expect(adapter.awaitApproval(handle, interactionId, 'effect:cancelled')).rejects.toThrow(
      'PI_EXECUTION_TERMINAL'
    )
    await expect(
      adapter.submitInput(handle, {
        interactionId,
        idempotencyKey: 'input:cancelled',
        text: 'Late input',
      })
    ).rejects.toThrow()
    expect(adapter.journal.get(handle.handleId)).toEqual(cancelled)
  } finally {
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('another process retaining a completed generation owner blocks new interaction claims', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-input-remote-owner-'))
  const setup = fixture(directory)
  const seed = new PiDurableRuntimeAdapter(setup.options)
  let worker, observer
  try {
    const handle = await seed.start(setup.request)
    await seed.drain()
    const prior = seed.journal.get(handle.handleId)
    seed.journal.update(handle.handleId, prior.epoch, { state: 'starting', detail: {} })
    await seed.close()
    const path = join(directory, 'owned-generation.mjs')
    writeFileSync(
      path,
      `
import { PiDurableRuntimeAdapter } from ${JSON.stringify(new URL('./adapter.ts', import.meta.url).href)};
setInterval(()=>{},1000);
const admission=${JSON.stringify(prior.admission.admission)};
const adapter=new PiDurableRuntimeAdapter({directory:${JSON.stringify(directory)},now:()=>${JSON.stringify(at)},
resolveAdmission:async()=>admission,assertAuthority:async()=>{},
resolveProvider:async()=>({...admission.selection,workspaceId:${JSON.stringify(setup.request.attemptBudget.workspaceId)},provider:'scripted',providerModel:'race-model',location:'remote_host',harness:'pi_durable',harnessVersion:'1.1.0',providerBinding:'pi_durable_models',withModels:async use=>use({})}),
authorizeInference:async()=>({maxOutputTokens:10,maximumInputTokens:64,assertActive:async()=>{}}),settleUsage:async(_authority,_key,usage)=>usage,reconcileInference:async()=> 'unresolved',
engineFactory:async()=>({run:async()=>(${JSON.stringify(result)}),cancel:async()=>{},close:async()=>{process.stdout.write(JSON.stringify({ownerPid:process.pid})+'\\n');await new Promise(()=>{});}})});
await adapter.start(${JSON.stringify(setup.request)});
await adapter.drain();
`
    )
    const overrideIndex = process.execArgv.indexOf('--tsconfig-override')
    const inlineOverride = process.execArgv
      .find((argument) => argument.startsWith('--tsconfig-override='))
      ?.slice('--tsconfig-override='.length)
    const sourceOverride =
      process.env.CONTROL_PLANE_TEST_TSCONFIG_OVERRIDE ??
      inlineOverride ??
      (overrideIndex < 0 ? undefined : process.execArgv[overrideIndex + 1]) ??
      writeRecoverySourceOverride(directory)
    const sourceResolution = ['--tsconfig-override', sourceOverride]
    worker = Bun.spawn([process.execPath, ...sourceResolution, path], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const readiness = worker.stdout.getReader()
    let output = ''
    while (!output.includes('\n')) {
      const next = await readiness.read()
      if (next.done) throw new Error(await new Response(worker.stderr).text())
      output += new TextDecoder().decode(next.value)
    }
    const owner = JSON.parse(output.trim())
    observer = new PiDurableRuntimeAdapter(setup.options)
    const retained = observer.journal.get(handle.handleId)
    expect(retained.state).toBe('completed')
    expect(retained.detail.inferencePending).toBe(false)
    expect(retained.detail.ownerPid).toBe(owner.ownerPid)
    expect(owner.ownerPid).not.toBe(process.pid)
    await expect(observer.awaitInput(handle, interactionId)).rejects.toThrow('PI_EXECUTION_BUSY')
    await expect(
      observer.awaitApproval(handle, interactionId, 'effect:other-process')
    ).rejects.toThrow('PI_EXECUTION_BUSY')
    expect(observer.journal.get(handle.handleId)).toEqual(retained)
    worker.kill()
    await worker.exited
    await observer.awaitInput(handle, interactionId)
    expect((await observer.status(handle)).state).toBe('awaiting_input')
  } finally {
    worker?.kill()
    if (worker) await worker.exited
    if (observer) await observer.close()
    await seed.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 10000)

test('input authority suspended across an unchanged-epoch inference marker cannot erase that marker', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-input-marker-race-'))
  const entered = deferred(),
    resume = deferred()
  let paused = false
  const setup = fixture(directory, {
    assertAuthority: async () => {
      if (paused) {
        entered.resolve()
        await resume.promise
      }
    },
  })
  const adapter = new PiDurableRuntimeAdapter(setup.options)
  const other = new PiDurableRuntimeAdapter(setup.options)
  try {
    const handle = await adapter.start(setup.request)
    await adapter.drain()
    await adapter.awaitInput(handle, interactionId)
    paused = true
    const submission = adapter.submitInput(handle, {
      interactionId,
      idempotencyKey: 'input:stale-marker',
      text: 'Unsafe replacement',
    })
    await entered.promise
    const current = other.journal.get(handle.handleId)
    const retained = other.journal.update(handle.handleId, current.epoch, {
      detail: { ...current.detail, inferencePending: true },
    })
    paused = false
    resume.resolve()
    await expect(submission).rejects.toThrow('PI_RUNTIME_STATE_CONFLICT')
    expect(adapter.journal.get(handle.handleId)).toEqual(retained)
  } finally {
    paused = false
    resume.resolve()
    await adapter.close()
    await other.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 10000)

test.each(['awaitInput', 'awaitApproval'])(
  'cross-instance cleanup at %s transaction entry cannot resurrect a closed session',
  async (operation) => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-interaction-close-transaction-'))
    const setup = fixture(directory)
    const adapter = new PiDurableRuntimeAdapter(setup.options)
    const other = new PiDurableRuntimeAdapter(setup.options)
    let cleanup, closed
    try {
      const handle = await adapter.start(setup.request)
      await adapter.drain()
      const events = adapter.journal.events(handle.handleId, 0)
      const exec = adapter.journal.database.exec.bind(adapter.journal.database)
      let armed = true
      // Two actual SQLite connections: cleanup wins at the old check/write gap.
      adapter.journal.database.exec = (sql) => {
        if (armed && sql === 'BEGIN IMMEDIATE') {
          armed = false
          cleanup = other.cleanup(handle)
          cleanup.catch(() => {})
          closed = other.journal.get(handle.handleId)
        }
        return exec(sql)
      }
      const mutation =
        operation === 'awaitInput'
          ? adapter.awaitInput(handle, interactionId)
          : adapter.awaitApproval(handle, interactionId, 'effect:closed-transaction')
      await expect(mutation).rejects.toThrow('PI_RUNTIME_STATE_CONFLICT')
      await cleanup
      expect(closed.detail.sessionClosed).toBe(true)
      expect(adapter.journal.get(handle.handleId)).toEqual(closed)
      expect(adapter.journal.events(handle.handleId, 0)).toEqual(events)
    } finally {
      if (cleanup) await cleanup
      await adapter.close()
      await other.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test('an interaction winner fences a close built from the prior terminal snapshot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-interaction-close-stale-'))
  const setup = fixture(directory)
  const adapter = new PiDurableRuntimeAdapter(setup.options)
  const other = new PiDurableRuntimeAdapter(setup.options)
  try {
    const handle = await adapter.start(setup.request)
    await adapter.drain()
    let deferredWrite
    const update = other.journal.update.bind(other.journal)
    other.journal.update = (...args) => {
      deferredWrite = () => update(...args)
      return other.journal.get(handle.handleId)
    }
    await other.cleanup(handle)
    other.journal.update = update
    await adapter.awaitInput(handle, interactionId)
    const pending = adapter.journal.get(handle.handleId)
    expect(() => deferredWrite()).toThrow('STALE_OWNER')
    await expect(
      other.session({ operation: 'close', sessionId: handle.externalSessionId })
    ).rejects.toThrow('PI_SESSION_BUSY')
    expect(adapter.journal.get(handle.handleId)).toEqual(pending)
    expect(pending.detail.sessionClosed).toBeUndefined()
  } finally {
    await adapter.close()
    await other.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('competing inputs from the same pending snapshot admit one exact turn and harmless retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-input-race-'))
  const arrivals = deferred(),
    release = deferred(),
    inputStarted = deferred(),
    finishInput = deferred()
  let barrier = false,
    waiting = 0,
    runs = 0
  const setup = fixture(directory, {
    assertAuthority: async () => {
      if (barrier) {
        if (++waiting === 2) arrivals.resolve()
        await release.promise
      }
    },
    engineFactory: async () => ({
      run: async () => {
        if (++runs === 2) {
          inputStarted.resolve()
          await finishInput.promise
        }
        return result
      },
      close: async () => {},
      cancel: async () => {},
    }),
  })
  const adapter = new PiDurableRuntimeAdapter(setup.options)
  try {
    const handle = await adapter.start(setup.request)
    await adapter.drain()
    await adapter.awaitInput(handle, interactionId)
    const inputs = [
      { interactionId, idempotencyKey: 'input:one', text: 'First exact input' },
      { interactionId, idempotencyKey: 'input:two', text: 'Second exact input' },
    ]
    barrier = true
    const contenders = inputs.map((input) => adapter.submitInput(handle, input))
    await arrivals.promise
    barrier = false
    release.resolve()
    const settled = await Promise.allSettled(contenders)
    const winner = settled.findIndex((item) => item.status === 'fulfilled')
    const loser = 1 - winner
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(settled[loser].reason.message).toBe('PI_RUNTIME_STATE_CONFLICT')
    await inputStarted.promise
    const retained = adapter.journal.get(handle.handleId)
    expect(retained.detail.turn).toEqual({
      requestId: `pi-input:${handle.attemptId}:${inputs[winner].idempotencyKey}`,
      input: inputs[winner].text,
    })
    expect(retained.detail.actions).toEqual({
      [inputs[winner].idempotencyKey]:
        `sha256:${createHash('sha256').update(canonicalJsonStringify(inputs[winner])).digest('hex')}`,
    })
    await adapter.submitInput(handle, inputs[winner])
    await expect(adapter.submitInput(handle, inputs[loser])).rejects.toThrow('PI_INPUT_NOT_PENDING')
    expect(runs).toBe(2)
    finishInput.resolve()
    await adapter.drain()
    await adapter.submitInput(handle, inputs[winner])
    expect(runs).toBe(2)
  } finally {
    release.resolve()
    finishInput.resolve()
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 10000)

test('awaitApproval commits one approval snapshot without transient input and reopens exact effect identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-approval-atomic-'))
  const setup = fixture(directory)
  let adapter = new PiDurableRuntimeAdapter(setup.options)
  try {
    const handle = await adapter.start(setup.request)
    await adapter.drain()
    const snapshots = []
    const transition = adapter.journal.transition.bind(adapter.journal)
    adapter.journal.transition = (...args) => {
      const value = transition(...args)
      snapshots.push(adapter.journal.get(handle.handleId))
      return value
    }
    const before = adapter.journal.events(handle.handleId, 0)
    const effectIdentity = `effect:sha256:${'b'.repeat(64)}`
    await adapter.awaitApproval(handle, interactionId, effectIdentity)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].state).toBe('awaiting_input')
    expect(snapshots[0].detail.pendingInput).toBeUndefined()
    expect(snapshots[0].detail.pendingApproval).toEqual({ interactionId, effectIdentity })
    const committed = adapter.journal.events(handle.handleId, 0)
    expect(committed.slice(before.length).map((event) => event.data)).toEqual([
      { interactionId, kind: 'approval', effectIdentity },
    ])
    await adapter.close()
    let verifiedEffect
    adapter = new PiDurableRuntimeAdapter({
      ...setup.options,
      verifyApproval: async (_authority, identity) => {
        verifiedEffect = identity
        return true
      },
    })
    expect(adapter.journal.get(handle.handleId).detail.pendingApproval).toEqual({
      interactionId,
      effectIdentity,
    })
    expect(adapter.journal.events(handle.handleId, 0)).toEqual(committed)
    await adapter.submitApproval(handle, {
      interactionId,
      idempotencyKey: 'approval:exact',
      decision: 'approve',
    })
    expect(verifiedEffect).toBe(effectIdentity)
  } finally {
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('cancel fences an in-flight owner, releases its original token, and reconciles without resending', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-cancel-owner-'))
  const started = deferred(),
    finish = deferred()
  let engines = 0,
    sends = 0,
    cancellations = 0,
    safety = 'unresolved'
  const setup = fixture(directory, {
    engineFactory: async () => {
      engines++
      return {
        run: async () => {
          sends++
          started.resolve()
          await finish.promise
          return result
        },
        close: async () => {},
        cancel: async () => {
          cancellations++
        },
      }
    },
    reconcileInference: async () => safety,
  })
  const adapter = new PiDurableRuntimeAdapter(setup.options)
  try {
    const handle = await adapter.start(setup.request)
    await started.promise
    const owned = adapter.journal.get(handle.handleId)
    expect(owned.detail.ownerEpoch).toBe(owned.epoch)
    expect(
      (await adapter.cancel(handle, { idempotencyKey: 'cancel:in-flight', requestedAt: at })).state
    ).toBe('cancelling')
    const fenced = adapter.journal.get(handle.handleId)
    expect(fenced.epoch).toBeGreaterThan(owned.epoch)
    expect(fenced.detail.ownerEpoch).toBe(owned.epoch)
    finish.resolve()
    await adapter.drain()
    const released = adapter.journal.get(handle.handleId)
    expect(released.detail.ownerPid).toBeUndefined()
    expect(released.detail.ownerEpoch).toBeUndefined()
    expect(released.state).toBe('cancelling')
    expect((await adapter.reconcile(handle)).state).toBe('cancelling')
    safety = 'safe_to_resume'
    expect((await adapter.reconcile(handle)).state).toBe('cancelled')
    await adapter.drain()
    expect({ engines, sends, cancellations }).toEqual({ engines: 1, sends: 1, cancellations: 1 })
    await adapter.cleanup(handle)
    expect(adapter.journal.get(handle.handleId).detail.cleanupComplete).toBe(true)
  } finally {
    finish.resolve()
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 10000)

test('composition startup isolates revoked retained work and recovers the next valid execution', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-recovery-isolation-'))
  const setup = fixture(directory)
  const seed = new PiDurableRuntimeAdapter(setup.options)
  let runtime
  try {
    const first = await seed.start(setup.request)
    await seed.drain()
    const executionId = 'exe_01JBBCDEF0123456789ABCDEFG',
      attemptId = 'att_01JBBCDEF0123456789ABCDEFG'
    const second = await seed.start({
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
    await seed.drain()
    // Simulate retained interrupted generations after a store restart, independently of transport.
    const retained = seed.journal.list()
    for (const row of retained)
      seed.journal.update(row.handleId, row.epoch, {
        state: 'running',
        detail: { inferencePending: true },
      })
    const revoked = retained[0],
      valid = retained[1]
    await seed.close()
    let engines = 0,
      sends = 0
    const authorities = []
    runtime = await createNodePiDurableRuntime({
      ...setup.options,
      assertAuthority: async (authority) => {
        authorities.push(authority.request.attemptId)
        if (authority.request.attemptId === revoked.attemptId)
          throw new Error('secret-revoked-grant')
      },
      reconcileInference: async () => 'safe_to_resume',
      engineFactory: async () => {
        engines++
        return {
          run: async () => {
            sends++
            return result
          },
          close: async () => {},
          cancel: async () => {},
        }
      },
    })
    await runtime.adapter.drain()
    expect(authorities[0]).toBe(revoked.attemptId)
    expect(authorities).toContain(valid.attemptId)
    expect(runtime.recoveryBlocked).toEqual([
      { handleId: revoked.handleId, code: 'PI_RECOVERY_AUTHORITY_BLOCKED' },
    ])
    expect(JSON.stringify(runtime.recoveryBlocked)).not.toContain('secret-revoked-grant')
    expect(runtime.adapter.journal.get(revoked.handleId).state).toBe('running')
    expect(runtime.adapter.journal.get(valid.handleId).state).toBe('completed')
    expect((await runtime.adapter.inspect()).health).toBe('healthy')
    expect((await runtime.adapter.status(first)).handle).toEqual(first)
    expect((await runtime.adapter.status(second)).handle).toEqual(second)
    await runtime.recover()
    await runtime.adapter.drain()
    expect({ engines, sends }).toEqual({ engines: 1, sends: 1 })
    expect(runtime.recoveryBlocked).toHaveLength(1)
  } finally {
    if (runtime) await runtime.close()
    else {
      try {
        await seed.close()
      } catch {}
    }
    rmSync(directory, { recursive: true, force: true })
  }
}, 10000)

test('cancellation intent is committed before an immediate abort settles the running engine', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-cancel-immediate-'))
  const started = deferred(),
    finish = deferred()
  const cancel = { idempotencyKey: 'cancel:immediate-abort', requestedAt: at }
  let adapter,
    handle,
    abortSnapshot,
    cancellations = 0
  const setup = fixture(directory, {
    engineFactory: async () => ({
      run: async () => {
        started.resolve()
        await finish.promise
        return result
      },
      close: async () => {},
      cancel: async () => {
        cancellations++
        abortSnapshot = adapter.journal.get(handle.handleId)
        // Reject run before cancel's awaited work finishes, exercising its stale catch/finally.
        finish.reject(new Error('scripted-immediate-abort'))
        await adapter.drain()
        throw new Error('secret-abort-diagnostic')
      },
    }),
  })
  adapter = new PiDurableRuntimeAdapter(setup.options)
  try {
    handle = await adapter.start(setup.request)
    await started.promise
    const original = adapter.journal.get(handle.handleId)
    expect((await adapter.cancel(handle, cancel)).state).toBe('cancelling')
    expect(abortSnapshot.state).toBe('cancelling')
    expect(abortSnapshot.epoch).toBeGreaterThan(original.epoch)
    const action = `sha256:${createHash('sha256').update(canonicalJsonStringify(cancel)).digest('hex')}`
    expect(abortSnapshot.detail.actions).toEqual({ [`cancel:${cancel.idempotencyKey}`]: action })
    const retained = adapter.journal.get(handle.handleId)
    expect(retained.detail.actions).toEqual(abortSnapshot.detail.actions)
    expect(retained.detail.ownerEpoch).toBeUndefined()
    expect(
      adapter.journal.events(handle.handleId, 0).some((event) => event.data.state === 'unknown')
    ).toBe(false)
    expect((await adapter.cancel(handle, cancel)).state).toBe('cancelling')
    expect(cancellations).toBe(1)
    expect(JSON.stringify(await adapter.status(handle))).not.toContain('secret-abort-diagnostic')
    await adapter.close()
    adapter = new PiDurableRuntimeAdapter(setup.options)
    expect((await adapter.cancel(handle, cancel)).state).toBe('cancelling')
    expect(adapter.journal.get(handle.handleId).detail.actions).toEqual(
      abortSnapshot.detail.actions
    )
    expect(cancellations).toBe(1)
  } finally {
    finish.resolve()
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 10000)

test('a stale safe reconciliation cannot create an engine after concurrent cancellation wins', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-reconcile-cancel-'))
  const reconciling = deferred(),
    safe = deferred()
  let engines = 0,
    sends = 0
  const setup = fixture(directory, {
    engineFactory: async () => {
      engines++
      return {
        run: async () => {
          sends++
          return result
        },
        close: async () => {},
        cancel: async () => {},
      }
    },
    reconcileInference: async () => {
      reconciling.resolve()
      return safe.promise
    },
  })
  const adapter = new PiDurableRuntimeAdapter(setup.options)
  try {
    const handle = await adapter.start(setup.request)
    await adapter.drain()
    engines = 0
    sends = 0
    const completed = adapter.journal.get(handle.handleId)
    // Reconciliation may safely consider an unknown receipt with no outstanding physical send.
    adapter.journal.update(handle.handleId, completed.epoch, {
      state: 'unknown',
      detail: { inferencePending: false },
    })
    const recovery = adapter.reconcile(handle)
    await reconciling.promise
    const cancel = { idempotencyKey: 'cancel:reconcile-race', requestedAt: at }
    expect((await adapter.cancel(handle, cancel)).state).toBe('cancelled')
    const cancelled = adapter.journal.get(handle.handleId)
    safe.resolve('safe_to_resume')
    expect((await recovery).state).toBe('cancelled')
    await adapter.drain()
    expect({ engines, sends }).toEqual({ engines: 0, sends: 0 })
    const retained = adapter.journal.get(handle.handleId)
    expect(retained).toEqual(cancelled)
    expect(retained.detail.ownerPid).toBeUndefined()
    expect(retained.detail.ownerEpoch).toBeUndefined()
    expect((await adapter.cancel(handle, cancel)).state).toBe('cancelled')
    await adapter.cleanup(handle)
    expect(adapter.journal.get(handle.handleId).detail.cleanupComplete).toBe(true)
  } finally {
    safe.resolve('safe_to_resume')
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 10000)

test('reconcile leaves a run to the live process that owns it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-reconcile-live-owner-'))
  const owner = Bun.spawn(['sleep', '60'])
  let reconciliations = 0
  const setup = fixture(directory, {
    reconcileInference: async () => {
      reconciliations++
      return 'safe_to_resume'
    },
  })
  const adapter = new PiDurableRuntimeAdapter(setup.options)
  try {
    const handle = await adapter.start(setup.request)
    await adapter.drain()
    const prior = adapter.journal.get(handle.handleId)
    adapter.journal.update(handle.handleId, prior.epoch, {
      state: 'running',
      detail: { ...prior.detail, result: undefined, ownerPid: owner.pid, ownerEpoch: prior.epoch },
    })
    const owned = adapter.journal.get(handle.handleId)
    expect((await adapter.reconcile(handle)).state).toBe('running')
    expect(reconciliations).toBe(0)
    expect(adapter.journal.get(handle.handleId)).toEqual(owned)
  } finally {
    owner.kill()
    await owner.exited
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a claim handed to a run that fails validation is released and cannot wedge later recovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-reconcile-validation-release-'))
  let adapter
  let handle
  let stored
  let corrupt = true
  const setup = fixture(directory, {
    reconcileInference: async () => {
      if (corrupt) {
        corrupt = false
        // Corrupt the stored admission after reconcile has validated it and before its claim, so
        // reconcile's validation of the run it is about to start fails while it holds the claim.
        const row = adapter.journal.database
          .prepare('SELECT body FROM pi_admissions WHERE handle_id=?')
          .get(handle.handleId)
        stored = row.body
        const record = JSON.parse(row.body)
        record.admission.providerDigest = 'sha256:invalid'
        adapter.journal.database
          .prepare('UPDATE pi_admissions SET body=? WHERE handle_id=?')
          .run(JSON.stringify(record), handle.handleId)
      }
      return 'safe_to_resume'
    },
  })
  adapter = new PiDurableRuntimeAdapter(setup.options)
  try {
    handle = await adapter.start(setup.request)
    await adapter.drain()
    const prior = adapter.journal.get(handle.handleId)
    adapter.journal.update(handle.handleId, prior.epoch, {
      state: 'running',
      detail: { ...prior.detail, result: undefined, ownerPid: undefined, ownerEpoch: undefined },
    })
    // The corrupted admission fails reconcile's validation of the run it is about to start, so
    // reconcile rejects and the claim it holds must be given back before the error propagates.
    await expect(adapter.reconcile(handle)).rejects.toThrow('PI_JOURNAL_AUTHORITY_INVALID')
    await adapter.drain()
    const failed = adapter.journal.get(handle.handleId)
    expect(failed.state).toBe('running')
    expect(failed.detail.ownerPid).toBeUndefined()
    expect(failed.detail.ownerEpoch).toBeUndefined()
    adapter.journal.database
      .prepare('UPDATE pi_admissions SET body=? WHERE handle_id=?')
      .run(stored, handle.handleId)
    await adapter.reconcile(handle)
    await adapter.drain()
    expect(adapter.journal.get(handle.handleId).state).toBe('completed')
    expect(adapter.journal.get(handle.handleId).detail.ownerPid).toBeUndefined()
  } finally {
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('shutdown fences start paused at every asynchronous admission boundary', async () => {
  for (const boundary of ['resolveAdmission', 'assertAuthority', 'resolveProvider']) {
    const directory = mkdtempSync(join(tmpdir(), 'pi-close-admission-'))
    const entered = deferred(),
      resume = deferred()
    let engines = 0
    const setup = fixture(directory, {
      engineFactory: async () => {
        engines++
        throw new Error('unexpected engine')
      },
    })
    const original = setup.options[boundary]
    setup.options[boundary] = async (...args) => {
      entered.resolve()
      await resume.promise
      return original(...args)
    }
    const adapter = new PiDurableRuntimeAdapter(setup.options)
    let reopened
    try {
      const admission = adapter.start(setup.request)
      await entered.promise
      await adapter.close()
      resume.resolve()
      await expect(admission).rejects.toThrow('PI_ADAPTER_CLOSED')
      expect(engines).toBe(0)
      reopened = new PiDurableRuntimeAdapter(fixture(directory).options)
      expect(reopened.journal.list()).toEqual([])
    } finally {
      resume.resolve()
      await adapter.close()
      if (reopened) await reopened.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}, 10000)

test('shutdown denies public mutations paused in authority, approval or reconciliation without changing retained records', async () => {
  for (const operation of [
    'awaitInput',
    'awaitApproval',
    'submitInput',
    'submitApproval:authority',
    'submitApproval:verifier',
    'cancel',
    'reconcile:authority',
    'reconcile:proof',
  ]) {
    const directory = mkdtempSync(join(tmpdir(), 'pi-close-mutation-'))
    const entered = deferred(),
      resume = deferred()
    let paused = false
    const gate = async () => {
      if (paused) {
        entered.resolve()
        await resume.promise
      }
    }
    const setup = fixture(directory, {
      assertAuthority: async () => {
        if (!operation.endsWith(':verifier') && !operation.endsWith(':proof')) await gate()
      },
      verifyApproval: async () => {
        if (operation.endsWith(':verifier')) await gate()
        return true
      },
      reconcileInference: async () => {
        if (operation.endsWith(':proof')) await gate()
        return 'safe_to_resume'
      },
    })
    const adapter = new PiDurableRuntimeAdapter(setup.options)
    let reopened
    try {
      const handle = await adapter.start(setup.request)
      await adapter.drain()
      if (operation === 'submitInput' || operation === 'cancel')
        await adapter.awaitInput(handle, interactionId)
      if (operation.startsWith('submitApproval'))
        await adapter.awaitApproval(handle, interactionId, 'effect:close-boundary')
      if (operation.startsWith('reconcile')) {
        const row = adapter.journal.get(handle.handleId)
        adapter.journal.update(handle.handleId, row.epoch, {
          state: 'unknown',
          detail: { inferencePending: false },
        })
      }
      const before = adapter.journal.get(handle.handleId)
      const events = adapter.journal.events(handle.handleId, 0)
      paused = true
      let mutation
      switch (operation.split(':')[0]) {
        case 'awaitInput':
          mutation = adapter.awaitInput(handle, interactionId)
          break
        case 'awaitApproval':
          mutation = adapter.awaitApproval(handle, interactionId, 'effect:close-boundary')
          break
        case 'submitInput':
          mutation = adapter.submitInput(handle, {
            interactionId,
            idempotencyKey: 'input:closing',
            text: 'Late input',
          })
          break
        case 'submitApproval':
          mutation = adapter.submitApproval(handle, {
            interactionId,
            idempotencyKey: 'approval:closing',
            decision: 'approve',
          })
          break
        case 'cancel':
          mutation = adapter.cancel(handle, { idempotencyKey: 'cancel:closing', requestedAt: at })
          break
        case 'reconcile':
          mutation = adapter.reconcile(handle)
          break
      }
      await entered.promise
      await adapter.close()
      resume.resolve()
      await expect(mutation).rejects.toThrow('PI_ADAPTER_CLOSED')
      reopened = new PiDurableRuntimeAdapter(fixture(directory).options)
      expect(reopened.journal.get(handle.handleId)).toEqual(before)
      expect(reopened.journal.events(handle.handleId, 0)).toEqual(events)
    } finally {
      resume.resolve()
      await adapter.close()
      if (reopened) await reopened.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}, 10000)

test('concurrent close shares one drain and store close while admitted inference still completes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-close-active-'))
  const started = deferred(),
    finish = deferred()
  let engineCloses = 0,
    storeCloses = 0,
    settlements = 0,
    lateAuthorityChecks = 0
  const setup = fixture(directory, {
    engineFactory: async (ports) => ({
      run: async () => {
        started.resolve()
        await finish.promise
        await ports.assertAuthority()
        await ports.authorizeInference({ inferenceId: 'pi-generation:1' })
        lateAuthorityChecks++
        return result
      },
      close: async () => {
        engineCloses++
      },
      cancel: async () => {
        throw new Error('shutdown must not cancel admitted work')
      },
    }),
    settleUsage: async (_authority, _key, usage) => {
      settlements++
      return usage
    },
  })
  const adapter = new PiDurableRuntimeAdapter(setup.options)
  const closeStore = adapter.journal.close.bind(adapter.journal)
  adapter.journal.close = () => {
    storeCloses++
    closeStore()
  }
  let reopened
  try {
    const handle = await adapter.start(setup.request)
    await started.promise
    const firstClose = adapter.close(),
      secondClose = adapter.close()
    expect(secondClose).toBe(firstClose)
    expect(storeCloses).toBe(0)
    expect((await adapter.inspect()).health).toBe('unavailable')
    const calls = [
      () => adapter.start(setup.request),
      () => adapter.awaitInput(handle, interactionId),
      () => adapter.awaitApproval(handle, interactionId, 'effect:closed'),
      () =>
        adapter.submitInput(handle, {
          interactionId,
          idempotencyKey: 'input:closed',
          text: 'Late input',
        }),
      () =>
        adapter.submitApproval(handle, {
          interactionId,
          idempotencyKey: 'approval:closed',
          decision: 'approve',
        }),
      () => adapter.cancel(handle, { idempotencyKey: 'cancel:closed', requestedAt: at }),
      () => adapter.session({ operation: 'create', idempotencyKey: 'session:closed' }),
      () => adapter.session({ operation: 'list' }),
      () => adapter.session({ operation: 'close', sessionId: handle.externalSessionId }),
      () => adapter.cleanup(handle),
      () => adapter.status(handle),
      () => adapter.reconcile(handle),
      () => adapter.progress(handle).next(),
    ]
    for (const call of calls) await expect(call()).rejects.toThrow('PI_ADAPTER_CLOSED')
    finish.resolve()
    await Promise.all([firstClose, secondClose])
    expect(adapter.close()).toBe(firstClose)
    expect({ storeCloses, engineCloses, settlements, lateAuthorityChecks }).toEqual({
      storeCloses: 1,
      engineCloses: 1,
      settlements: 1,
      lateAuthorityChecks: 1,
    })
    for (const call of calls) await expect(call()).rejects.toThrow('PI_ADAPTER_CLOSED')
    reopened = new PiDurableRuntimeAdapter(fixture(directory).options)
    expect((await reopened.status(handle)).state).toBe('completed')
    expect((await reopened.status(handle)).result.output).toEqual({ text: result.text })
    expect(reopened.journal.list()).toHaveLength(1)
  } finally {
    finish.resolve()
    await adapter.close()
    if (reopened) await reopened.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 10000)
