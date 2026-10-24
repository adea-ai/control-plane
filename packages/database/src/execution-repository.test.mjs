import { describe, expect, test } from 'bun:test'
import { fromExecutionRow, toExecutionRow } from './execution-repository.js'

const execution = {
  executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  state: 'accepted',
  version: 1,
  correlation: {
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
    projectId: 'prj_01JABCDEF0123456789ABCDEFG',
    taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
    agentId: 'agt_01JABCDEF0123456789ABCDEFG',
    requestId: 'req_01JABCDEF0123456789ABCDEFG',
  },
  executionPlan: {
    executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
    contentDigest: `sha256:${'b'.repeat(64)}`,
    schemaVersion: 1,
  },
  attemptCount: 0,
  acceptedAt: '2026-08-28T11:59:59.000Z',
  createdAt: '2026-08-28T11:59:59.000Z',
  updatedAt: '2026-08-28T11:59:59.000Z',
}

describe('the execution row mapping (M12/#678)', () => {
  test('an accepted model survives the row round trip', () => {
    const row = toExecutionRow({ ...execution, modelId: 'deepseek-flash' })
    expect(row.modelId).toBe('deepseek-flash')
    const read = fromExecutionRow(row)
    expect(read.modelId).toBe('deepseek-flash')
    expect(read.executionPlan.contentDigest).toBe(execution.executionPlan.contentDigest)
  })

  test('a historical row without a model replays exactly as it did', () => {
    const row = toExecutionRow(execution)
    expect(row.modelId).toBeNull()
    const read = fromExecutionRow(row)
    expect(read.modelId).toBeUndefined()
    expect(read.executionPlan.contentDigest).toBe(execution.executionPlan.contentDigest)
    expect(read.correlation).toEqual(execution.correlation)
  })
})
