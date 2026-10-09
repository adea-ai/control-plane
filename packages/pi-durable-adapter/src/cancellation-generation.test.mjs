import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiDurableRuntimeAdapter } from './adapter.ts'
import { fixture } from './adapter.fixture.mjs'

const at = '2026-10-08T00:00:00.000Z'
const inferenceId = 'pi-generation:1'
const result = {
  text: 'cancelled before send',
  submissionId: 'cancel-generation',
  usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
  inferences: [
    {
      inferenceId,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
    },
  ],
}

function deferred() {
  let resolve
  const promise = new Promise((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

test('cancellation pins the exact attempt and authorized inference until that physical key is reconciled safe', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-cancel-generation-'))
  const authorizationEntered = deferred()
  const releaseAuthorization = deferred()
  const reconcileResults = []
  const reconcileKeys = []
  let currentAuthority = true
  let revokeDuringNextReconciliation = false
  let sends = 0
  let cancellations = 0
  let adapter
  const { options, request } = fixture(directory, {
    assertAuthority: async () => {
      if (!currentAuthority) throw new Error('revoked')
    },
    authorizeInference: async (_authority, key) => {
      reconcileKeys.push(`authorized:${key}`)
      authorizationEntered.resolve()
      await releaseAuthorization.promise
      return { maxOutputTokens: 10, maximumInputTokens: 64, assertActive: async () => {} }
    },
    reconcileInference: async (_authority, key) => {
      reconcileKeys.push(key)
      const reconcileResult = reconcileResults.shift() ?? 'unresolved'
      if (revokeDuringNextReconciliation) {
        revokeDuringNextReconciliation = false
        currentAuthority = false
      }
      return reconcileResult
    },
    engineFactory: async (engineOptions) => ({
      run: async () => {
        const allowance = await engineOptions.authorizeInference({
          sessionId: 'ses_01JABCDEF0123456789ABCDEFG',
          inferenceId,
          provider: 'test',
          modelId: 'mock',
        })
        await allowance.assertActive()
        sends++
        return result
      },
      close: async () => {},
      cancel: async () => {
        cancellations++
        releaseAuthorization.resolve()
      },
    }),
  })
  adapter = new PiDurableRuntimeAdapter(options)
  try {
    const handle = await adapter.start(request)
    await authorizationEntered.promise
    const beforeCancel = adapter.journal.get(handle.handleId)
    const turnKey = `pi-turn:${request.attemptId}:initial`
    const inferenceKey = `${turnKey}:${inferenceId}`
    expect(beforeCancel.detail.activeInference).toEqual({
      schemaVersion: 'pi-inference-generation/v1',
      attemptId: request.attemptId,
      turnKey,
      inferenceId,
      inferenceKey,
    })
    expect(beforeCancel.detail.engineRunStarted).toBe(true)

    expect(
      (await adapter.cancel(handle, { idempotencyKey: 'cancel:exact-generation', requestedAt: at }))
        .state
    ).toBe('cancelling')
    const intent = adapter.journal.get(handle.handleId).detail.cancellationIntent
    expect(intent).toEqual({
      schemaVersion: 'pi-cancellation-intent/v1',
      attemptId: request.attemptId,
      turnKey,
      requestedAt: at,
      requestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      targetKind: 'active_generation',
      generation: beforeCancel.detail.activeInference,
    })
    expect(cancellations).toBe(1)
    await adapter.drain()
    expect(sends).toBe(0)

    expect((await adapter.reconcile(handle)).state).toBe('cancelling')
    expect((await adapter.reconcile(handle)).state).toBe('cancelling')
    reconcileResults.push('safe_to_resume')
    revokeDuringNextReconciliation = true
    await expect(adapter.reconcile(handle)).rejects.toThrow('PI_AUTHORITY_REJECTED')
    expect(adapter.journal.get(handle.handleId).state).toBe('cancelling')
    currentAuthority = true
    reconcileResults.push('safe_to_resume')
    expect((await adapter.reconcile(handle)).state).toBe('cancelled')
    expect(reconcileKeys).toEqual([
      `authorized:${inferenceKey}`,
      inferenceKey,
      inferenceKey,
      inferenceKey,
      inferenceKey,
    ])
    expect(reconcileKeys.at(-1)).toBe(inferenceKey)
    expect(adapter.journal.get(handle.handleId).detail.cancellationIntent).toMatchObject({
      targetKind: 'active_generation',
      generation: { attemptId: request.attemptId, inferenceKey },
      resolution: 'safe_to_resume',
    })
    expect(await adapter.start(request)).toEqual(handle)
    expect(sends).toBe(0)
  } finally {
    releaseAuthorization.resolve()
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('cancellation before inference authorization records no generation and fences later reservation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-cancel-before-generation-'))
  const factoryEntered = deferred()
  const releaseFactory = deferred()
  let authorizations = 0
  let reconciliations = 0
  let sends = 0
  const { options, request } = fixture(directory, {
    authorizeInference: async () => {
      authorizations++
      return { maxOutputTokens: 10, maximumInputTokens: 64, assertActive: async () => {} }
    },
    reconcileInference: async () => {
      reconciliations++
      return 'unresolved'
    },
    engineFactory: async (engineOptions) => {
      factoryEntered.resolve()
      await releaseFactory.promise
      return {
        run: async () => {
          const allowance = await engineOptions.authorizeInference({
            sessionId: 'ses_01JABCDEF0123456789ABCDEFG',
            inferenceId,
            provider: 'test',
            modelId: 'mock',
          })
          await allowance.assertActive()
          sends++
          return result
        },
        close: async () => {},
        cancel: async () => {},
      }
    },
  })
  const adapter = new PiDurableRuntimeAdapter(options)
  try {
    const handle = await adapter.start(request)
    await factoryEntered.promise
    const starting = adapter.journal.get(handle.handleId)
    expect(starting.detail.inferenceTrackingVersion).toBe(1)
    expect(starting.detail.engineRunStarted).toBe(false)
    expect(starting.detail.activeInference).toBeUndefined()

    expect(
      (
        await adapter.cancel(handle, {
          idempotencyKey: 'cancel:before-generation',
          requestedAt: at,
        })
      ).state
    ).toBe('cancelling')
    expect(adapter.journal.get(handle.handleId).detail.cancellationIntent).toMatchObject({
      schemaVersion: 'pi-cancellation-intent/v1',
      attemptId: request.attemptId,
      targetKind: 'no_active_generation',
      generation: null,
    })
    releaseFactory.resolve()
    await adapter.drain()
    expect(authorizations).toBe(0)
    expect(sends).toBe(0)
    expect((await adapter.reconcile(handle)).state).toBe('cancelled')
    expect(reconciliations).toBe(0)
    expect(adapter.journal.get(handle.handleId).detail.cancellationIntent).toMatchObject({
      resolution: 'safe_to_resume',
      generation: null,
    })
  } finally {
    releaseFactory.resolve()
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a late old-run result cannot replace cancellation state or publish output', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-cancel-late-result-'))
  const sendStarted = deferred()
  const releaseRun = deferred()
  const reconcileKeys = []
  let sends = 0
  let settlements = 0
  let cancellations = 0
  const { options, request } = fixture(directory, {
    authorizeInference: async () => ({
      maxOutputTokens: 10,
      maximumInputTokens: 64,
      assertActive: async () => {},
    }),
    settleUsage: async (_authority, _key, usage) => {
      settlements++
      return usage
    },
    reconcileInference: async (_authority, key) => {
      reconcileKeys.push(key)
      return 'unresolved'
    },
    engineFactory: async (engineOptions) => ({
      run: async () => {
        const allowance = await engineOptions.authorizeInference({
          sessionId: 'ses_01JABCDEF0123456789ABCDEFG',
          inferenceId,
          provider: 'test',
          modelId: 'mock',
        })
        await allowance.assertActive()
        sends++
        sendStarted.resolve()
        await releaseRun.promise
        return { ...result, text: 'late old-attempt result' }
      },
      close: async () => {},
      cancel: async () => {
        cancellations++
        releaseRun.resolve()
      },
    }),
  })
  const adapter = new PiDurableRuntimeAdapter(options)
  try {
    const handle = await adapter.start(request)
    await sendStarted.promise
    const turnKey = `pi-turn:${request.attemptId}:initial`
    const inferenceKey = `${turnKey}:${inferenceId}`
    expect(
      (await adapter.cancel(handle, { idempotencyKey: 'cancel:late-result', requestedAt: at }))
        .state
    ).toBe('cancelling')
    const cancelled = adapter.journal.get(handle.handleId)
    const events = adapter.journal.events(handle.handleId, 0)
    expect(cancelled.detail.cancellationIntent).toMatchObject({
      targetKind: 'active_generation',
      generation: { attemptId: request.attemptId, inferenceKey },
    })
    await adapter.drain()
    expect(adapter.journal.get(handle.handleId)).toEqual(cancelled)
    expect(adapter.journal.events(handle.handleId, 0)).toEqual(events)
    expect({ sends, settlements, cancellations }).toEqual({
      sends: 1,
      settlements: 0,
      cancellations: 1,
    })
    expect((await adapter.reconcile(handle)).state).toBe('cancelling')
    expect(reconcileKeys).toEqual([inferenceKey])
    expect(adapter.journal.get(handle.handleId).detail.result).toBeUndefined()
  } finally {
    releaseRun.resolve()
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('cancelling a failed execution preserves its terminal failure and returns a valid status', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-cancel-failed-terminal-'))
  const { options, request } = fixture(directory)
  const adapter = new PiDurableRuntimeAdapter(options)
  try {
    const handle = await adapter.start(request)
    await adapter.drain()

    const completed = adapter.journal.get(handle.handleId)
    const retainedFailure = {
      code: 'PI_CHILD_DELEGATION_DENIED',
      classification: 'conflict',
      message: 'PI_CHILD_DELEGATION_DENIED',
      retryable: false,
    }
    adapter.journal.update(handle.handleId, completed.epoch, {
      state: 'failed',
      detail: {
        ...completed.detail,
        result: undefined,
        error: retainedFailure,
        terminalUsage: { inputTokens: 1, outputTokens: 0, durationMs: 1 },
      },
    })

    const beforeCancel = adapter.journal.get(handle.handleId)
    const status = await adapter.cancel(handle, {
      idempotencyKey: 'cancel:already-failed',
      requestedAt: at,
    })

    expect(status.state).toBe('failed')
    expect(status.error).toEqual(retainedFailure)
    expect(status.terminalUsage).toEqual({ inputTokens: 1, outputTokens: 0, durationMs: 1 })
    expect(adapter.journal.get(handle.handleId)).toEqual(beforeCancel)
    expect(beforeCancel.detail.error).toEqual(retainedFailure)
    expect(beforeCancel.detail.cancellationIntent).toBeUndefined()
  } finally {
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
