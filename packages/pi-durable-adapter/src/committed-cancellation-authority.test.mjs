import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { PiDurableRuntimeAdapter } from './adapter.ts'
import { createNodePiDurableRuntime } from './composition.ts'
import { SqliteDurableJournal } from './journal.ts'
import {
  createMemoryCommittedCancellationAuthority,
  createSqliteCommittedCancellationAuthority,
} from './cancellation-authority.test-fixture.mjs'
import { fixture } from './adapter.fixture.mjs'

const at = '2026-10-08T00:00:00.000Z'
const deadlineAt = '2027-01-01T00:00:00.000Z'

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`
}

async function prepareCase(directory) {
  const authority = createSqliteCommittedCancellationAuthority(
    join(directory, 'cancellation-owner.sqlite'),
    { now: () => at }
  )
  let aborts = 0
  let runs = 0
  const setup = fixture(directory, {
    now: () => at,
    committedCancellationAuthority: authority,
  })
  const engineFactory = setup.options.engineFactory
  setup.options.engineFactory = async (...args) => {
    const engine = await engineFactory(...args)
    return {
      ...engine,
      run: async (...runArgs) => {
        runs += 1
        return engine.run(...runArgs)
      },
      cancel: async (...cancelArgs) => {
        aborts += 1
        return engine.cancel(...cancelArgs)
      },
    }
  }
  const adapter = new PiDurableRuntimeAdapter(setup.options)
  const handle = await adapter.start(setup.request)
  await adapter.drain()
  const completed = adapter.journal.get(handle.handleId)
  const stored = completed.admission
  const admissionDigest = digest(stored)
  adapter.journal.update(handle.handleId, completed.epoch, {
    state: 'running',
    detail: {
      ...completed.detail,
      result: undefined,
      error: undefined,
      engineRunStarted: true,
      activeInference: undefined,
      inferencePending: true,
    },
  })
  authority.register({
    handleId: handle.handleId,
    executionId: setup.request.executionId,
    attemptId: setup.request.attemptId,
    workspaceId: setup.request.attemptBudget.workspaceId,
    admissionDigest,
    productRevision: stored.admission.authority.revision,
    expiresAt: stored.admission.authority.expiresAt,
    deadlineAt,
  })
  return {
    adapter,
    authority,
    handle,
    request: { idempotencyKey: 'cancel:committed', requestedAt: at },
    completedResult: completed.detail.result,
    aborts: () => aborts,
    runs: () => runs,
    setup,
  }
}

async function withCase(run) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-committed-cancel-'))
  let context
  try {
    context = await prepareCase(directory)
    await run({ ...context, directory })
  } finally {
    await context?.adapter.close()
    context?.authority.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function prepareLiveCase(directory) {
  const authority = createSqliteCommittedCancellationAuthority(
    join(directory, 'cancellation-owner.sqlite'),
    { now: () => at }
  )
  const started = deferred()
  const stopped = deferred()
  let aborts = 0
  let runs = 0
  const setup = fixture(directory, {
    now: () => at,
    committedCancellationAuthority: authority,
    engineFactory: async (engineOptions) => ({
      run: async () => {
        runs += 1
        const allowance = await engineOptions.authorizeInference({
          sessionId: 'ses_01JABCDEF0123456789ABCDEFG',
          inferenceId: 'pi-generation:live',
          provider: 'test',
          modelId: 'mock',
        })
        await allowance.assertActive()
        started.resolve()
        return new Promise((_resolve, reject) => {
          stopped.reject = reject
        })
      },
      cancel: async () => {
        aborts += 1
        if (aborts === 2) stopped.reject(new Error('scripted cancellation'))
      },
      close: async () => {},
    }),
  })
  const adapter = new PiDurableRuntimeAdapter(setup.options)
  const handle = await adapter.start(setup.request)
  await started.promise
  const retained = adapter.journal.get(handle.handleId)
  authority.register({
    handleId: handle.handleId,
    executionId: setup.request.executionId,
    attemptId: setup.request.attemptId,
    workspaceId: setup.request.attemptBudget.workspaceId,
    admissionDigest: digest(retained.admission),
    productRevision: retained.admission.admission.authority.revision,
    expiresAt: retained.admission.admission.authority.expiresAt,
    deadlineAt,
  })
  return {
    adapter,
    authority,
    handle,
    request: { idempotencyKey: 'cancel:live-delivery', requestedAt: at },
    aborts: () => aborts,
    runs: () => runs,
    stop: () => stopped.reject(new Error('test cleanup')),
  }
}

function generation(attemptId, turnKey, inferenceId) {
  return {
    schemaVersion: 'pi-inference-generation/v1',
    attemptId,
    turnKey,
    inferenceId,
    inferenceKey: `${turnKey}:${inferenceId}`,
  }
}

test('memory cancellation owner replays an old key and commits a distinct new key for the same handle', async () => {
  const authority = createMemoryCommittedCancellationAuthority({ now: () => at })
  const firstProposal = {
    handleId: 'pi-durable:memory-keyed-owner',
    idempotencyKey: 'cancel:G1',
    requestDigest: digest({ idempotencyKey: 'cancel:G1', requestedAt: at }),
  }
  const first = await authority.commit(firstProposal)
  expect(await authority.commit(firstProposal)).toEqual(first)

  const secondProposal = {
    ...firstProposal,
    idempotencyKey: 'cancel:G2',
    requestDigest: digest({ idempotencyKey: 'cancel:G2', requestedAt: at }),
  }
  const second = await authority.commit(secondProposal)
  expect(second.intentId).not.toBe(first.intentId)
  expect(await authority.commit(firstProposal)).toEqual(first)
  expect(await authority.pending()).toEqual([first, second])
  expect(authority.intentForHandle(first.handleId, first.idempotencyKey)).toEqual(first)
  expect(authority.intentForHandle(first.handleId, second.idempotencyKey)).toEqual(second)

  await authority.acknowledge(first.intentId)
  expect(await authority.pending()).toEqual([second])
})

test('product revocation committed first denies cancellation with no outbox, journal write, or abort', async () => {
  await withCase(async ({ adapter, authority, handle, request, aborts }) => {
    authority.updateProductFence(handle.handleId, { revision: 2, active: false })

    await expect(adapter.cancel(handle, request)).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')

    const journal = adapter.journal.get(handle.handleId)
    expect(journal.state).toBe('running')
    expect(journal.detail.cancellationIntent).toBeUndefined()
    expect(authority.intentForHandle(handle.handleId)).toBeUndefined()
    expect(aborts()).toBe(0)
  })
})

test('deadline update committed first denies cancellation without changing the journal', async () => {
  await withCase(async ({ adapter, authority, handle, request, aborts }) => {
    authority.updateControlPlane(handle.handleId, {
      executionVersion: 2,
      deadlineAt: '2026-10-07T23:59:00.000Z',
    })

    await expect(adapter.cancel(handle, request)).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')

    const journal = adapter.journal.get(handle.handleId)
    expect(journal.state).toBe('running')
    expect(journal.detail.cancellationIntent).toBeUndefined()
    expect(authority.intentForHandle(handle.handleId)).toBeUndefined()
    expect(aborts()).toBe(0)
  })
})

test('revocation between final authorization and owner commit is rejected before effect', async () => {
  await withCase(async ({ adapter, authority, handle, request, aborts }) => {
    const gate = authority.parkNextCommit()
    const cancellation = adapter.cancel(handle, request)
    await gate.entered

    authority.updateProductFence(handle.handleId, { revision: 2, active: false })
    gate.release()

    await expect(cancellation).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')

    const journal = adapter.journal.get(handle.handleId)
    expect(journal.state).toBe('running')
    expect(journal.detail.cancellationIntent).toBeUndefined()
    expect(authority.intentForHandle(handle.handleId)).toBeUndefined()
    expect(aborts()).toBe(0)
  })
})

test('committed cancellation wins later revocation and duplicate request reuses one intent', async () => {
  await withCase(async ({ adapter, authority, handle, request, aborts }) => {
    const first = await adapter.cancel(handle, request)
    const committed = authority.intentForHandle(handle.handleId)
    expect(first.state).toBe('cancelling')
    expect(committed.intentId).toBe(
      adapter.journal.get(handle.handleId).detail.cancellationIntent.authorityIntentId
    )

    authority.updateProductFence(handle.handleId, { revision: 2, active: false })
    const replay = await adapter.cancel(handle, request)
    await expect(
      adapter.cancel(handle, { idempotencyKey: 'cancel:changed-owner-key', requestedAt: at })
    ).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')
    authority.updateControlPlane(handle.handleId, {
      executionVersion: 2,
      deadlineAt: '2026-10-07T23:59:00.000Z',
    })

    expect(replay.state).toBe('cancelling')
    expect(authority.intentForHandle(handle.handleId).intentId).toBe(committed.intentId)
    expect(adapter.journal.get(handle.handleId).detail.cancellationIntent.authorityIntentId).toBe(
      committed.intentId
    )
    expect(aborts()).toBe(0)
  })
})

test('unknown commit response recovers the same intent after adapter reopen without resending inference', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-cancel-unknown-'))
  let context
  let reopenedRuntime
  try {
    context = await prepareCase(directory)
    context.authority.loseNextCommitResponse()
    await expect(context.adapter.cancel(context.handle, context.request)).rejects.toThrow(
      'PI_CANCELLATION_COMMIT_OUTCOME_UNKNOWN'
    )
    expect(context.adapter.journal.get(context.handle.handleId).state).toBe('running')
    expect(
      context.adapter.journal.get(context.handle.handleId).detail.cancellationIntent
    ).toBeUndefined()
    await expect(context.authority.pending()).resolves.toHaveLength(1)
    expect(context.aborts()).toBe(0)

    await context.adapter.close()
    reopenedRuntime = await createNodePiDurableRuntime(context.setup.options)
    context.adapter = reopenedRuntime.adapter
    const retained = context.adapter.journal.get(context.handle.handleId)
    const committed = context.authority.intentForHandle(context.handle.handleId)
    expect(retained.state).toBe('cancelling')
    expect(retained.detail.cancellationIntent.authorityIntentId).toBe(committed.intentId)
    await expect(context.authority.pending()).resolves.toHaveLength(0)
    expect(context.adapter.journal.get(context.handle.handleId).state).toBe('cancelling')
    expect(context.runs()).toBe(1)
  } finally {
    if (reopenedRuntime) await reopenedRuntime.close()
    else await context?.adapter.close()
    context?.authority.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('failed outbox acknowledgement retries delivery in the same live engine without rerunning inference', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-cancel-ack-retry-'))
  let context
  try {
    context = await prepareLiveCase(directory)
    context.authority.failNextAcknowledge()

    await expect(context.adapter.cancel(context.handle, context.request)).rejects.toThrow(
      'PI_CANCELLATION_ACK_UNAVAILABLE'
    )
    expect(context.adapter.journal.get(context.handle.handleId).state).toBe('cancelling')
    expect(context.aborts()).toBe(1)
    await expect(context.authority.pending()).resolves.toHaveLength(1)
    expect(context.runs()).toBe(1)

    expect((await context.adapter.cancel(context.handle, context.request)).state).toBe('cancelling')
    expect(context.aborts()).toBe(2)
    await expect(context.authority.pending()).resolves.toHaveLength(0)
    await context.adapter.recoverCommittedCancellationIntents()
    expect(context.aborts()).toBe(2)
    expect(context.runs()).toBe(1)
    await context.adapter.drain()
  } finally {
    context?.stop()
    await context?.adapter.drain()
    await context?.adapter.close()
    context?.authority.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('restart acknowledges a cancellation applied before an acknowledgement failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-cancel-ack-restart-'))
  let context
  let reopenedRuntime
  try {
    context = await prepareCase(directory)
    context.authority.failNextAcknowledge()
    await expect(context.adapter.cancel(context.handle, context.request)).rejects.toThrow(
      'PI_CANCELLATION_ACK_UNAVAILABLE'
    )
    expect(context.adapter.journal.get(context.handle.handleId).state).toBe('cancelling')
    await expect(context.authority.pending()).resolves.toHaveLength(1)

    await context.adapter.close()
    reopenedRuntime = await createNodePiDurableRuntime(context.setup.options)
    expect(reopenedRuntime.adapter.journal.get(context.handle.handleId).state).toBe('cancelling')
    await expect(context.authority.pending()).resolves.toHaveLength(0)
    expect(context.runs()).toBe(1)
  } finally {
    if (reopenedRuntime) await reopenedRuntime.close()
    else await context?.adapter.close()
    context?.authority.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('historical cancellation resolution replays across turns after a lost acknowledgement', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-cancel-cross-turn-ack-'))
  const authority = createSqliteCommittedCancellationAuthority(
    join(directory, 'cancellation-owner.sqlite'),
    { now: () => at }
  )
  const started = [deferred(), deferred(), deferred()]
  const finish = [deferred(), deferred(), deferred()]
  let runs = 0
  let adapter
  let reopened
  try {
    const { options, request } = fixture(directory, {
      now: () => at,
      committedCancellationAuthority: authority,
      engineFactory: async (engineOptions) => ({
        run: async () => {
          const turn = runs++
          const inferenceId = `pi-generation:turn-${turn + 1}`
          const allowance = await engineOptions.authorizeInference({
            sessionId: 'ses_01JABCDEF0123456789ABCDEFG',
            inferenceId,
            provider: 'test',
            modelId: 'mock',
          })
          await allowance.assertActive()
          started[turn].resolve()
          await finish[turn].promise
          return {
            text: `answer ${turn + 1}`,
            submissionId: `submission:${turn + 1}`,
            usage: { inputTokens: 3, outputTokens: 4, costUsd: '0.000007', durationMs: 2 },
            inferences: [
              {
                inferenceId,
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
        },
        close: async () => {},
        cancel: async () => {},
      }),
    })
    adapter = new PiDurableRuntimeAdapter(options)
    const handle = await adapter.start(request)
    await started[0].promise
    const admitted = adapter.journal.get(handle.handleId)
    const stored = admitted.admission
    authority.register({
      handleId: handle.handleId,
      executionId: request.executionId,
      attemptId: request.attemptId,
      workspaceId: request.attemptBudget.workspaceId,
      admissionDigest: digest(stored),
      productRevision: stored.admission.authority.revision,
      expiresAt: stored.admission.authority.expiresAt,
      deadlineAt,
    })
    const firstTurn = `pi-turn:${request.attemptId}:initial`
    const firstRequest = { idempotencyKey: 'cancel:turn-one', requestedAt: at }

    authority.loseNextCommitResponse()
    await expect(adapter.cancel(handle, firstRequest)).rejects.toThrow(
      'PI_CANCELLATION_COMMIT_OUTCOME_UNKNOWN'
    )
    finish[0].resolve()
    await adapter.drain()
    await adapter.awaitInput(handle, 'int_01JABCDEF0123456789ABCDEFG')
    await adapter.submitInput(handle, {
      interactionId: 'int_01JABCDEF0123456789ABCDEFG',
      idempotencyKey: 'input:two',
      text: 'second turn',
    })
    await started[1].promise

    authority.failNextAcknowledge()
    await expect(adapter.cancel(handle, firstRequest)).rejects.toThrow(
      'PI_CANCELLATION_ACK_UNAVAILABLE'
    )
    const cancellationKey = `cancel:${firstRequest.idempotencyKey}`
    const persisted = adapter.journal.get(handle.handleId).detail.cancellationResolutions[
      cancellationKey
    ]
    expect(persisted.generation.turnKey).toBe(firstTurn)
    expect(persisted.observedGeneration.turnKey).toBe(`pi-input:${request.attemptId}:input:two`)

    authority.failNextAcknowledge()
    await expect(adapter.cancel(handle, firstRequest)).rejects.toThrow(
      'PI_CANCELLATION_ACK_UNAVAILABLE'
    )

    finish[1].resolve()
    await adapter.drain()
    await adapter.awaitInput(handle, 'int_01JBCDEF0123456789ABCDEFGH')
    await adapter.submitInput(handle, {
      interactionId: 'int_01JBCDEF0123456789ABCDEFGH',
      idempotencyKey: 'input:three',
      text: 'third turn',
    })
    await started[2].promise
    finish[2].resolve()
    await adapter.drain()

    const current = adapter.journal.get(handle.handleId)
    expect(current.detail.turn.requestId).toBe(`pi-input:${request.attemptId}:input:three`)
    expect(current.detail.cancellationResolutions[cancellationKey]).toEqual(persisted)

    const otherAttemptId = 'att_01JBBCDEF0123456789ABCDEFG'
    for (const field of ['generation', 'observedGeneration']) {
      const invalid = structuredClone(persisted)
      invalid[field] = { ...invalid[field], attemptId: otherAttemptId }
      const record = adapter.journal.get(handle.handleId)
      adapter.journal.update(handle.handleId, record.epoch, {
        detail: {
          ...record.detail,
          cancellationResolutions: {
            ...record.detail.cancellationResolutions,
            [cancellationKey]: invalid,
          },
        },
      })
      await expect(adapter.cancel(handle, firstRequest)).rejects.toThrow(
        'PI_CANCELLATION_RESOLUTION_INVALID'
      )
      const restored = adapter.journal.get(handle.handleId)
      adapter.journal.update(handle.handleId, restored.epoch, {
        detail: {
          ...restored.detail,
          cancellationResolutions: {
            ...restored.detail.cancellationResolutions,
            [cancellationKey]: persisted,
          },
        },
      })
    }

    authority.failNextAcknowledge()
    await expect(adapter.cancel(handle, firstRequest)).rejects.toThrow(
      'PI_CANCELLATION_ACK_UNAVAILABLE'
    )
    await adapter.close()
    adapter = undefined
    reopened = new PiDurableRuntimeAdapter(options)
    await expect(reopened.recoverCommittedCancellationIntents()).resolves.toEqual([])
    await expect(authority.pending()).resolves.toHaveLength(0)
    expect((await reopened.cancel(handle, firstRequest)).state).toBe('completed')
    expect(runs).toBe(3)
  } finally {
    for (const gate of finish) gate.resolve()
    if (adapter) {
      await adapter.drain()
      await adapter.close()
    }
    await reopened?.close()
    authority.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('lost no-generation cancellation responses cannot cancel later submitted turns', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-cancel-no-generation-cross-turn-'))
  const authority = createSqliteCommittedCancellationAuthority(
    join(directory, 'cancellation-owner.sqlite'),
    { now: () => at }
  )
  const entered = [deferred(), deferred(), deferred()]
  const allowInference = [deferred(), deferred(), deferred()]
  const inferenceStarted = [deferred(), deferred(), deferred()]
  let runs = 0
  let aborts = 0
  let adapter
  try {
    const { options, request } = fixture(directory, {
      now: () => at,
      committedCancellationAuthority: authority,
      engineFactory: async (engineOptions) => {
        const turn = runs++
        return {
          run: async () => {
            entered[turn].resolve()
            await allowInference[turn].promise
            const inferenceId = `pi-generation:turn-${turn + 1}`
            const allowance = await engineOptions.authorizeInference({
              sessionId: 'ses_01JABCDEF0123456789ABCDEFG',
              inferenceId,
              provider: 'test',
              modelId: 'mock',
            })
            await allowance.assertActive()
            inferenceStarted[turn].resolve()
            return {
              text: `turn ${turn + 1}`,
              submissionId: `submission:${turn + 1}`,
              usage: { inputTokens: 3, outputTokens: 4, costUsd: '0.000007', durationMs: 2 },
              inferences: [
                {
                  inferenceId,
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
          },
          close: async () => {},
          cancel: async () => {
            aborts += 1
          },
        }
      },
    })
    adapter = new PiDurableRuntimeAdapter(options)
    const handle = await adapter.start(request)
    await entered[0].promise
    const admitted = adapter.journal.get(handle.handleId)
    const stored = admitted.admission
    authority.register({
      handleId: handle.handleId,
      executionId: request.executionId,
      attemptId: request.attemptId,
      workspaceId: request.attemptBudget.workspaceId,
      admissionDigest: digest(stored),
      productRevision: stored.admission.authority.revision,
      expiresAt: stored.admission.authority.expiresAt,
      deadlineAt,
    })

    const untrackedRequest = { idempotencyKey: 'cancel:untracked-turn-one', requestedAt: at }
    const firstTurn = `pi-turn:${request.attemptId}:initial`
    authority.loseNextCommitResponse()
    await expect(adapter.cancel(handle, untrackedRequest)).rejects.toThrow(
      'PI_CANCELLATION_COMMIT_OUTCOME_UNKNOWN'
    )
    expect(
      authority.intentForHandle(handle.handleId, untrackedRequest.idempotencyKey)
    ).toMatchObject({
      targetKind: 'untracked_generation',
      generation: null,
    })

    allowInference[0].resolve()
    await inferenceStarted[0].promise
    await adapter.drain()
    await adapter.awaitInput(handle, 'int_01JABCDEF0123456789ABCDEFG')
    await adapter.submitInput(handle, {
      interactionId: 'int_01JABCDEF0123456789ABCDEFG',
      idempotencyKey: 'input:no-generation-turn-two',
      text: 'second turn',
    })
    await entered[1].promise
    const secondTurn = `pi-input:${request.attemptId}:input:no-generation-turn-two`

    expect((await adapter.cancel(handle, untrackedRequest)).state).toBe('running')
    let retained = adapter.journal.get(handle.handleId)
    expect(retained.state).toBe('running')
    expect(retained.detail.cancellationIntent).toBeUndefined()
    expect(
      retained.detail.cancellationResolutions[`cancel:${untrackedRequest.idempotencyKey}`]
    ).toMatchObject({
      targetKind: 'untracked_generation',
      turnKey: firstTurn,
      generation: null,
      observedGeneration: null,
    })
    expect(aborts).toBe(0)
    await expect(authority.pending()).resolves.toHaveLength(0)

    allowInference[1].resolve()
    await inferenceStarted[1].promise
    await adapter.drain()
    await adapter.awaitInput(handle, 'int_01JBBCDEF0123456789ABCDEFG')

    const noGenerationRequest = { idempotencyKey: 'cancel:no-active-turn-two', requestedAt: at }
    authority.loseNextCommitResponse()
    await expect(adapter.cancel(handle, noGenerationRequest)).rejects.toThrow(
      'PI_CANCELLATION_COMMIT_OUTCOME_UNKNOWN'
    )
    expect(
      authority.intentForHandle(handle.handleId, noGenerationRequest.idempotencyKey)
    ).toMatchObject({
      targetKind: 'no_active_generation',
      generation: null,
    })

    await adapter.submitInput(handle, {
      interactionId: 'int_01JBBCDEF0123456789ABCDEFG',
      idempotencyKey: 'input:no-generation-turn-three',
      text: 'third turn',
    })
    await entered[2].promise
    const thirdTurn = `pi-input:${request.attemptId}:input:no-generation-turn-three`
    expect((await adapter.cancel(handle, noGenerationRequest)).state).toBe('running')
    retained = adapter.journal.get(handle.handleId)
    expect(retained.state).toBe('running')
    expect(retained.detail.cancellationIntent).toBeUndefined()
    expect(
      retained.detail.cancellationResolutions[`cancel:${noGenerationRequest.idempotencyKey}`]
    ).toMatchObject({
      targetKind: 'no_active_generation',
      turnKey: secondTurn,
      generation: null,
      observedGeneration: null,
    })
    expect(aborts).toBe(0)
    await expect(authority.pending()).resolves.toHaveLength(0)

    const corrupt = adapter.journal.get(handle.handleId)
    const key = `cancel:${noGenerationRequest.idempotencyKey}`
    const invalid = {
      ...corrupt.detail.cancellationResolutions[key],
      turnKey: thirdTurn,
    }
    adapter.journal.update(handle.handleId, corrupt.epoch, {
      detail: {
        ...corrupt.detail,
        cancellationResolutions: { ...corrupt.detail.cancellationResolutions, [key]: invalid },
      },
    })
    await expect(adapter.cancel(handle, noGenerationRequest)).rejects.toThrow(
      'PI_CANCELLATION_INTENT_CONFLICT'
    )

    allowInference[2].resolve()
    await inferenceStarted[2].promise
    await adapter.drain()
    expect(adapter.journal.get(handle.handleId).state).toBe('completed')
    expect(aborts).toBe(0)
  } finally {
    for (const gate of allowInference) gate.resolve()
    if (adapter) {
      await adapter.drain()
      await adapter.close()
    }
    authority.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('lost untracked cancellation cannot abort a tracked generation authorized later in the same turn', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-cancel-untracked-same-turn-replay-'))
  const authority = createSqliteCommittedCancellationAuthority(
    join(directory, 'cancellation-owner.sqlite'),
    { now: () => at }
  )
  const engineEntered = deferred()
  const allowAuthorization = deferred()
  const inferenceStarted = deferred()
  const allowCompletion = deferred()
  let aborts = 0
  let adapter
  try {
    const { options, request } = fixture(directory, {
      now: () => at,
      committedCancellationAuthority: authority,
      engineFactory: async (engineOptions) => ({
        run: async () => {
          engineEntered.resolve()
          await allowAuthorization.promise
          const inferenceId = 'pi-generation:same-turn-replay'
          const allowance = await engineOptions.authorizeInference({
            sessionId: 'ses_01JABCDEF0123456789ABCDEFG',
            inferenceId,
            provider: 'test',
            modelId: 'mock',
          })
          await allowance.assertActive()
          inferenceStarted.resolve()
          await allowCompletion.promise
          return {
            text: 'same-turn result',
            submissionId: 'submission:same-turn-replay',
            usage: { inputTokens: 3, outputTokens: 4, costUsd: '0.000007', durationMs: 2 },
            inferences: [
              {
                inferenceId,
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
        },
        close: async () => {},
        cancel: async () => {
          aborts += 1
        },
      }),
    })
    adapter = new PiDurableRuntimeAdapter(options)
    const handle = await adapter.start(request)
    await engineEntered.promise
    const admitted = adapter.journal.get(handle.handleId)
    const stored = admitted.admission
    authority.register({
      handleId: handle.handleId,
      executionId: request.executionId,
      attemptId: request.attemptId,
      workspaceId: request.attemptBudget.workspaceId,
      admissionDigest: digest(stored),
      productRevision: stored.admission.authority.revision,
      expiresAt: stored.admission.authority.expiresAt,
      deadlineAt,
    })

    const oldRequest = { idempotencyKey: 'cancel:untracked-same-turn', requestedAt: at }
    authority.loseNextCommitResponse()
    await expect(adapter.cancel(handle, oldRequest)).rejects.toThrow(
      'PI_CANCELLATION_COMMIT_OUTCOME_UNKNOWN'
    )
    expect(authority.intentForHandle(handle.handleId, oldRequest.idempotencyKey)).toMatchObject({
      targetKind: 'untracked_generation',
      generation: null,
    })

    allowAuthorization.resolve()
    await inferenceStarted.promise
    const generationBeforeRetry = adapter.journal.get(handle.handleId).detail.activeInference
    expect(generationBeforeRetry.inferenceId).toBe('pi-generation:same-turn-replay')

    expect((await adapter.cancel(handle, oldRequest)).state).toBe('running')
    const retained = adapter.journal.get(handle.handleId)
    expect(retained.state).toBe('running')
    expect(retained.detail.cancellationIntent).toBeUndefined()
    expect(
      retained.detail.cancellationResolutions[`cancel:${oldRequest.idempotencyKey}`]
    ).toMatchObject({
      targetKind: 'untracked_generation',
      generation: null,
      resolution: 'target_generation_superseded',
      observedGeneration: generationBeforeRetry,
    })
    expect(aborts).toBe(0)
    await expect(authority.pending()).resolves.toHaveLength(0)

    allowCompletion.resolve()
    await adapter.drain()
    expect(adapter.journal.get(handle.handleId).state).toBe('completed')
    expect(aborts).toBe(0)
  } finally {
    allowAuthorization.resolve()
    allowCompletion.resolve()
    if (adapter) {
      await adapter.drain()
      await adapter.close()
    }
    authority.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('same-key retry reconciles G1 while a new key can commit cancellation for G2', async () => {
  await withCase(async ({ adapter, authority, handle, request, aborts }) => {
    const initial = adapter.journal.get(handle.handleId)
    const turnKey = `pi-turn:${initial.attemptId}:initial`
    const firstGeneration = generation(initial.attemptId, turnKey, 'pi-generation:first')
    adapter.journal.update(handle.handleId, initial.epoch, {
      detail: { ...initial.detail, activeInference: firstGeneration },
    })
    authority.loseNextCommitResponse()

    await expect(adapter.cancel(handle, request)).rejects.toThrow(
      'PI_CANCELLATION_COMMIT_OUTCOME_UNKNOWN'
    )
    const secondGeneration = generation(initial.attemptId, turnKey, 'pi-generation:second')
    const afterUnknown = adapter.journal.get(handle.handleId)
    adapter.journal.update(handle.handleId, afterUnknown.epoch, {
      detail: { ...afterUnknown.detail, activeInference: secondGeneration },
    })

    expect((await adapter.cancel(handle, request)).state).toBe('running')
    const retained = adapter.journal.get(handle.handleId)
    expect(retained.state).toBe('running')
    expect(retained.detail.activeInference).toEqual(secondGeneration)
    expect(retained.detail.cancellationIntent).toBeUndefined()
    expect(retained.detail.cancellationResolutions).toMatchObject({
      [`cancel:${request.idempotencyKey}`]: {
        authorityIntentId: authority.intentForHandle(handle.handleId).intentId,
        resolution: 'target_generation_superseded',
        generation: firstGeneration,
      },
    })
    expect(aborts()).toBe(0)
    await expect(authority.pending()).resolves.toHaveLength(0)

    const firstIntent = authority.intentForKey(handle.handleId, request.idempotencyKey)
    const g2Request = { idempotencyKey: 'cancel:committed:G2', requestedAt: at }
    expect((await adapter.cancel(handle, g2Request)).state).toBe('cancelling')
    const secondIntent = authority.intentForKey(handle.handleId, g2Request.idempotencyKey)
    expect(secondIntent.intentId).not.toBe(firstIntent.intentId)
    expect(secondIntent.generation).toEqual(secondGeneration)
    const afterG2Cancel = adapter.journal.get(handle.handleId)
    expect(afterG2Cancel.detail.cancellationIntent.authorityIntentId).toBe(secondIntent.intentId)
    expect(afterG2Cancel.detail.cancellationIntent.generation).toEqual(secondGeneration)

    // Replaying the immutable G1 key still returns its original owner intent and leaves G2 intact.
    expect((await adapter.cancel(handle, request)).state).toBe('cancelling')
    expect(authority.intentForKey(handle.handleId, request.idempotencyKey)).toEqual(firstIntent)
    expect(adapter.journal.get(handle.handleId).detail.cancellationIntent.authorityIntentId).toBe(
      secondIntent.intentId
    )
    expect(aborts()).toBe(0)
    await expect(authority.pending()).resolves.toHaveLength(0)
  })
})

test('startup acknowledges pending G1 after G2 cancellation without replacing G2 state', async () => {
  await withCase(async ({ adapter, authority, handle, request, aborts }) => {
    const initial = adapter.journal.get(handle.handleId)
    const turnKey = `pi-turn:${initial.attemptId}:initial`
    const firstGeneration = generation(initial.attemptId, turnKey, 'pi-generation:first')
    adapter.journal.update(handle.handleId, initial.epoch, {
      detail: { ...initial.detail, activeInference: firstGeneration },
    })
    authority.loseNextCommitResponse()
    await expect(adapter.cancel(handle, request)).rejects.toThrow(
      'PI_CANCELLATION_COMMIT_OUTCOME_UNKNOWN'
    )

    const secondGeneration = generation(initial.attemptId, turnKey, 'pi-generation:second')
    const afterUnknown = adapter.journal.get(handle.handleId)
    adapter.journal.update(handle.handleId, afterUnknown.epoch, {
      detail: { ...afterUnknown.detail, activeInference: secondGeneration },
    })
    const secondRequest = { idempotencyKey: 'cancel:committed:G2', requestedAt: at }
    expect((await adapter.cancel(handle, secondRequest)).state).toBe('cancelling')
    const secondIntent = authority.intentForKey(handle.handleId, secondRequest.idempotencyKey)

    await expect(adapter.recoverCommittedCancellationIntents()).resolves.toEqual([])

    const retained = adapter.journal.get(handle.handleId)
    expect(retained.state).toBe('cancelling')
    expect(retained.detail.activeInference).toEqual(secondGeneration)
    expect(retained.detail.cancellationIntent.authorityIntentId).toBe(secondIntent.intentId)
    expect(retained.detail.cancellationIntent.generation).toEqual(secondGeneration)
    expect(retained.detail.cancellationResolutions).toMatchObject({
      [`cancel:${request.idempotencyKey}`]: {
        resolution: 'target_generation_superseded',
        generation: firstGeneration,
      },
    })
    expect(aborts()).toBe(0)
    await expect(authority.pendingHandles()).resolves.toEqual([])
  })
})

test('startup honors a persisted G1 resolution after ACK failed and G2 was cancelled', async () => {
  await withCase(async ({ adapter, authority, handle, request, aborts }) => {
    const initial = adapter.journal.get(handle.handleId)
    const turnKey = `pi-turn:${initial.attemptId}:initial`
    const firstGeneration = generation(initial.attemptId, turnKey, 'pi-generation:first')
    adapter.journal.update(handle.handleId, initial.epoch, {
      detail: { ...initial.detail, activeInference: firstGeneration },
    })
    authority.loseNextCommitResponse()
    await expect(adapter.cancel(handle, request)).rejects.toThrow(
      'PI_CANCELLATION_COMMIT_OUTCOME_UNKNOWN'
    )
    const secondGeneration = generation(initial.attemptId, turnKey, 'pi-generation:second')
    const afterUnknown = adapter.journal.get(handle.handleId)
    adapter.journal.update(handle.handleId, afterUnknown.epoch, {
      detail: { ...afterUnknown.detail, activeInference: secondGeneration },
    })

    authority.failNextAcknowledge()
    await expect(adapter.cancel(handle, request)).rejects.toThrow('PI_CANCELLATION_ACK_UNAVAILABLE')
    const persistedResolution = adapter.journal.get(handle.handleId).detail.cancellationResolutions[
      `cancel:${request.idempotencyKey}`
    ]
    expect(persistedResolution.generation).toEqual(firstGeneration)

    const secondRequest = { idempotencyKey: 'cancel:committed:G2', requestedAt: at }
    expect((await adapter.cancel(handle, secondRequest)).state).toBe('cancelling')
    const secondIntent = authority.intentForKey(handle.handleId, secondRequest.idempotencyKey)

    await expect(adapter.recoverCommittedCancellationIntents()).resolves.toEqual([])

    const retained = adapter.journal.get(handle.handleId)
    expect(retained.state).toBe('cancelling')
    expect(retained.detail.activeInference).toEqual(secondGeneration)
    expect(retained.detail.cancellationIntent.authorityIntentId).toBe(secondIntent.intentId)
    expect(retained.detail.cancellationIntent.generation).toEqual(secondGeneration)
    expect(retained.detail.cancellationResolutions[`cancel:${request.idempotencyKey}`]).toEqual(
      persistedResolution
    )
    expect(aborts()).toBe(0)
    await expect(authority.pendingHandles()).resolves.toEqual([])
  })
})

test('current-intent application reclassifies same-epoch G2 metadata atomically', async () => {
  await withCase(async ({ adapter, authority, handle, request, aborts, directory }) => {
    const initial = adapter.journal.get(handle.handleId)
    const turnKey = `pi-turn:${initial.attemptId}:initial`
    const firstGeneration = generation(initial.attemptId, turnKey, 'pi-generation:first')
    adapter.journal.update(handle.handleId, initial.epoch, {
      detail: { ...initial.detail, activeInference: firstGeneration },
    })
    authority.loseNextCommitResponse()
    await expect(adapter.cancel(handle, request)).rejects.toThrow(
      'PI_CANCELLATION_COMMIT_OUTCOME_UNKNOWN'
    )

    const secondGeneration = generation(initial.attemptId, turnKey, 'pi-generation:second')
    const competingJournal = new SqliteDurableJournal(join(directory, 'authority.sqlite'))
    let injected = false
    const originalTransition = adapter.journal.transitionCurrent.bind(adapter.journal)
    adapter.journal.transitionCurrent = (...args) => {
      if (!injected) {
        injected = true
        const current = competingJournal.get(handle.handleId)
        expect(current.state).toBe('running')
        competingJournal.updateCurrentMetadata(handle.handleId, (fresh) => {
          expect(fresh.epoch).toBe(current.epoch)
          return {
            value: undefined,
            detail: { activeInference: secondGeneration, g2OwnerMarker: 'live-G2' },
          }
        })
      }
      return originalTransition(...args)
    }
    try {
      expect((await adapter.cancel(handle, request)).state).toBe('running')
      expect(injected).toBe(true)
      const retained = adapter.journal.get(handle.handleId)
      expect(retained.state).toBe('running')
      expect(retained.detail.activeInference).toEqual(secondGeneration)
      expect(retained.detail.g2OwnerMarker).toBe('live-G2')
      expect(retained.detail.cancellationIntent).toBeUndefined()
      expect(
        retained.detail.cancellationResolutions[`cancel:${request.idempotencyKey}`]
      ).toMatchObject({
        generation: firstGeneration,
        resolution: 'target_generation_superseded',
      })
      expect(aborts()).toBe(0)
      await expect(authority.pendingHandles()).resolves.toEqual([])
    } finally {
      competingJournal.close()
    }
  })
})

test('one corrupt outbox handle does not block another handle recovery', async () => {
  await withCase(async ({ adapter, authority, setup, request, handle, aborts }) => {
    const secondRequest = structuredClone(setup.request)
    secondRequest.executionId = 'exe_01JBBCDEF0123456789ABCDEFG'
    secondRequest.attemptId = 'att_01JBBCDEF0123456789ABCDEFG'
    secondRequest.idempotencyKey = 'message:two'
    secondRequest.attemptBudget.executionId = secondRequest.executionId
    secondRequest.attemptBudget.attemptId = secondRequest.attemptId
    secondRequest.attemptBudget.reservationKey = `runtime-attempt:${secondRequest.attemptId}`
    const secondHandle = await adapter.start(secondRequest)
    await adapter.drain()
    const secondCompleted = adapter.journal.get(secondHandle.handleId)
    const secondStored = secondCompleted.admission
    adapter.journal.update(secondHandle.handleId, secondCompleted.epoch, {
      state: 'running',
      detail: {
        ...secondCompleted.detail,
        result: undefined,
        error: undefined,
        engineRunStarted: true,
        activeInference: undefined,
        inferencePending: true,
      },
    })
    authority.register({
      handleId: secondHandle.handleId,
      executionId: secondRequest.executionId,
      attemptId: secondRequest.attemptId,
      workspaceId: secondRequest.attemptBudget.workspaceId,
      admissionDigest: digest(secondStored),
      productRevision: secondStored.admission.authority.revision,
      expiresAt: secondStored.admission.authority.expiresAt,
      deadlineAt,
    })

    authority.loseNextCommitResponse()
    await expect(adapter.cancel(handle, request)).rejects.toThrow(
      'PI_CANCELLATION_COMMIT_OUTCOME_UNKNOWN'
    )
    const secondCancel = { idempotencyKey: 'cancel:handle-two', requestedAt: at }
    authority.failNextAcknowledge()
    await expect(adapter.cancel(secondHandle, secondCancel)).rejects.toThrow(
      'PI_CANCELLATION_ACK_UNAVAILABLE'
    )
    authority.corruptPendingBody(handle.handleId, request.idempotencyKey)

    await expect(adapter.recoverCommittedCancellationIntents()).resolves.toEqual([handle.handleId])

    expect(adapter.journal.get(secondHandle.handleId).state).toBe('cancelling')
    expect(adapter.journal.get(secondHandle.handleId).detail.cancellationIntent.requestDigest).toBe(
      digest(secondCancel)
    )
    await expect(authority.pendingHandles()).resolves.toEqual([handle.handleId])
    await expect(authority.pendingForHandle(secondHandle.handleId)).resolves.toEqual([])
    await expect(authority.pendingForHandle(handle.handleId)).rejects.toThrow()
    expect(aborts()).toBe(0)

    const reopenedRuntime = await createNodePiDurableRuntime(setup.options)
    try {
      expect(reopenedRuntime.recoveryBlocked).toContainEqual({
        handleId: handle.handleId,
        code: 'PI_CANCELLATION_RECOVERY_UNAVAILABLE',
      })
      expect(reopenedRuntime.adapter.journal.get(handle.handleId).state).toBe('running')
    } finally {
      await reopenedRuntime.close()
    }
  })
})

test('startup outbox recovery safely resolves an old generation while a newer one is active', async () => {
  await withCase(async ({ adapter, authority, handle, request, aborts }) => {
    const initial = adapter.journal.get(handle.handleId)
    const turnKey = `pi-turn:${initial.attemptId}:initial`
    const firstGeneration = generation(initial.attemptId, turnKey, 'pi-generation:first')
    adapter.journal.update(handle.handleId, initial.epoch, {
      detail: { ...initial.detail, activeInference: firstGeneration },
    })
    authority.loseNextCommitResponse()
    await expect(adapter.cancel(handle, request)).rejects.toThrow(
      'PI_CANCELLATION_COMMIT_OUTCOME_UNKNOWN'
    )
    const secondGeneration = generation(initial.attemptId, turnKey, 'pi-generation:second')
    const afterUnknown = adapter.journal.get(handle.handleId)
    adapter.journal.update(handle.handleId, afterUnknown.epoch, {
      detail: { ...afterUnknown.detail, activeInference: secondGeneration },
    })

    await adapter.recoverCommittedCancellationIntents()

    const retained = adapter.journal.get(handle.handleId)
    expect(retained.state).toBe('running')
    expect(retained.detail.activeInference).toEqual(secondGeneration)
    expect(retained.detail.cancellationIntent).toBeUndefined()
    expect(retained.detail.cancellationResolutions).toMatchObject({
      [`cancel:${request.idempotencyKey}`]: {
        authorityIntentId: authority.intentForHandle(handle.handleId).intentId,
        resolution: 'target_generation_superseded',
        generation: firstGeneration,
      },
    })
    expect(aborts()).toBe(0)
    await expect(authority.pending()).resolves.toHaveLength(0)
  })
})

test('superseded cancellation merge preserves a same-epoch G2 completion from another journal connection', async () => {
  await withCase(async ({ adapter, authority, handle, request, directory, completedResult }) => {
    const initial = adapter.journal.get(handle.handleId)
    const turnKey = `pi-turn:${initial.attemptId}:initial`
    const firstGeneration = generation(initial.attemptId, turnKey, 'pi-generation:first')
    adapter.journal.update(handle.handleId, initial.epoch, {
      detail: { ...initial.detail, activeInference: firstGeneration },
    })
    authority.loseNextCommitResponse()
    await expect(adapter.cancel(handle, request)).rejects.toThrow(
      'PI_CANCELLATION_COMMIT_OUTCOME_UNKNOWN'
    )

    const secondGeneration = generation(initial.attemptId, turnKey, 'pi-generation:second')
    const afterUnknown = adapter.journal.get(handle.handleId)
    adapter.journal.update(handle.handleId, afterUnknown.epoch, {
      detail: {
        ...afterUnknown.detail,
        activeInference: secondGeneration,
        inferencePending: true,
      },
    })
    const stale = adapter.journal.get(handle.handleId)
    const competingJournal = new SqliteDurableJournal(join(directory, 'authority.sqlite'))
    let injected = false
    const interleave = () => {
      if (injected) return
      injected = true
      const current = competingJournal.get(handle.handleId)
      expect(current.epoch).toBe(stale.epoch)
      const completedRecordResult = structuredClone(completedResult)
      completedRecordResult.output = { text: 'G2 completed concurrently' }
      competingJournal.update(handle.handleId, current.epoch, {
        state: 'completed',
        detail: {
          ...current.detail,
          activeInference: undefined,
          inferencePending: false,
          result: completedRecordResult,
          inferenceReceipts: {
            ...current.detail.inferenceReceipts,
            [secondGeneration.inferenceKey]: { state: 'settled', usage: { inputTokens: 5 } },
          },
        },
      })
    }
    const originalTransition = adapter.journal.transitionCurrent.bind(adapter.journal)
    adapter.journal.transitionCurrent = (...args) => {
      interleave()
      return originalTransition(...args)
    }
    try {
      expect((await adapter.cancel(handle, request)).state).toBe('completed')
      expect(injected).toBe(true)
      const retained = adapter.journal.get(handle.handleId)
      expect(retained.epoch).toBe(stale.epoch)
      expect(retained.state).toBe('completed')
      expect(retained.detail.result.output).toEqual({ text: 'G2 completed concurrently' })
      expect(retained.detail.inferenceReceipts[secondGeneration.inferenceKey]).toEqual({
        state: 'settled',
        usage: { inputTokens: 5 },
      })
      expect(retained.detail.activeInference).toBeUndefined()
      expect(retained.detail.inferencePending).toBe(false)
      expect(retained.detail.cancellationResolutions).toMatchObject({
        [`cancel:${request.idempotencyKey}`]: {
          generation: firstGeneration,
          resolution: 'target_generation_superseded',
        },
      })
      await expect(authority.pending()).resolves.toHaveLength(0)
    } finally {
      competingJournal.close()
    }
  })
})

test('legacy cancellation action without a committed intent ID cannot replay as authorized', async () => {
  await withCase(async ({ adapter, authority, handle, aborts }) => {
    const request = { idempotencyKey: 'cancel:legacy', requestedAt: at }
    const requestDigest = digest(request)
    const record = adapter.journal.get(handle.handleId)
    adapter.journal.update(handle.handleId, record.epoch, {
      state: 'cancelling',
      detail: {
        ...record.detail,
        actions: { [`cancel:${request.idempotencyKey}`]: requestDigest },
        cancellationIntent: {
          schemaVersion: 'pi-cancellation-intent/v1',
          attemptId: record.attemptId,
          turnKey: `pi-turn:${record.attemptId}:initial`,
          requestedAt: at,
          requestDigest,
          targetKind: 'untracked_generation',
          generation: null,
        },
      },
    })
    let authorizeCalls = 0

    await expect(
      adapter.cancelFenced(handle, request, async () => {
        authorizeCalls += 1
      })
    ).rejects.toThrow('PI_CANCELLATION_AUTHORITY_UNAVAILABLE')

    expect(authorizeCalls).toBe(0)
    expect(authority.intentForHandle(handle.handleId)).toBeUndefined()
    expect(adapter.journal.get(handle.handleId).state).toBe('cancelling')
    expect(aborts()).toBe(0)
  })
})

test('fenced cancel without a committed authority capability refuses before callback or effect', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-cancel-unavailable-'))
  let adapter
  let aborts = 0
  try {
    const setup = fixture(directory, {
      engineFactory: async () => ({
        run: async () => ({
          text: 'answer',
          submissionId: 'answer',
          usage: { inputTokens: 3, outputTokens: 4, costUsd: '0.000007', durationMs: 2 },
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
        }),
        cancel: async () => {
          aborts += 1
        },
        close: async () => {},
      }),
    })
    adapter = new PiDurableRuntimeAdapter(setup.options)
    const handle = await adapter.start(setup.request)
    await adapter.drain()
    let authorizeCalls = 0
    const before = adapter.journal.get(handle.handleId)
    const fenced = new PiDurableRuntimeAdapter({
      ...setup.options,
      committedCancellationAuthority: undefined,
    })
    try {
      await expect(
        fenced.cancel(handle, { idempotencyKey: 'cancel:ordinary-unavailable', requestedAt: at })
      ).rejects.toThrow('PI_CANCELLATION_AUTHORITY_UNAVAILABLE')
      await expect(
        fenced.cancelFenced(
          handle,
          { idempotencyKey: 'cancel:unavailable', requestedAt: at },
          async () => {
            authorizeCalls += 1
          }
        )
      ).rejects.toThrow('PI_CANCELLATION_AUTHORITY_UNAVAILABLE')
      expect(authorizeCalls).toBe(0)
      expect(aborts).toBe(0)
      expect(fenced.journal.get(handle.handleId).state).toBe(before.state)
      expect(fenced.journal.get(handle.handleId).detail.cancellationIntent).toBeUndefined()
      expect(
        (await fenced.inspect()).capabilities.some(({ name }) => name === 'execution.cancel')
      ).toBe(false)
    } finally {
      await fenced.close()
    }
  } finally {
    await adapter?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
