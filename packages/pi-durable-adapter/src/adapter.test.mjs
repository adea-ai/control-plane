import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { PiDurableRuntimeAdapter } from './adapter.ts'
import { fixture } from './adapter.fixture.mjs'

const at = '2026-10-08T00:00:00.000Z'
test('revocation while provider readiness awaits prevents durable runtime admission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-provider-admission-fence-'))
  let adapter
  let release, entered
  const pending = new Promise((resolve) => {
    release = resolve
  })
  const reached = new Promise((resolve) => {
    entered = resolve
  })
  let revoked = false
  let engines = 0
  try {
    const { options, request } = fixture(directory)
    const provider = options.resolveProvider
    options.resolveProvider = async (...args) => {
      entered()
      await pending
      return provider(...args)
    }
    options.assertAuthority = async () => {
      if (revoked) throw new Error('CURRENT_ATTEMPT_CANCELLED')
    }
    options.engineFactory = async () => {
      engines++
      throw new Error('ENGINE_MUST_NOT_START')
    }
    adapter = new PiDurableRuntimeAdapter(options)
    const start = adapter.start(request)
    await reached
    revoked = true
    release()
    await expect(start).rejects.toThrow('PI_AUTHORITY_REJECTED')
    expect(adapter.journal.list()).toHaveLength(0)
    await adapter.close()
    adapter = new PiDurableRuntimeAdapter(options)
    expect(await adapter.findExistingHandle(request)).toBeUndefined()
    expect(engines).toBe(0)
  } finally {
    release()
    await adapter?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
test('runtime admission replay and cursor survive a physical store reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-adapter-'))
  try {
    const { options, request } = fixture(directory)
    const adapter = new PiDurableRuntimeAdapter(options)
    const handle = await adapter.start(request)
    await adapter.drain()
    expect((await adapter.status(handle)).state).toBe('completed')
    expect(await adapter.start(request)).toEqual(handle)
    const events = []
    for await (const event of adapter.progress(handle)) events.push(event)
    await adapter.close()
    const reopened = new PiDurableRuntimeAdapter(options)
    expect(await reopened.start(request)).toEqual(handle)
    expect((await reopened.status(handle)).result.output).toEqual({ text: 'answer' })
    const tail = []
    for await (const event of reopened.progress(handle, { afterSequence: events[0].sequence }))
      tail.push(event)
    expect(tail).toEqual(events.slice(1))
    await expect(reopened.start({ ...request, idempotencyKey: 'changed-key' })).rejects.toThrow(
      'ATTEMPT_CONFLICT'
    )
    await reopened.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('host metadata lookup repairs a lost receipt ACK after store reopen without admission, provider readiness, inference or journal writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-receipt-lookup-'))
  let adapter
  let sends = 0
  try {
    const { options, request } = fixture(directory)
    const factory = options.engineFactory
    options.engineFactory = async (...args) => {
      const engine = await factory(...args)
      return {
        ...engine,
        run: async (...runArgs) => {
          sends++
          return engine.run(...runArgs)
        },
      }
    }
    adapter = new PiDurableRuntimeAdapter(options)
    expect(await adapter.findExistingHandle(request)).toBeUndefined()
    expect(adapter.journal.list()).toHaveLength(0)
    let persistedHandle
    const acceptWithLostReceiptAck = async () => {
      persistedHandle = await adapter.start(request)
      throw new Error('FIXTURE_SERVICE_RECEIPT_ACK_LOST')
    }
    await expect(acceptWithLostReceiptAck()).rejects.toThrow('FIXTURE_SERVICE_RECEIPT_ACK_LOST')
    await adapter.drain()
    await adapter.close()
    let forbiddenPorts = 0
    const forbidden = async () => {
      forbiddenPorts++
      throw new Error('PROVIDER_OR_ADMISSION_UNAVAILABLE')
    }
    adapter = new PiDurableRuntimeAdapter({
      ...options,
      now: () => '2028-01-01T00:00:00.000Z',
      resolveAdmission: forbidden,
      assertAuthority: forbidden,
      resolveProvider: forbidden,
      authorizeInference: forbidden,
      reconcileInference: forbidden,
      engineFactory: forbidden,
    })
    const before = adapter.journal.list()
    const eventsBefore = adapter.journal.events(persistedHandle.handleId, 0)
    const recovered = await adapter.findExistingHandle(request)
    expect(recovered).toEqual(persistedHandle)
    expect(recovered.externalSessionId).toBe(persistedHandle.externalSessionId)
    recovered.externalSessionId = 'ses_01JBBCDEF0123456789ABCDEFG'
    expect(await adapter.findExistingHandle(request)).toEqual(persistedHandle)
    expect(adapter.journal.list()).toEqual(before)
    expect(adapter.journal.events(persistedHandle.handleId, 0)).toEqual(eventsBefore)
    expect(sends).toBe(1)
    expect(forbiddenPorts).toBe(0)
    await adapter.close()
  } finally {
    await adapter?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('host metadata lookup rejects changed immutable request, attempt and plan and returns missing only for an unrelated identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-lookup-conflict-'))
  let adapter
  try {
    const { options, request } = fixture(directory)
    adapter = new PiDurableRuntimeAdapter(options)
    const handle = await adapter.start(request)
    await adapter.drain()
    const before = adapter.journal.list()
    for (const changed of [
      { ...request, idempotencyKey: 'changed-key' },
      {
        ...request,
        attemptId: 'att_01JBBCDEF0123456789ABCDEFG',
        attemptBudget: {
          ...request.attemptBudget,
          attemptId: 'att_01JBBCDEF0123456789ABCDEFG',
          reservationKey: 'runtime-attempt:att_01JBBCDEF0123456789ABCDEFG',
        },
      },
      { ...request, attemptBudget: { ...request.attemptBudget, maximumTokens: 99 } },
      {
        ...request,
        executionId: 'exe_01JBBCDEF0123456789ABCDEFG',
        attemptBudget: { ...request.attemptBudget, executionId: 'exe_01JBBCDEF0123456789ABCDEFG' },
      },
    ])
      await expect(adapter.findExistingHandle(changed)).rejects.toThrow('PI_ADMISSION_CONFLICT')
    const plan = createExecutionPlanTestFixture({
      profileCapabilityRequirements: ['execution.cancel'],
      skillRequiredCapabilities: [],
    })
    await expect(
      adapter.findExistingHandle({
        ...request,
        executionPlan: plan,
        attemptBudget: {
          ...request.attemptBudget,
          executionPlanId: plan.executionPlanId,
          executionPlanDigest: plan.contentDigest,
        },
      })
    ).rejects.toThrow('PI_ADMISSION_CONFLICT')
    await expect(
      adapter.findExistingHandle({
        ...request,
        executionPlan: { ...request.executionPlan, contentDigest: `sha256:${'f'.repeat(64)}` },
      })
    ).rejects.toThrow()
    expect(
      await adapter.findExistingHandle({
        ...request,
        idempotencyKey: 'unrelated-message',
        attemptId: 'att_01JBBCDEF0123456789ABCDEFG',
        attemptBudget: {
          ...request.attemptBudget,
          attemptId: 'att_01JBBCDEF0123456789ABCDEFG',
          reservationKey: 'runtime-attempt:att_01JBBCDEF0123456789ABCDEFG',
        },
      })
    ).toBeUndefined()
    expect(adapter.journal.list()).toEqual(before)
    expect(await adapter.findExistingHandle(request)).toEqual(handle)
    await adapter.close()
    await expect(adapter.findExistingHandle(request)).rejects.toThrow('PI_ADAPTER_CLOSED')
  } finally {
    await adapter?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('interrupted inference stays unknown until explicit trusted reconciliation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-adapter-'))
  try {
    let runs = 0
    const { options, request } = fixture(directory, {
      engineFactory: async () => ({
        run: async () => {
          runs++
          throw new Error('secret-provider-error')
        },
        close: async () => {},
        cancel: async () => {},
      }),
    })
    const adapter = new PiDurableRuntimeAdapter(options)
    const handle = await adapter.start(request)
    await adapter.drain()
    expect((await adapter.status(handle)).state).toBe('unknown')
    await adapter.close()
    const reopened = new PiDurableRuntimeAdapter(options)
    expect((await reopened.reconcile(handle)).state).toBe('unknown')
    expect(runs).toBe(1)
    expect(JSON.stringify(await reopened.status(handle))).not.toContain('secret-provider-error')
    await reopened.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('stale authority fails before inference and changed admission is rejected', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-adapter-'))
  try {
    const { options, request, admission } = fixture(directory, {
      assertAuthority: async () => {
        throw new Error('REVOKED')
      },
    })
    const adapter = new PiDurableRuntimeAdapter(options)
    await expect(adapter.start(request)).rejects.toThrow('PI_AUTHORITY_REJECTED')
    expect(adapter.journal.list()).toHaveLength(0)
    await adapter.close()
    const ready = new PiDurableRuntimeAdapter({ ...options, assertAuthority: async () => {} })
    await ready.start(request)
    await ready.drain()
    const changed = new PiDurableRuntimeAdapter({
      ...options,
      assertAuthority: async () => {},
      resolveAdmission: async () => ({ ...admission, prompt: 'changed' }),
    })
    await expect(changed.start(request)).rejects.toThrow('IDEMPOTENCY_CONFLICT')
    await changed.close()
    await ready.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('input admission and approval acknowledgements replay after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-adapter-'))
  try {
    const { options, request } = fixture(directory)
    const adapter = new PiDurableRuntimeAdapter(options)
    const handle = await adapter.start(request)
    await adapter.drain()
    const interactionId = 'int_01JABCDEF0123456789ABCDEFG'
    await adapter.awaitInput(handle, interactionId)
    const input = { interactionId, idempotencyKey: 'input:one', text: 'follow up' }
    await adapter.submitInput(handle, input)
    await adapter.drain()
    await adapter.close()
    const reopened = new PiDurableRuntimeAdapter(options)
    expect((await reopened.submitInput(handle, input)).state).toBe('completed')
    await expect(reopened.submitInput(handle, { ...input, text: 'changed' })).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT'
    )
    await reopened.awaitApproval(handle, interactionId, 'effect:digest')
    await reopened.close()
    const blocked = new PiDurableRuntimeAdapter({ ...options, verifyApproval: async () => false })
    await expect(
      blocked.submitApproval(handle, {
        interactionId,
        idempotencyKey: 'approval:one',
        decision: 'approve',
      })
    ).rejects.toThrow('PI_APPROVAL_NOT_AUTHORITATIVE')
    await blocked.close()
    const approved = new PiDurableRuntimeAdapter({
      ...options,
      verifyApproval: async (_authority, identity, submitted) =>
        identity === 'effect:digest' && submitted.decision === 'approve',
    })
    expect(
      (
        await approved.submitApproval(handle, {
          interactionId,
          idempotencyKey: 'approval:one',
          decision: 'approve',
        })
      ).state
    ).toBe('awaiting_input')
    await approved.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('session lifecycle and cleanup retain history and cancellation is durable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-adapter-'))
  try {
    const { options, request } = fixture(directory)
    const adapter = new PiDurableRuntimeAdapter(options)
    const created = await adapter.session({ operation: 'create', idempotencyKey: 'create:one' })
    expect(await adapter.session({ operation: 'create', idempotencyKey: 'create:one' })).toEqual(
      created
    )
    const handle = await adapter.start(request)
    await adapter.drain()
    expect((await adapter.session({ operation: 'list' })).sessions).toHaveLength(2)
    expect(
      (await adapter.session({ operation: 'history', sessionId: handle.externalSessionId })).entries
        .length
    ).toBeGreaterThan(0)
    await adapter.awaitInput(handle, 'int_01JABCDEF0123456789ABCDEFG')
    const cancel = { idempotencyKey: 'cancel:one', requestedAt: at }
    expect((await adapter.cancel(handle, cancel)).state).toBe('cancelled')
    expect((await adapter.cancel(handle, cancel)).state).toBe('cancelled')
    await adapter.cleanup(handle)
    await adapter.cleanup(handle)
    await adapter.close()
    const reopened = new PiDurableRuntimeAdapter(options)
    expect(
      (await reopened.session({ operation: 'load', sessionId: handle.externalSessionId })).session
        .state
    ).toBe('closed')
    await expect(reopened.awaitInput(handle, 'int_01JABCDEF0123456789ABCDEFG')).rejects.toThrow(
      'PI_SESSION_CLOSED'
    )
    await expect(
      reopened.awaitApproval(handle, 'int_01JABCDEF0123456789ABCDEFG', 'effect:closed')
    ).rejects.toThrow('PI_SESSION_CLOSED')
    await reopened.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('unknown persisted runtime and journal versions fail closed after store restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-version-'))
  const { options, request } = fixture(directory)
  let runs = 0
  options.engineFactory = async () => ({
    run: async () => {
      runs++
      throw new Error('fixture')
    },
    cancel: async () => {},
    close: async () => {},
  })
  try {
    const adapter = new PiDurableRuntimeAdapter(options)
    const handle = await adapter.start(request)
    await adapter.drain()
    const record = adapter.journal.get(handle.handleId)
    record.admission.version = { runtime: '99.0.0', journal: 99, adapter: '99.0.0' }
    adapter.journal.database
      .prepare('UPDATE pi_admissions SET body=? WHERE handle_id=?')
      .run(JSON.stringify(record), handle.handleId)
    await adapter.close()
    const reopened = new PiDurableRuntimeAdapter(options)
    await expect(reopened.start(request)).rejects.toThrow('PI_JOURNAL_VERSION_UNSUPPORTED')
    await expect(reopened.reconcile(handle)).rejects.toThrow('PI_JOURNAL_VERSION_UNSUPPORTED')
    expect(runs).toBe(1)
    await reopened.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('trusted running hook observes committed journal handle before native factory and run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-running-hook-'))
  let adapter
  try {
    const steps = []
    const f = fixture(directory)
    adapter = new PiDurableRuntimeAdapter({
      ...f.options,
      onExecutionRunning: async (authority) => {
        const record = adapter.journal.get(authority.handle.handleId)
        expect(record.state).toBe('running')
        expect(record.detail.inferencePending).toBe(true)
        expect(authority.handle).toEqual(record.admission.handle)
        expect(authority.request).toEqual(f.request)
        expect(authority.observedAt).toBe(at)
        steps.push('hook')
      },
      engineFactory: async (options) => {
        expect(steps).toEqual(['hook'])
        steps.push('factory')
        const engine = await f.options.engineFactory(options)
        return {
          ...engine,
          run: async (input) => {
            steps.push('run')
            return engine.run(input)
          },
        }
      },
    })
    const handle = await adapter.start(f.request)
    await adapter.drain()
    expect(steps).toEqual(['hook', 'factory', 'run'])
    expect((await adapter.status(handle)).state).toBe('completed')
  } finally {
    await adapter?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

for (const boundary of ['hook', 'factory'])
  test(`revocation during ${boundary} await prevents native run and retains conservative unknown inference`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-running-revoked-'))
    let adapter
    try {
      let active = true,
        constructed = 0,
        runs = 0,
        closed = 0
      let reached, release
      const pause = new Promise((resolve) => {
        release = resolve
      })
      const entered = new Promise((resolve) => {
        reached = resolve
      })
      const f = fixture(directory)
      adapter = new PiDurableRuntimeAdapter({
        ...f.options,
        assertAuthority: async () => {
          if (!active) throw new Error('revoked-current')
        },
        onExecutionRunning: async () => {
          if (boundary === 'hook') {
            reached()
            await pause
          }
        },
        engineFactory: async () => {
          constructed++
          if (boundary === 'factory') {
            reached()
            await pause
          }
          return {
            run: async () => {
              runs++
              throw new Error('unexpected-run')
            },
            cancel: async () => {},
            close: async () => {
              closed++
            },
          }
        },
      })
      const handle = await adapter.start(f.request)
      await entered
      active = false
      release()
      await adapter.drain()
      const record = adapter.journal.get(handle.handleId)
      expect(record.state).toBe('unknown')
      expect(record.detail.inferencePending).toBe(true)
      expect(runs).toBe(0)
      expect(constructed).toBe(boundary === 'factory' ? 1 : 0)
      expect(closed).toBe(boundary === 'factory' ? 1 : 0)
    } finally {
      await adapter?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
