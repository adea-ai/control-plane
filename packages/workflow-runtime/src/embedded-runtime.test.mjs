import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { WorkflowJobStore } from './embedded-job-store.ts'
import {
  EmbeddedExecutionWorkflowDispatcher,
  EmbeddedWorkflowSubmissionError,
  EmbeddedWorkflowRuntime,
  createEmbeddedWorkflowExecution,
} from './embedded-runtime.ts'

const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
const interactionId = 'int_01JABCDEF0123456789ABCDEFG'

const workflowInput = {
  executionId,
  workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
  executionPlan: {
    executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
    contentDigest: `sha256:${'a'.repeat(64)}`,
    schemaVersion: 1,
  },
  deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
}

const interactionRequest = {
  interactionId,
  executionId,
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  kind: 'approval',
  prompt: { title: 'Approve deployment' },
  allowedActions: ['approve', 'deny', 'cancel'],
  allowedPrincipalIds: ['user:agent-hq-42'],
  state: 'responded',
  version: 1,
  requestedAt: '2026-09-18T12:00:00.000Z',
  expiresAt: '2026-09-18T12:30:00.000Z',
  response: {
    responseId: 'cmd_01JABCDEF0123456789ABCDEFG',
    action: 'approve',
    respondingPrincipalId: 'user:agent-hq-42',
    respondedAt: '2026-09-18T12:05:00.000Z',
  },
}

const cancellationCommand = {
  caller: { servicePrincipalId: 'svc_agent-hq' },
  contractVersion: { major: 3, minor: 0 },
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
  commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
  idempotencyKey: 'intent-01JABCDEF0123456789ABCDEFG',
  payloadHash: 'a'.repeat(64),
  projectId: 'prj_01JABCDEF0123456789ABCDEFG',
  operation: 'execution.cancel',
  issuedAt: '2026-09-18T12:00:00.000Z',
  payload: { executionId },
}

/** Recording ExecutionLifecycleActivities double with overridable dispatch behavior. */
function fakeActivities(dispatch) {
  const calls = []
  const deferreds = []
  const activities = {
    calls,
    ensureAttempt: async (input) => {
      calls.push(['ensureAttempt', input])
      return { attemptId: 'att_01JABCDEF0123456789ABCDEFG' }
    },
    persistStatus: async (input) => {
      calls.push(['persistStatus', input])
    },
    dispatch: async (input) => {
      calls.push(['dispatch', input])
      return dispatch === undefined
        ? { outcome: 'completed', resultReference: 'ref://artifacts/done' }
        : dispatch(input, calls)
    },
    applyInteraction: async (input) => {
      calls.push(['applyInteraction', input])
      return { outcome: 'completed' }
    },
    runGraphSegment: async () => {
      throw new Error('GRAPH_SEGMENTS_NOT_USED')
    },
    resumeGraphSegment: async () => {
      throw new Error('GRAPH_SEGMENTS_NOT_USED')
    },
    continueGraphSegment: async () => {
      throw new Error('GRAPH_SEGMENTS_NOT_USED')
    },
    cancelActive: async (input) => {
      calls.push(['cancelActive', input])
    },
    cleanup: async (input) => {
      calls.push(['cleanup', input])
    },
  }
  return { activities, deferreds }
}

async function withRuntime(run) {
  const directory = await mkdtemp(join(tmpdir(), 'embedded-runtime-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'queue.sqlite') })
  await provider.migrate()
  try {
    await run({ provider, directory })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function startedRuntime(provider, activities, options = {}) {
  const store = new WorkflowJobStore(provider)
  const runtime = new EmbeddedWorkflowRuntime({
    provider,
    activities,
    pollIntervalMs: 10,
    leaseMs: 500,
    retryDelayMs: 10,
    ...options,
  })
  const dispatcher = new EmbeddedExecutionWorkflowDispatcher({ store })
  return { store, runtime, dispatcher }
}

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const started = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('EmbeddedExecutionWorkflowDispatcher', () => {
  test('enqueues parsed workflow input idempotently per execution', async () => {
    await withRuntime(async ({ provider }) => {
      const { store, dispatcher } = startedRuntime(provider, fakeActivities().activities)
      await dispatcher.submit(workflowInput)
      await dispatcher.submit(workflowInput)
      const job = await store.get(executionId)
      expect(job.status).toBe('queued')
      expect(job.input).toEqual(workflowInput)
    })
  })

  test('rejects workflow input that fails the wire contract', async () => {
    await withRuntime(async ({ provider }) => {
      const { dispatcher } = startedRuntime(provider, fakeActivities().activities)
      await expect(
        dispatcher.submit({ ...workflowInput, workflowId: 'wfl_mismatched' })
      ).rejects.toThrow()
      await expect(
        dispatcher.submit({ ...workflowInput, deadlineAt: 'not-a-timestamp' })
      ).rejects.toThrow()
    })
  })

  test('stores cancellation intent for the execution', async () => {
    await withRuntime(async ({ provider }) => {
      const { store, dispatcher } = startedRuntime(provider, fakeActivities().activities)
      await dispatcher.cancel(cancellationCommand)
      expect(await store.getCancellation(executionId)).toEqual({
        commandId: cancellationCommand.commandId,
        requestedAt: await store.getCancellation(executionId).then((c) => c.requestedAt),
      })
    })
  })

  test('persists the response of a delivered interaction signal', async () => {
    await withRuntime(async ({ provider }) => {
      const { store, dispatcher } = startedRuntime(provider, fakeActivities().activities)
      await dispatcher.deliver(interactionRequest)
      expect(await store.getInteractionResponse(executionId, interactionId)).toEqual({
        interactionId,
        responseId: interactionRequest.response.responseId,
        action: 'approve',
      })
    })
  })

  test('rejects signals that are not confirmed responses', async () => {
    await withRuntime(async ({ provider }) => {
      const { dispatcher } = startedRuntime(provider, fakeActivities().activities)
      const pending = { ...interactionRequest, state: 'pending', response: undefined }
      await expect(dispatcher.deliver(pending)).rejects.toThrow(EmbeddedWorkflowSubmissionError)
    })
  })
})

describe('EmbeddedWorkflowRuntime', () => {
  test('drives accepted work to completion through the portable lifecycle', async () => {
    await withRuntime(async ({ provider }) => {
      const { activities } = fakeActivities()
      const { store, runtime, dispatcher } = startedRuntime(provider, activities)
      await runtime.start()
      await dispatcher.submit(workflowInput)
      await waitFor(async () => (await store.get(executionId))?.status === 'succeeded')

      const job = await store.get(executionId)
      expect(job.outcome.status).toBe('completed')
      expect(job.outcome.resultReference).toBe('ref://artifacts/done')
      const effectKeys = activities.calls
        .filter(([name]) => name === 'persistStatus')
        .map(([, input]) => input.effectKey)
      expect(effectKeys).toEqual([
        `${workflowInput.workflowId}:execution-lifecycle-v1:queued`,
        `${workflowInput.workflowId}:execution-lifecycle-v1:starting`,
        `${workflowInput.workflowId}:execution-lifecycle-v1:running`,
        `${workflowInput.workflowId}:execution-lifecycle-v1:completed`,
      ])
      const dispatchCall = activities.calls.find(([name]) => name === 'dispatch')
      expect(dispatchCall[1].executionId).toBe(executionId)
      await runtime.stop()
    })
  })

  test('duplicate submissions run the workflow exactly once', async () => {
    await withRuntime(async ({ provider }) => {
      const { activities } = fakeActivities()
      const { store, runtime, dispatcher } = startedRuntime(provider, activities)
      await runtime.start()
      await dispatcher.submit(workflowInput)
      await dispatcher.submit(workflowInput)
      await waitFor(async () => (await store.get(executionId))?.status === 'succeeded')
      expect(activities.calls.filter(([name]) => name === 'dispatch')).toHaveLength(1)
      await runtime.stop()
    })
  })

  test('keeps active runs within the claim limit across polling intervals', async () => {
    await withRuntime(async ({ provider }) => {
      const executionIds = [
        'exe_01JABCDEF0123456789ABCDEFG',
        'exe_01JABCDEF0123456789ABCDEFH',
        'exe_01JABCDEF0123456789ABCDEFJ',
      ]
      const entered = []
      const releases = new Map()
      let runtimeClockReads = 0
      const now = () => {
        runtimeClockReads += 1
        return new Date().toISOString()
      }
      const { activities } = fakeActivities(
        (input) =>
          new Promise((resolve) => {
            entered.push(input.executionId)
            releases.set(input.executionId, () => resolve({ outcome: 'completed' }))
          })
      )
      const { store, runtime, dispatcher } = startedRuntime(provider, activities, {
        claimLimit: 1,
        pollIntervalMs: 10,
        now,
      })

      await Promise.all(
        executionIds.map((jobExecutionId) =>
          dispatcher.submit({
            ...workflowInput,
            executionId: jobExecutionId,
            workflowId: `wfl_${jobExecutionId.slice(4)}`,
          })
        )
      )
      await runtime.start()

      try {
        for (
          let expectedEntered = 1;
          expectedEntered <= executionIds.length;
          expectedEntered += 1
        ) {
          await waitFor(() => entered.length === expectedEntered)
          // Observe several queue scans while the current run stays blocked.
          // No later job may enter until the active run releases its capacity.
          const clockReadsAtEntry = runtimeClockReads
          await waitFor(() => runtimeClockReads >= clockReadsAtEntry + 3)
          expect(entered).toHaveLength(expectedEntered)
          releases.get(entered.at(-1))()
        }

        await waitFor(async () =>
          Promise.all(executionIds.map((jobExecutionId) => store.get(jobExecutionId))).then(
            (jobs) => jobs.every((job) => job?.status === 'succeeded')
          )
        )
        expect(new Set(entered)).toEqual(new Set(executionIds))
      } finally {
        for (const release of releases.values()) release()
        await runtime.stop()
      }
    })
  })

  test('parks on awaiting_input and resumes when the interaction response arrives', async () => {
    await withRuntime(async ({ provider }) => {
      const { activities } = fakeActivities(() => ({
        outcome: 'awaiting_input',
        interactionId,
      }))
      const { store, runtime, dispatcher } = startedRuntime(provider, activities)
      await runtime.start()
      await dispatcher.submit(workflowInput)
      await waitFor(async () => (await store.get(executionId))?.status === 'waiting')

      await dispatcher.deliver(interactionRequest)
      await waitFor(async () => (await store.get(executionId))?.status === 'succeeded')
      const apply = activities.calls.find(([name]) => name === 'applyInteraction')
      expect(apply[1].interactionId).toBe(interactionId)
      expect(apply[1].action).toBe('approve')
      expect((await store.get(executionId)).outcome.status).toBe('completed')
      await runtime.stop()
    })
  })

  test('cancellation while parked finishes the workflow as cancelled', async () => {
    await withRuntime(async ({ provider }) => {
      const { activities } = fakeActivities(() => ({
        outcome: 'awaiting_input',
        interactionId,
      }))
      const { store, runtime, dispatcher } = startedRuntime(provider, activities)
      await runtime.start()
      await dispatcher.submit(workflowInput)
      await waitFor(async () => (await store.get(executionId))?.status === 'waiting')

      await dispatcher.cancel(cancellationCommand)
      await waitFor(async () => (await store.get(executionId))?.status === 'succeeded')
      const job = await store.get(executionId)
      expect(job.outcome.status).toBe('cancelled')
      const cancel = activities.calls.find(([name]) => name === 'cancelActive')
      expect(cancel[1].reason).toBe('user_request')
      await runtime.stop()
    })
  })

  test('a passed deadline finishes a hung workflow as timed_out', async () => {
    await withRuntime(async ({ provider }) => {
      const { activities } = fakeActivities(() => new Promise(() => {}))
      const { store, runtime, dispatcher } = startedRuntime(provider, activities)
      await runtime.start()
      await dispatcher.submit({
        ...workflowInput,
        // Long enough that the runner claims the job and creates the attempt
        // first (even on a loaded CI host); the deadline then interrupts the
        // hung dispatch activity mid-flight.
        deadlineAt: new Date(Date.now() + 750).toISOString(),
      })
      await waitFor(async () => activities.calls.some(([name]) => name === 'dispatch'), 5_000)
      await waitFor(async () => (await store.get(executionId))?.status === 'succeeded', 15_000)
      const job = await store.get(executionId)
      expect(job.outcome.status).toBe('timed_out')
      const cancel = activities.calls.find(([name]) => name === 'cancelActive')
      expect(cancel[1].reason).toBe('deadline')
      await runtime.stop()
    }, 30_000)
  })

  test('retries a failed run and completes on a later attempt', async () => {
    await withRuntime(async ({ provider }) => {
      let attempts = 0
      const { activities } = fakeActivities(() => {
        attempts += 1
        if (attempts === 1) throw new Error('TRANSIENT_RUNTIME_FAULT')
        return { outcome: 'completed' }
      })
      const { store, runtime, dispatcher } = startedRuntime(provider, activities)
      await runtime.start()
      await dispatcher.submit(workflowInput)
      await waitFor(async () => (await store.get(executionId))?.status === 'succeeded')
      expect((await store.get(executionId)).attempt).toBe(2)
      expect(activities.calls.filter(([name]) => name === 'dispatch')).toHaveLength(2)
      await runtime.stop()
    })
  })

  test('terminates after the final attempt and stops reclaiming', async () => {
    await withRuntime(async ({ provider }) => {
      const { activities } = fakeActivities(() => {
        throw new Error('PERMANENT_RUNTIME_FAULT')
      })
      const { store, runtime, dispatcher } = startedRuntime(provider, activities, {
        maximumAttempts: 2,
      })
      await runtime.start()
      await dispatcher.submit(workflowInput)
      await waitFor(async () => (await store.get(executionId))?.status === 'failed')
      await waitFor(async () => (await store.get(executionId))?.runAt === undefined)
      const job = await store.get(executionId)
      expect(job.attempt).toBe(2)
      expect(job.lastError.message).toBe('PERMANENT_RUNTIME_FAULT')
      const dispatches = activities.calls.filter(([name]) => name === 'dispatch').length
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(activities.calls.filter(([name]) => name === 'dispatch').length).toBe(dispatches)
      await runtime.stop()
    })
  })

  test('replays journaled activities instead of re-executing them on a retry', async () => {
    await withRuntime(async ({ provider }) => {
      const counts = { persistStatus: 0, dispatch: 0 }
      const { activities } = fakeActivities(() => {
        counts.dispatch += 1
        if (counts.dispatch === 1) throw new Error('DISPATCH_ATTEMPT_FAILED')
        return { outcome: 'completed' }
      })
      const originalPersistStatus = activities.persistStatus
      activities.persistStatus = async (input) => {
        counts.persistStatus += 1
        return originalPersistStatus(input)
      }
      const { store, runtime, dispatcher } = startedRuntime(provider, activities)
      await runtime.start()
      await dispatcher.submit(workflowInput)
      await waitFor(async () => (await store.get(executionId))?.status === 'succeeded')
      // The failed dispatch re-executes, but the already-persisted lifecycle
      // states replay from the journal exactly once; only the terminal
      // persistStatus('completed') executes for the first time.
      expect(counts.dispatch).toBe(2)
      expect(counts.persistStatus).toBe(4)
      expect((await store.get(executionId)).outcome.status).toBe('completed')
      await runtime.stop()
    })
  })

  test('reclaims jobs whose runner lease lapsed, at-least-once', async () => {
    await withRuntime(async ({ provider }) => {
      const { activities } = fakeActivities()
      const { store, dispatcher } = startedRuntime(provider, activities)
      await dispatcher.submit(workflowInput)
      // Simulate a runner that claimed the job and died before completing.
      await store.claimDue({
        owner: 'dead-runner',
        leaseMs: 30,
        now: new Date().toISOString(),
        limit: 1,
      })

      const recovery = startedRuntime(provider, activities)
      await recovery.runtime.start()
      await waitFor(async () => (await store.get(executionId))?.status === 'succeeded')
      expect((await store.get(executionId)).attempt).toBe(2)
      await recovery.runtime.stop()
    })
  })

  test('stopping interrupts parked waiters and a fresh runtime resumes the work', async () => {
    await withRuntime(async ({ provider }) => {
      const { activities } = fakeActivities(() => ({
        outcome: 'awaiting_input',
        interactionId,
      }))
      const first = startedRuntime(provider, activities)
      const { store } = first
      await first.runtime.start()
      await first.dispatcher.submit(workflowInput)
      await waitFor(async () => (await store.get(executionId))?.status === 'waiting')
      await first.runtime.stop()

      // The interrupted park is immediately re-claimable; nothing was lost.
      const parked = await store.get(executionId)
      expect(parked.status).toBe('failed')
      expect(parked.runAt !== undefined).toBe(true)

      const second = startedRuntime(provider, activities)
      await second.runtime.start()
      await second.dispatcher.deliver(interactionRequest)
      await waitFor(async () => (await store.get(executionId))?.status === 'succeeded')
      expect((await store.get(executionId)).outcome.status).toBe('completed')
      await second.runtime.stop()
    })
  })

  test('health reports readiness only while the runtime is running', async () => {
    await withRuntime(async ({ provider }) => {
      const { runtime } = startedRuntime(provider, fakeActivities().activities)
      expect((await runtime.health()).ready).toBe(false)
      await runtime.start()
      expect((await runtime.health()).ready).toBe(true)
      await runtime.stop()
      expect((await runtime.health()).ready).toBe(false)
    })
  })

  test('start and stop are idempotent-safe', async () => {
    await withRuntime(async ({ provider }) => {
      const { runtime } = startedRuntime(provider, fakeActivities().activities)
      await runtime.start()
      await expect(runtime.start()).rejects.toThrow('EMBEDDED_RUNTIME_ALREADY_STARTED')
      await runtime.stop()
      await runtime.stop()
    })
  })
})

describe('createEmbeddedWorkflowExecution', () => {
  test('pairs a runtime and dispatcher sharing one queue', async () => {
    await withRuntime(async ({ provider }) => {
      const { activities } = fakeActivities()
      const pair = createEmbeddedWorkflowExecution({
        provider,
        activities,
        pollIntervalMs: 10,
      })
      expect(pair.runtime).toBeInstanceOf(EmbeddedWorkflowRuntime)
      expect(pair.dispatcher).toBeInstanceOf(EmbeddedExecutionWorkflowDispatcher)
      await pair.runtime.start()
      await pair.dispatcher.submit(workflowInput)
      const store = new WorkflowJobStore(provider)
      await waitFor(async () => (await store.get(executionId))?.status === 'succeeded')
      await pair.runtime.stop()
    })
  })
})
