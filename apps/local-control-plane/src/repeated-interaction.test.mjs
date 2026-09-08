import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InteractionService } from '@control-plane/domain'
import {
  SqlitePersistenceProvider,
  SqliteInteractionRepository,
} from '@control-plane/sqlite-persistence'
import { FilesystemObjectStore } from '@control-plane/object-store'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { DirectRuntimeActivityPort } from './direct-runtime-activities.ts'
import { LocalRuntimeInteractions } from './runtime-interactions.ts'

test('two durable approvals skip resolved history and replay each effect without another submission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-repeated-interaction-'))
  const persistence = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  const objectStore = new FilesystemObjectStore({
    rootDirectory: join(directory, 'artifacts'),
    maxObjectBytes: 4096,
  })
  const executionId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const attemptId = 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const ids = ['int_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'int_01ARZ3NDEKTSV4RRFFQ69G5FAW']
  const handle = { handleId: 'native:repeated', attemptId, startedAt: new Date().toISOString() }
  const plan = createExecutionPlanTestFixture()
  const submissions = []
  let completed = false
  const runtime = {
    transportKind: 'direct-local',
    start: async () => handle,
    async *progress() {
      // Every subscription replays all historical events, like native ACP.
      for (let index = 0; index < ids.length; index++) {
        if (index > submissions.length) break
        yield {
          handleId: handle.handleId,
          sequence: index + 1,
          occurredAt: handle.startedAt,
          type: 'interaction',
          data: { interactionId: ids[index], kind: 'permission' },
        }
      }
      if (submissions.length === 2) completed = true
    },
    status: async () =>
      completed
        ? {
            handle,
            state: 'completed',
            observedAt: handle.startedAt,
            result: {
              outcome: 'completed',
              output: { ok: true },
              usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
              artifacts: [],
            },
          }
        : { handle, state: 'awaiting_input', observedAt: handle.startedAt },
    async submitApproval(_, request) {
      expect(request.interactionId).toBe(ids[submissions.length])
      submissions.push(request)
      return { handle, state: 'running', observedAt: handle.startedAt }
    },
  }
  try {
    await persistence.migrate()
    const repository = new SqliteInteractionRepository(persistence)
    const bridge = new LocalRuntimeInteractions(repository, {
      getByExecutionId: async () => ({
        executionId,
        ...plan.correlation,
        callerPrincipalId: 'svc_owner',
        retentionExpiresAt: '2099-01-01T00:00:00.000Z',
      }),
      getExecution: async () => ({
        latestAttemptId: attemptId,
        state: 'awaiting_input',
        correlation: plan.correlation,
      }),
    })
    const activities = new DirectRuntimeActivityPort(persistence, objectStore, runtime, bridge)
    expect(
      await activities.dispatch({
        executionId,
        attemptId,
        executionPlan: plan,
        effectKey: 'repeated:dispatch',
      })
    ).toEqual({ outcome: 'awaiting_input', interactionId: ids[0] })
    for (let index = 0; index < ids.length; index++) {
      const response = {
        executionId,
        attemptId,
        interactionId: ids[index],
        responseId: `cmd_01ARZ3NDEKTSV4RRFFQ69G5FA${index === 0 ? 'V' : 'W'}`,
        action: 'grant',
      }
      expect((await repository.get(ids[index])).state).toBe('pending')
      await new InteractionService(repository).respond({
        ...response,
        expectedVersion: 1,
        respondingPrincipalId: 'svc_owner',
        respondedAt: new Date().toISOString(),
      })
      const input = { ...response, effectKey: `repeated:response:${index}` }
      const outcome = await activities.applyInteraction(input)
      expect(outcome).toMatchObject(
        index === 0
          ? { outcome: 'awaiting_input', interactionId: ids[1] }
          : { outcome: 'completed' }
      )
      expect(await activities.applyInteraction(input)).toEqual(outcome)
      expect(submissions).toHaveLength(index + 1)
    }
    expect(
      (await repository.listForAttempt(executionId, attemptId)).map((request) => request.state)
    ).toEqual(['responded', 'responded'])
  } finally {
    persistence.close()
    objectStore.close()
    await rm(directory, { recursive: true, force: true })
  }
})
