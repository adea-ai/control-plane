import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { RuntimeAdapterError } from '@control-plane/runtime-sdk'
import { PiDurableRuntimeAdapter } from './adapter.ts'
import { authoritativeDenial } from './authority-outcome.ts'
import { createNodePiDurableRuntime } from './composition.ts'
import { at, fixture, result, writeRecoverySourceOverride } from './recovery-races.fixture.mjs'
import { createSubprocessFixtureProbe } from './subprocess-fixture-data.fixture.mjs'

const interactionId = 'int_01JABCDEF0123456789ABCDEFG'
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

test('physical send journal advances prepared to armed once and fences a cancelled owner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-physical-dispatch-'))
  const admitted = deferred()
  const finish = deferred()
  const setup = fixture(directory, {
    engineFactory: async (engine) => ({
      run: async () => {
        const allowance = await engine.authorizeInference({
          sessionId: 'session',
          inferenceId: 'pi-generation:1',
          provider: 'scripted',
          modelId: 'race-model',
        })
        admitted.resolve(allowance)
        await finish.promise
        return result
      },
      close: async () => {},
      cancel: async () => {},
    }),
  })
  const adapter = new PiDurableRuntimeAdapter(setup.options)
  try {
    const handle = await adapter.start(setup.request)
    const allowance = await admitted.promise
    const digest = `sha256:${'a'.repeat(64)}`
    await expect(allowance.armPhysicalSend(digest)).rejects.toThrow('PI_PHYSICAL_SEND_NOT_PREPARED')
    await allowance.preparePhysicalSend(digest)
    const prepared = adapter.journal.get(handle.handleId)
    const key = prepared.detail.activeInference.inferenceKey
    expect(prepared.detail.physicalDispatches[key]).toMatchObject({
      stage: 'prepared',
      attemptId: setup.request.attemptId,
      requestDigest: digest,
      providerDigest: prepared.detail.physicalDispatches[key].providerDigest,
      ownerEpoch: prepared.epoch,
    })
    await allowance.armPhysicalSend(digest)
    expect(adapter.journal.get(handle.handleId).detail.physicalDispatches[key].stage).toBe('armed')
    await expect(allowance.preparePhysicalSend(digest)).rejects.toThrow(
      'PI_PHYSICAL_SEND_ALREADY_ARMED_OR_CHANGED'
    )
    await adapter.cancel(handle, { idempotencyKey: 'cancel:physical', requestedAt: at })
    await expect(allowance.armPhysicalSend(digest)).rejects.toThrow()
    expect(adapter.journal.get(handle.handleId).detail.physicalDispatches[key].stage).toBe('armed')
    finish.resolve()
    await adapter.drain()
  } finally {
    finish.resolve()
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test.each(['prepared', 'armed'])(
  'the %s physical send marker remains unresolved without restore-generation proof',
  async (stage) => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-armed-recovery-'))
    let runs = 0
    let noSendGuesses = 0
    const setup = fixture(directory, {
      reconcileInference: async () => {
        noSendGuesses++
        return 'safe_to_resume'
      },
      engineFactory: async (engine) => ({
        run: async () => {
          runs++
          const allowance = await engine.authorizeInference({
            sessionId: 'session',
            inferenceId: 'pi-generation:1',
            provider: 'scripted',
            modelId: 'race-model',
          })
          const digest = `sha256:${'b'.repeat(64)}`
          await allowance.preparePhysicalSend(digest)
          if (stage === 'armed') await allowance.armPhysicalSend(digest)
          throw new Error('PROVIDER_OUTCOME_UNKNOWN')
        },
        close: async () => {},
        cancel: async () => {},
      }),
    })
    const adapter = new PiDurableRuntimeAdapter(setup.options)
    try {
      const handle = await adapter.start(setup.request)
      await adapter.drain()
      expect((await adapter.status(handle)).state).toBe('unknown')
      expect((await adapter.reconcile(handle)).state).toBe('unknown')
      await adapter.drain()
      expect(runs).toBe(1)
      expect(noSendGuesses).toBe(0)
    } finally {
      await adapter.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

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
  const probe = createSubprocessFixtureProbe()
  const resolveAdmission = setup.options.resolveAdmission
  setup.options.resolveAdmission = async (...args) => ({
    ...(await resolveAdmission(...args)),
    prompt: probe,
  })
  const seed = new PiDurableRuntimeAdapter(setup.options)
  let worker, observer
  try {
    const handle = await seed.start(setup.request)
    await seed.drain()
    const prior = seed.journal.get(handle.handleId)
    expect(prior.admission.admission.prompt).toBe(probe)
    seed.journal.update(handle.handleId, prior.epoch, { state: 'starting', detail: {} })
    await seed.close()
    const inputPath = join(directory, 'owned-generation-input.json')
    const roundTripProbe =
      'quote:"; backslash:\\; newline:\n; tab:\t; NUL:\0; separators:\u2028\u2029; </script>; ${globalThis.__probe}'
    writeFileSync(
      inputPath,
      JSON.stringify({
        admission: prior.admission.admission,
        at,
        directory,
        probe,
        request: setup.request,
        result,
        roundTripProbe,
        workspaceId: setup.request.attemptBudget.workspaceId,
      }),
      { mode: 0o600 }
    )
    const childFixture = fileURLToPath(new URL('./recovery-races-owner.child.mjs', import.meta.url))
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
    worker = Bun.spawn([process.execPath, ...sourceResolution, childFixture, inputPath], {
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
    expect(owner.probe).toBe(probe)
    expect(owner.admissionPrompt).toBe(probe)
    expect(owner.roundTripProbe).toBe(roundTripProbe)
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
          throw authoritativeDenial(new Error('PI_CANONICAL_AUTHORITY_REJECTED'))
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
    // The declared denial is persisted under its own claim: marker set, epoch advanced once.
    const persisted = runtime.adapter.journal.get(revoked.handleId)
    expect(persisted.detail.recoveryBlocked).toBe('PI_RECOVERY_AUTHORITY_BLOCKED')
    expect(persisted.epoch).toBe(revoked.epoch + 2)
    expect(persisted.detail.ownerPid).toBeUndefined()
    expect(persisted.state).toBe('running')
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
    // The stale reconciliation held this process's durable owner claim while it probed, so the
    // cancelled snapshot carries those owner fields. The claim is released; nothing else changes.
    expect(cancelled.detail.ownerPid).toBe(process.pid)
    safe.resolve('safe_to_resume')
    expect((await recovery).state).toBe('cancelled')
    await adapter.drain()
    expect({ engines, sends }).toEqual({ engines: 0, sends: 0 })
    const retained = adapter.journal.get(handle.handleId)
    const {
      ownerPid: _pid,
      ownerEpoch: _epoch,
      ownerClaimId: _claim,
      ...cancelledDetail
    } = cancelled.detail
    expect(retained).toEqual({ ...cancelled, detail: cancelledDetail })
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

test('a late recovery result cannot write or schedule after its numeric claim epoch is reissued to a new token', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-reconcile-reissued-claim-'))
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
  let replacementClaim
  let handleId
  try {
    const handle = await adapter.start(setup.request)
    handleId = handle.handleId
    await adapter.drain()
    engines = 0
    sends = 0
    const completed = adapter.journal.get(handle.handleId)
    adapter.journal.update(handle.handleId, completed.epoch, {
      state: 'unknown',
      detail: { inferencePending: false },
    })

    const recovery = adapter.reconcile(handle)
    await reconciling.promise
    const oldRecord = adapter.journal.get(handle.handleId)
    const oldClaim = {
      epoch: oldRecord.epoch,
      ownerPid: oldRecord.detail.ownerPid,
      ownerEpoch: oldRecord.detail.ownerEpoch,
      claimId: oldRecord.detail.ownerClaimId,
    }
    adapter.journal.releaseRecoveryClaim(handle.handleId, oldClaim)
    replacementClaim = adapter.journal.claimProcess(handle.handleId, {
      epoch: oldClaim.epoch - 1,
      state: oldRecord.state,
    })
    expect(replacementClaim.epoch).toBe(oldClaim.epoch)
    expect(replacementClaim.claimId).not.toBe(oldClaim.claimId)
    const replacementOwned = adapter.journal.get(handle.handleId)
    const events = adapter.journal.events(handle.handleId, 0)

    safe.resolve('safe_to_resume')
    await recovery
    await adapter.drain()

    expect({ engines, sends }).toEqual({ engines: 0, sends: 0 })
    expect(adapter.journal.get(handle.handleId)).toEqual(replacementOwned)
    expect(adapter.journal.events(handle.handleId, 0)).toEqual(events)
    expect(adapter.journal.holdsProcessClaim(handle.handleId, replacementClaim)).toBe(true)
  } finally {
    safe.resolve('safe_to_resume')
    if (replacementClaim && handleId) adapter.journal.releaseProcess(handleId, replacementClaim)
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 10000)

test('recovery rechecks expiry after its final awaited authority callback', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-reconcile-late-expiry-'))
  const authorityEntered = deferred(),
    finishAuthority = deferred()
  let now = at
  let authorityChecks = 0
  let engineStarts = 0
  const setup = fixture(directory, {
    now: () => now,
    assertRecoveryAuthority: async () => {
      authorityChecks++
      if (authorityChecks === 2) {
        authorityEntered.resolve()
        await finishAuthority.promise
      }
    },
    reconcileInference: async () => 'safe_to_resume',
    engineFactory: async () => {
      engineStarts++
      return { run: async () => result, close: async () => {}, cancel: async () => {} }
    },
  })
  let adapter = new PiDurableRuntimeAdapter(setup.options)
  try {
    const handle = await adapter.start(setup.request)
    await adapter.drain()
    engineStarts = 0
    const completed = adapter.journal.get(handle.handleId)
    adapter.journal.update(handle.handleId, completed.epoch, {
      state: 'unknown',
      detail: { inferencePending: false },
    })
    await adapter.close()

    adapter = new PiDurableRuntimeAdapter(setup.options)
    const retained = adapter.journal.get(handle.handleId)
    const recovery = adapter.reconcile(handle)
    await authorityEntered.promise
    now = '2027-01-01T00:00:00.000Z'
    finishAuthority.resolve()

    await expect(recovery).rejects.toThrow('PI_AUTHORITY_EXPIRED')
    await adapter.drain()
    expect(engineStarts).toBe(0)
    expect(adapter.journal.get(handle.handleId)).toEqual({
      ...retained,
      epoch: retained.epoch + 2,
      detail: {
        ...retained.detail,
        recoveryBlocked: 'PI_RECOVERY_AUTHORITY_BLOCKED',
      },
    })
  } finally {
    finishAuthority.resolve()
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
  let storedProviderDigest
  let engineFactories = 0
  let engineRuns = 0
  let corrupt = true
  const setup = fixture(directory, {
    engineFactory: async () => {
      engineFactories++
      return {
        run: async () => {
          engineRuns++
          return result
        },
        close: async () => {},
        cancel: async () => {},
      }
    },
    reconcileInference: async () => {
      if (corrupt) {
        corrupt = false
        // Corrupt the stored admission after reconcile has validated it and before its claim, so
        // reconcile's validation of the run it is about to start fails while it holds the claim.
        const row = adapter.journal.database
          .prepare('SELECT body FROM pi_admissions WHERE handle_id=?')
          .get(handle.handleId)
        const record = JSON.parse(row.body)
        storedProviderDigest = record.admission.providerDigest
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
    const runsBeforeRecovery = engineRuns
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
    expect(failed.state).toBe('unknown')
    expect(failed.detail.reasonCode).toBe('PI_RUN_ABORTED_BEFORE_DRIVE')
    expect(failed.detail.ownerPid).toBeUndefined()
    expect(failed.detail.ownerEpoch).toBeUndefined()
    expect(engineFactories).toBe(1)
    expect(engineRuns).toBe(runsBeforeRecovery)
    const repaired = adapter.journal.get(handle.handleId)
    repaired.admission.providerDigest = storedProviderDigest
    adapter.journal.database
      .prepare('UPDATE pi_admissions SET body=? WHERE handle_id=?')
      .run(JSON.stringify(repaired), handle.handleId)
    const restored = adapter.journal.get(handle.handleId)
    expect(restored.state).toBe('unknown')
    expect(restored.detail.ownerPid).toBeUndefined()
    expect(restored.detail.ownerEpoch).toBeUndefined()
    await adapter.reconcile(handle)
    await adapter.drain()
    expect(engineFactories).toBe(2)
    expect(engineRuns).toBe(runsBeforeRecovery + 1)
    expect(adapter.journal.get(handle.handleId).state).toBe('completed')
    expect(adapter.journal.get(handle.handleId).detail.ownerPid).toBeUndefined()
  } finally {
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('recovery stops before engine start when the retained admission changes after preflight', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-reconcile-admission-mutation-'))
  let adapter
  let handle
  let mutateOnProviderResolution = false
  let engineFactories = 0
  let engineRuns = 0
  const setup = fixture(directory, {
    reconcileInference: async () => 'safe_to_resume',
    engineFactory: async () => {
      engineFactories++
      return {
        run: async () => {
          engineRuns++
          return result
        },
        close: async () => {},
        cancel: async () => {},
      }
    },
  })
  const resolveProvider = setup.options.resolveProvider
  setup.options.resolveProvider = async (...args) => {
    const provider = await resolveProvider(...args)
    if (mutateOnProviderResolution) {
      mutateOnProviderResolution = false
      const record = adapter.journal.get(handle.handleId)
      record.admission.admission.prompt = 'Changed after recovery preflight'
      adapter.journal.database
        .prepare('UPDATE pi_admissions SET body=? WHERE handle_id=?')
        .run(JSON.stringify(record), handle.handleId)
    }
    return provider
  }
  adapter = new PiDurableRuntimeAdapter(setup.options)
  try {
    handle = await adapter.start(setup.request)
    await adapter.drain()
    expect(engineFactories).toBe(1)
    expect(engineRuns).toBe(1)

    const prior = adapter.journal.get(handle.handleId)
    adapter.journal.update(handle.handleId, prior.epoch, {
      state: 'running',
      detail: { ...prior.detail, result: undefined, ownerPid: undefined, ownerEpoch: undefined },
    })
    mutateOnProviderResolution = true
    await adapter.reconcile(handle)
    await adapter.drain()

    const failed = adapter.journal.get(handle.handleId)
    expect(failed.state).toBe('unknown')
    expect(failed.detail.ownerPid).toBeUndefined()
    expect(failed.detail.ownerEpoch).toBeUndefined()
    expect(failed.detail.ownerClaimId).toBeUndefined()
    expect(engineFactories).toBe(1)
    expect(engineRuns).toBe(1)
    expect(failed.admission.admission.prompt).toBe('Changed after recovery preflight')
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

test('a recovery contender behind a live owner observes without authority, probe, or mutation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-live-owner-observe-'))
  const setup = fixture(directory)
  const seed = new PiDurableRuntimeAdapter(setup.options)
  let observer
  try {
    const handle = await seed.start(setup.request)
    await seed.drain()
    const stored = seed.journal.get(handle.handleId)
    seed.journal.update(handle.handleId, stored.epoch, {
      state: 'running',
      detail: { inferencePending: true, ownerPid: process.ppid, ownerEpoch: stored.epoch },
    })
    await seed.close()
    let authorityCalls = 0
    let probes = 0
    observer = new PiDurableRuntimeAdapter({
      ...setup.options,
      assertAuthority: async () => {
        authorityCalls += 1
        throw new Error('secret-revoked-grant')
      },
      reconcileInference: async () => {
        probes += 1
        return 'safe_to_resume'
      },
    })
    const before = observer.journal.get(handle.handleId)
    expect((await observer.reconcile(handle)).state).toBe('running')
    expect({ authorityCalls, probes }).toEqual({ authorityCalls: 0, probes: 0 })
    expect(observer.journal.get(handle.handleId)).toEqual(before)
  } finally {
    await observer?.close()
    await seed.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})

test('composition startup does not classify a contended retained record as revoked', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-live-owner-startup-'))
  const setup = fixture(directory)
  const seed = new PiDurableRuntimeAdapter(setup.options)
  let runtime
  try {
    const handle = await seed.start(setup.request)
    await seed.drain()
    const stored = seed.journal.get(handle.handleId)
    seed.journal.update(handle.handleId, stored.epoch, {
      state: 'running',
      detail: { inferencePending: true, ownerPid: process.ppid, ownerEpoch: stored.epoch },
    })
    await seed.close()
    let engines = 0
    let sends = 0
    runtime = await createNodePiDurableRuntime({
      ...setup.options,
      assertAuthority: async () => {
        throw new Error('secret-revoked-grant')
      },
      reconcileInference: async () => 'safe_to_resume',
      engineFactory: async () => {
        engines += 1
        return {
          run: async () => {
            sends += 1
            return result
          },
          close: async () => {},
          cancel: async () => {},
        }
      },
    })
    expect(runtime.recoveryBlocked).toEqual([])
    const retained = runtime.adapter.journal.get(handle.handleId)
    expect(retained.state).toBe('running')
    expect(retained.detail.recoveryBlocked).toBeUndefined()
    expect({ engines, sends }).toEqual({ engines: 0, sends: 0 })
  } finally {
    if (runtime) await runtime.close()
    else await seed.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an unclassified recovery failure is fenced for this start, releases its claim, and persists no revocation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-unclassified-recovery-'))
  const setup = fixture(directory)
  const seed = new PiDurableRuntimeAdapter(setup.options)
  let runtime
  try {
    const handle = await seed.start(setup.request)
    await seed.drain()
    const stored = seed.journal.get(handle.handleId)
    seed.journal.update(handle.handleId, stored.epoch, {
      state: 'running',
      detail: { inferencePending: true },
    })
    await seed.close()
    runtime = await createNodePiDurableRuntime({
      ...setup.options,
      reconcileInference: async () => {
        throw new Error('PROBE_UNAVAILABLE')
      },
    })
    expect(runtime.recoveryBlocked).toEqual([
      { handleId: handle.handleId, code: 'PI_RECOVERY_UNCLASSIFIED' },
    ])
    const retained = runtime.adapter.journal.get(handle.handleId)
    expect(retained.state).toBe('running')
    expect(retained.detail.recoveryBlocked).toBeUndefined()
    expect(retained.detail.ownerPid).toBeUndefined()
  } finally {
    if (runtime) await runtime.close()
    else await seed.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a concurrent epoch change while recovery probes is a stale result, never a revocation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-stale-cas-probe-'))
  const setup = fixture(directory)
  const seed = new PiDurableRuntimeAdapter(setup.options)
  let adapter
  try {
    const handle = await seed.start(setup.request)
    await seed.drain()
    const stored = seed.journal.get(handle.handleId)
    seed.journal.update(handle.handleId, stored.epoch, {
      state: 'running',
      detail: { inferencePending: true },
    })
    await seed.close()
    let engines = 0
    let sends = 0
    let concurrentEpoch
    adapter = new PiDurableRuntimeAdapter({
      ...setup.options,
      reconcileInference: async () => {
        // A concurrent command writer advances the epoch while this recovery is probing.
        const current = adapter.journal.get(handle.handleId)
        concurrentEpoch = adapter.journal.claim(handle.handleId, current)
        return 'safe_to_resume'
      },
      engineFactory: async () => {
        engines += 1
        return {
          run: async () => {
            sends += 1
            return result
          },
          close: async () => {},
          cancel: async () => {},
        }
      },
    })
    // The stale recovery observes the newer record and returns it; it neither throws nor resumes.
    expect((await adapter.reconcile(handle)).state).toBe('running')
    await adapter.drain()
    expect({ engines, sends }).toEqual({ engines: 0, sends: 0 })
    const retained = adapter.journal.get(handle.handleId)
    expect(retained.epoch).toBe(concurrentEpoch)
    expect(retained.detail.ownerPid).toBeUndefined()
    expect(retained.detail.recoveryBlocked).toBeUndefined()
  } finally {
    await adapter?.close()
    await seed.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a recovery run whose Pi store lease is held elsewhere is reconcilable, not ownerless and running', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-lease-unavailable-'))
  const setup = fixture(directory)
  const seed = new PiDurableRuntimeAdapter(setup.options)
  let adapter
  try {
    const handle = await seed.start(setup.request)
    await seed.drain()
    const stored = seed.journal.get(handle.handleId)
    seed.journal.update(handle.handleId, stored.epoch, {
      state: 'running',
      detail: { inferencePending: true },
    })
    const externalSessionId = stored.admission.handle.externalSessionId
    await seed.close()
    // Another live process (this test's parent) holds the Pi store lease for the session.
    const ownersDirectory = join(directory, 'owners')
    mkdirSync(ownersDirectory, { recursive: true })
    const leasePath = join(
      ownersDirectory,
      `${createHash('sha256').update(externalSessionId).digest('hex')}.owner`
    )
    writeFileSync(leasePath, JSON.stringify({ pid: process.ppid, identity: 'other-process' }))
    let engines = 0
    let sends = 0
    const engineFactory = async () => {
      engines += 1
      return {
        run: async () => {
          sends += 1
          return result
        },
        close: async () => {},
        cancel: async () => {},
      }
    }
    adapter = new PiDurableRuntimeAdapter({
      ...setup.options,
      reconcileInference: async () => 'safe_to_resume',
      engineFactory,
    })
    await adapter.reconcile(handle)
    await adapter.drain()
    expect({ engines, sends }).toEqual({ engines: 0, sends: 0 })
    const stranded = adapter.journal.get(handle.handleId)
    expect(stranded.state).toBe('unknown')
    expect(stranded.detail.reasonCode).toBe('PI_SESSION_LEASE_UNAVAILABLE')
    expect(stranded.detail.ownerPid).toBeUndefined()
    // Once the other process releases its lease, reconciliation resumes this same record.
    rmSync(leasePath)
    await adapter.reconcile(handle)
    await adapter.drain()
    expect(adapter.journal.get(handle.handleId).state).toBe('completed')
    expect({ engines, sends }).toEqual({ engines: 1, sends: 1 })
  } finally {
    await adapter?.close()
    await seed.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})

test.each([
  [
    'typed unavailable',
    () =>
      new RuntimeAdapterError({
        code: 'PI_AUTHORITY_UNAVAILABLE',
        classification: 'unavailable',
        message: 'PI_AUTHORITY_UNAVAILABLE',
        retryable: true,
      }),
    'PI_RECOVERY_UNAVAILABLE',
  ],
  [
    'untyped transport',
    () => new Error('connect ECONNRESET secret-transport-token'),
    'PI_RECOVERY_UNCLASSIFIED',
  ],
])(
  'a transient %s authority failure fences this start, persists no revocation, and resumes on healthy startup',
  async (_label, failure, code) => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-transient-authority-'))
    const setup = fixture(directory)
    const seed = new PiDurableRuntimeAdapter(setup.options)
    let runtime, healthy
    try {
      const handle = await seed.start(setup.request)
      await seed.drain()
      const stored = seed.journal.get(handle.handleId)
      seed.journal.update(handle.handleId, stored.epoch, {
        state: 'running',
        detail: { inferencePending: true },
      })
      const retained = seed.journal.get(handle.handleId)
      await seed.close()
      runtime = await createNodePiDurableRuntime({
        ...setup.options,
        assertAuthority: async () => {
          throw failure()
        },
        reconcileInference: async () => 'safe_to_resume',
      })
      expect(runtime.recoveryBlocked).toEqual([{ handleId: handle.handleId, code }])
      // The undone claim leaves the retained record exactly as it was: no marker, no owner.
      expect(runtime.adapter.journal.get(handle.handleId)).toEqual(retained)
      expect(JSON.stringify(runtime.recoveryBlocked)).not.toContain('secret-transport-token')
      await runtime.close()
      runtime = undefined
      healthy = await createNodePiDurableRuntime({
        ...setup.options,
        reconcileInference: async () => 'safe_to_resume',
      })
      await healthy.adapter.drain()
      expect(healthy.recoveryBlocked).toEqual([])
      expect(healthy.adapter.journal.get(handle.handleId).state).toBe('completed')
    } finally {
      await runtime?.close()
      await healthy?.close()
      await seed.close().catch(() => {})
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test('a denied recovery persists its fence before a newer owner claims, and the newer owner keeps its record', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-release-to-catch-'))
  const setup = fixture(directory)
  const seed = new PiDurableRuntimeAdapter(setup.options)
  let runtime, newerOwner
  try {
    const handle = await seed.start(setup.request)
    await seed.drain()
    const stored = seed.journal.get(handle.handleId)
    seed.journal.update(handle.handleId, stored.epoch, {
      state: 'running',
      detail: { inferencePending: true },
    })
    await seed.close()
    runtime = await createNodePiDurableRuntime({
      ...setup.options,
      assertAuthority: async () => {
        throw authoritativeDenial(new Error('PI_CANONICAL_AUTHORITY_REJECTED'))
      },
      reconcileInference: async () => 'safe_to_resume',
      onAdapterReady: (adapter) => {
        const reconcile = adapter.reconcile.bind(adapter)
        adapter.reconcile = async (target) => {
          try {
            return await reconcile(target)
          } catch (error) {
            // The denied claim is already released. A second live owner claims the record
            // before composition observes the denial.
            const current = adapter.journal.get(target.handleId)
            const epoch = adapter.journal.claim(target.handleId, {
              epoch: current.epoch,
              state: current.state,
            })
            adapter.journal.update(target.handleId, epoch, {
              detail: { ...current.detail, ownerPid: process.ppid, ownerEpoch: epoch },
            })
            newerOwner = adapter.journal.get(target.handleId)
            throw error
          }
        }
      },
    })
    // Retained E, denied claim E+1, denial release E+2, newer owner claim E+3.
    expect(newerOwner.epoch).toBe(stored.epoch + 3)
    expect(newerOwner.detail.ownerPid).toBe(process.ppid)
    expect(runtime.recoveryBlocked).toEqual([
      { handleId: handle.handleId, code: 'PI_RECOVERY_AUTHORITY_BLOCKED' },
    ])
    expect(runtime.adapter.journal.get(handle.handleId)).toEqual(newerOwner)
    expect(newerOwner.detail.recoveryBlocked).toBe('PI_RECOVERY_AUTHORITY_BLOCKED')
    expect(() => runtime.adapter.journal.assertOwner(handle.handleId, stored.epoch + 1)).toThrow(
      'STALE_OWNER'
    )
  } finally {
    await runtime?.close()
    await seed.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a denial superseded while its check is pending is reported in memory and never written onto the newer epoch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-superseded-denial-'))
  const setup = fixture(directory)
  const seed = new PiDurableRuntimeAdapter(setup.options)
  let runtime, adapter
  try {
    const handle = await seed.start(setup.request)
    await seed.drain()
    const stored = seed.journal.get(handle.handleId)
    seed.journal.update(handle.handleId, stored.epoch, {
      state: 'running',
      detail: { inferencePending: true },
    })
    await seed.close()
    runtime = await createNodePiDurableRuntime({
      ...setup.options,
      onAdapterReady: (ready) => {
        adapter = ready
      },
      assertAuthority: async () => {
        // A public command supersedes the held recovery claim while its authority check is pending.
        const current = adapter.journal.get(handle.handleId)
        adapter.journal.claim(handle.handleId, { epoch: current.epoch, state: current.state })
        throw authoritativeDenial(new Error('PI_CANONICAL_AUTHORITY_REJECTED'))
      },
      reconcileInference: async () => 'safe_to_resume',
    })
    expect(runtime.recoveryBlocked).toEqual([
      { handleId: handle.handleId, code: 'PI_RECOVERY_AUTHORITY_BLOCKED' },
    ])
    // Claim E+1 was superseded at E+2: the denial writes no marker and no owner fields.
    const superseded = runtime.adapter.journal.get(handle.handleId)
    expect(superseded.epoch).toBe(stored.epoch + 2)
    expect(superseded.detail.recoveryBlocked).toBeUndefined()
    expect(superseded.detail.ownerPid).toBeUndefined()
  } finally {
    await runtime?.close()
    await seed.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})

test.each([
  ['assertAuthority', 'PI_CANONICAL_AUTHORITY_REJECTED'],
  ['reconcileInference', 'PI_CHILD_CONTINUATION_REJECTED'],
])(
  'a denial code string thrown by %s is a caller-supplied failure: it persists no revocation and resumes on a healthy startup',
  async (port, code) => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-forged-denial-'))
    const setup = fixture(directory)
    const seed = new PiDurableRuntimeAdapter(setup.options)
    let runtime, healthy
    try {
      const handle = await seed.start(setup.request)
      await seed.drain()
      const stored = seed.journal.get(handle.handleId)
      seed.journal.update(handle.handleId, stored.epoch, {
        state: 'running',
        detail: { inferencePending: true },
      })
      const retained = seed.journal.get(handle.handleId)
      await seed.close()
      runtime = await createNodePiDurableRuntime({
        ...setup.options,
        ...(port === 'assertAuthority'
          ? {
              assertAuthority: async () => {
                throw new Error(code)
              },
            }
          : {
              reconcileInference: async () => {
                throw new Error(code)
              },
            }),
      })
      expect(runtime.recoveryBlocked).toEqual([
        { handleId: retained.handleId, code: 'PI_RECOVERY_UNCLASSIFIED' },
      ])
      expect(runtime.adapter.journal.get(retained.handleId)).toEqual(retained)
      await runtime.close()
      runtime = undefined
      healthy = await createNodePiDurableRuntime({
        ...setup.options,
        reconcileInference: async () => 'safe_to_resume',
      })
      await healthy.adapter.drain()
      expect(healthy.recoveryBlocked).toEqual([])
      expect(healthy.adapter.journal.get(retained.handleId).state).toBe('completed')
    } finally {
      await runtime?.close()
      await healthy?.close()
      await seed.close().catch(() => {})
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test('a failed engine creation keeps the confirmed safe-resume generation for the retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-resume-engine-failure-'))
  const inferenceId = 'pi-generation:1'
  const probes = []
  const permits = []
  let creations = 0
  let sends = 0
  const setup = fixture(directory, {
    authorizeInference: async (_authority, key, safeResume) => {
      permits.push({ key, safeResume })
      return { maxOutputTokens: 10, maximumInputTokens: 64, assertActive: async () => {} }
    },
    reconcileInference: async (_authority, key) => {
      probes.push(key)
      return 'safe_to_resume'
    },
    engineFactory: async (engineOptions) => {
      creations++
      // Creation 2 fails before the engine can authorize any inference.
      if (creations === 2) throw new Error('engine creation failed')
      return {
        run: async () => {
          await engineOptions.authorizeInference({ inferenceId })
          // Creation 1 loses its process after authorizing the inference; the send is undecided.
          if (creations === 1) throw new Error('process lost after authorization')
          sends++
          return result
        },
        close: async () => {},
        cancel: async () => {},
      }
    },
  })
  const adapter = new PiDurableRuntimeAdapter(setup.options)
  try {
    const handle = await adapter.start(setup.request)
    await adapter.drain()
    const turnKey = `pi-turn:${setup.request.attemptId}:initial`
    const inferenceKey = `${turnKey}:${inferenceId}`
    expect(adapter.journal.get(handle.handleId).state).toBe('unknown')
    expect(adapter.journal.get(handle.handleId).detail.activeInference?.inferenceKey).toBe(
      inferenceKey
    )

    // Recovery confirms the exact generation safe; the resumed run then fails creating its engine.
    await adapter.reconcile(handle)
    await adapter.drain()
    const afterCreationFailure = adapter.journal.get(handle.handleId)
    expect(creations).toBe(2)
    expect(afterCreationFailure.state).toBe('unknown')
    // The generation stays the reconciliation identity; permission to execute is revoked.
    expect(afterCreationFailure.detail.resumeGenerationKey).toBe(inferenceKey)
    expect(afterCreationFailure.detail.safeResumeInferenceKey).toBeUndefined()

    // The retry re-observes that same generation and still carries its resume permit.
    await adapter.reconcile(handle)
    await adapter.drain()
    expect(probes).toEqual([inferenceKey, inferenceKey, inferenceKey, inferenceKey])
    expect(permits).toEqual([
      { key: inferenceKey, safeResume: undefined },
      {
        key: inferenceKey,
        safeResume: { schemaVersion: 'pi-inference-resume-permit/v1', inferenceKey },
      },
    ])
    const completed = adapter.journal.get(handle.handleId)
    expect(completed.state).toBe('completed')
    expect(completed.detail.safeResumeInferenceKey).toBeUndefined()
    expect(completed.detail.resumeGenerationKey).toBeUndefined()
    expect(sends).toBe(1)
  } finally {
    await adapter.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})

test.each([
  // Probe counts: two safe probes per resume, one when the first is unresolved.
  ['first', ['unresolved'], 6],
  ['second', ['safe_to_resume', 'unresolved'], 8],
])(
  'an unresolved %s probe after a failed engine creation keeps the generation identity until safe returns',
  async (_probe, unresolvedProbes, probeCount) => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-resume-unresolved-'))
    const inferenceId = 'pi-generation:1'
    const probes = []
    const verdicts = []
    const permits = []
    let creations = 0
    let sends = 0
    const setup = fixture(directory, {
      authorizeInference: async (_authority, key, safeResume) => {
        permits.push({ key, safeResume })
        return { maxOutputTokens: 10, maximumInputTokens: 64, assertActive: async () => {} }
      },
      reconcileInference: async (_authority, key) => {
        probes.push(key)
        return verdicts.shift() ?? 'safe_to_resume'
      },
      engineFactory: async (engineOptions) => {
        creations++
        if (creations === 2) throw new Error('engine creation failed')
        return {
          run: async () => {
            await engineOptions.authorizeInference({ inferenceId })
            if (creations === 1) throw new Error('process lost after authorization')
            sends++
            return result
          },
          close: async () => {},
          cancel: async () => {},
        }
      },
    })
    const adapter = new PiDurableRuntimeAdapter(setup.options)
    try {
      const handle = await adapter.start(setup.request)
      await adapter.drain()
      const inferenceKey = `pi-turn:${setup.request.attemptId}:initial:${inferenceId}`
      expect(adapter.journal.get(handle.handleId).state).toBe('unknown')

      // Safe generation G resumes, then engine creation fails.
      await adapter.reconcile(handle)
      await adapter.drain()
      expect(creations).toBe(2)
      expect(adapter.journal.get(handle.handleId).state).toBe('unknown')

      // Reconciliation is temporarily unresolved. No engine may be created, and the record keeps
      // G as its identity without any permission to execute.
      verdicts.push(...unresolvedProbes)
      expect((await adapter.reconcile(handle)).state).toBe('unknown')
      await adapter.drain()
      const unresolved = adapter.journal.get(handle.handleId)
      expect(creations).toBe(2)
      expect(sends).toBe(0)
      expect(unresolved.state).toBe('unknown')
      expect(unresolved.detail.resumeGenerationKey).toBe(inferenceKey)
      expect(unresolved.detail.safeResumeInferenceKey).toBeUndefined()
      expect(unresolved.detail.reasonCode).toBe('PI_INFERENCE_RECONCILIATION_REQUIRED')

      // A repeated unresolved verdict changes nothing; safe G then returns and recovers.
      verdicts.push(...unresolvedProbes)
      await adapter.reconcile(handle)
      await adapter.drain()
      expect(adapter.journal.get(handle.handleId).detail.resumeGenerationKey).toBe(inferenceKey)
      await adapter.reconcile(handle)
      await adapter.drain()

      // Every probe asked about G; none fell back to the turn key.
      expect(probes).toHaveLength(probeCount)
      expect(new Set(probes)).toEqual(new Set([inferenceKey]))
      expect(creations).toBe(3)
      expect(permits).toEqual([
        { key: inferenceKey, safeResume: undefined },
        {
          key: inferenceKey,
          safeResume: { schemaVersion: 'pi-inference-resume-permit/v1', inferenceKey },
        },
      ])
      const completed = adapter.journal.get(handle.handleId)
      expect(completed.state).toBe('completed')
      expect(completed.detail.resumeGenerationKey).toBeUndefined()
      expect(completed.detail.safeResumeInferenceKey).toBeUndefined()
      expect(sends).toBe(1)
    } finally {
      await adapter.close().catch(() => {})
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
