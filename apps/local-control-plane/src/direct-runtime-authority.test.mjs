import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { FilesystemObjectStore } from '@control-plane/object-store'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { RuntimeStartRequestSchema } from '@control-plane/runtime-sdk'
import { DirectRuntimeActivityPort } from './direct-runtime-activities.ts'

const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
const executionId = 'exe_01JABCDEF0123456789ABCDEFG'

async function fixture(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-runtime-authority-'))
  const persistence = new SqlitePersistenceProvider({
    path: join(directory, 'state.sqlite'),
    profile: 'local',
  })
  try {
    await persistence.migrate()
    const starts = []
    const runtime = {
      transportKind: 'direct-local',
      async start(input) {
        starts.push(input)
        RuntimeStartRequestSchema.parse(input)
        throw new Error('STOP_AT_RUNTIME_BOUNDARY')
      },
    }
    const objectStore = new FilesystemObjectStore({
      rootDirectory: join(directory, 'artifacts'),
      maxObjectBytes: 1024,
    })
    await operation({
      activity: new DirectRuntimeActivityPort(persistence, objectStore, runtime),
      starts,
      persistence,
    })
  } finally {
    await persistence.close()
    await rm(directory, { recursive: true, force: true })
  }
}

function input(change = {}) {
  const executionPlan = createExecutionPlanTestFixture()
  return {
    executionId,
    attemptId,
    executionPlan,
    effectKey: 'budget:direct-start',
    attemptBudget: {
      schemaVersion: 1,
      workspaceId: executionPlan.correlation.workspaceId,
      executionId,
      attemptId,
      executionPlanId: executionPlan.executionPlanId,
      executionPlanDigest: executionPlan.contentDigest,
      reservationKey: `runtime-attempt:${attemptId}`,
      currency: 'USD',
      maximumMicrounits: 1,
      maximumTokens: 2,
      ...change,
    },
  }
}

test('direct runtime forwards the validated reservation separately from the pinned plan', async () => {
  await fixture(async ({ activity, starts }) => {
    const request = input()
    await expect(activity.dispatch(request)).rejects.toThrow('STOP_AT_RUNTIME_BOUNDARY')
    expect(starts).toHaveLength(1)
    expect(starts[0].executionId).toBe(executionId)
    expect(starts[0].attemptBudget).toEqual(request.attemptBudget)
    expect(Object.isFrozen(starts[0].attemptBudget)).toBe(true)
    expect(starts[0].executionPlan).toEqual(request.executionPlan)
  })
})

test('invalid direct authority cannot record a dispatch intent or invoke the runtime', async () => {
  await fixture(async ({ activity, starts, persistence }) => {
    await expect(
      activity.dispatch(input({ executionId: 'exe_01JBBCDEF0123456789ABCDEFG' }))
    ).rejects.toThrow()
    expect(starts).toHaveLength(0)
    expect(await persistence.transaction((tx) => tx.list('workflow-effects'))).toEqual([])
  })
})
