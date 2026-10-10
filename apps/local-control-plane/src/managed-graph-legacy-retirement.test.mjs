import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { ManagedLocalGraphRuntime } from './managed-graph-runtime.ts'

// Composition proof for the local production adapter: the resume fence and admission gate the runtime builds,
// exercised through the same activity boundary the workflow runtime calls. Disposable local store only.
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
const storageThread = `${workspaceId}:${executionId}:thread-1`
const graph = {
  graphDefinitionId: 'legacy-graph',
  graphVersion: '1.0.0',
  contentDigest: `sha256:${'b'.repeat(64)}`,
}

function resumeInput(checkpointId) {
  return {
    executionId,
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    workspaceId,
    workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
    graph,
    threadId: 'thread-1',
    checkpointId,
    response: { action: 'approve' },
    idempotencyKey: 'legacy:composition:resume',
  }
}

async function localRuntime() {
  const directory = await mkdtemp(join(tmpdir(), 'local-legacy-retirement-'))
  const persistence = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  await persistence.migrate()
  const runtime = new ManagedLocalGraphRuntime(persistence, {
    capabilities: [],
    compiler: {
      operationAllowlist: [],
      schemaRegistry: { getValidator: () => undefined },
      maximumSteps: 8,
    },
    operations: {
      async invoke() {
        return { value: 'unused' }
      },
      async cancel() {
        return true
      },
    },
  })
  const api = { commandRepository: {}, executions: {}, executionPlans: {}, executionEvents: {} }
  return { directory, persistence, runtime, activities: runtime.activities(api) }
}

describe('local managed graph runtime legacy retirement composition (M16.03, #940)', () => {
  test('a held drain fence refuses resume through the production adapter until its exact claim is released', async () => {
    const { directory, persistence, runtime, activities } = await localRuntime()
    try {
      const claim = await runtime.legacyDrainFence.claim({
        storageThreadId: storageThread,
        owner: 'drain-a',
      })
      await expect(activities.resumeGraphSegment(resumeInput('ckpt-1'))).rejects.toMatchObject({
        code: 'LEGACY_DRAIN_FENCE_HELD',
      })
      expect(await runtime.legacyDrainFence.release(claim)).toBe(true)
      const afterRelease = await activities.resumeGraphSegment(resumeInput('ckpt-1')).then(
        () => undefined,
        (error) => error
      )
      expect(afterRelease?.code).not.toBe('LEGACY_DRAIN_FENCE_HELD')
    } finally {
      persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('the local retirement status is bounded, never claims zero, and keeps admission open', async () => {
    const { directory, persistence, runtime } = await localRuntime()
    try {
      const status = await runtime.legacyRetirementStatus()
      expect(status).toMatchObject({
        schema: 'langgraph-legacy-operator-status/v1',
        scope: 'disposable-local-store',
        readComplete: true,
        zero: { established: false },
        removal: { satisfied: false },
        admission: { decision: 'open' },
      })
    } finally {
      persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('a run passes the production admission gate, which does not refuse the local store', async () => {
    const { directory, persistence, activities } = await localRuntime()
    try {
      const refusal = await activities
        .runGraphSegment({
          executionId,
          attemptId: 'att_01JABCDEF0123456789ABCDEFG',
          workspaceId,
          workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
          graph,
          threadId: 'thread-1',
          input: { objective: 'composition admission check' },
          idempotencyKey: 'legacy:composition:run',
        })
        .then(
          () => undefined,
          (error) => error
        )
      expect(refusal?.code).not.toBe('LEGACY_ADMISSION_CLOSED')
    } finally {
      persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
