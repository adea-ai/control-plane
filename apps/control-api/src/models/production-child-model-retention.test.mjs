import { expect, test } from 'bun:test'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { createProductionChildModelRetention } from './production-child-model-retention.ts'

function fixture() {
  const plan = new ExecutionPlanCompiler('1.0.0').compile(createExecutionPlanTestFixtureInputs())
  const state = { terminal: true, released: true, native: 0, canonical: 0, checks: 0 }
  const collector = createProductionChildModelRetention({
    maximum: 1,
    executions: {
      getAttempt: async (attemptId) => ({
        attemptId,
        executionId: attemptId.replace('att_', 'exe_'),
        state: state.terminal ? 'completed' : 'running',
      }),
    },
    ledger: {
      assertRuntimeAttemptReleased: async () => {
        state.checks++
        if (!state.released) throw new Error('UNKNOWN_HOLD')
      },
    },
    forgetNative: () => state.native++,
    forgetCanonical: () => state.canonical++,
  })
  const authority = (index) => ({
    request: { executionId: `exe_${index}`, attemptId: `att_${index}`, executionPlan: plan },
    admission: { selection: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 } },
  })
  return { state, collector, authority }
}
test('terminal released child caches can serve more than 256 distinct admissions', async () => {
  const { state, collector, authority } = fixture()
  for (let index = 0; index < 300; index++) {
    collector.remember(authority(index))
    await collector.collect()
  }
  expect(state.native).toBe(300)
  expect(state.canonical).toBe(300)
  expect(state.checks).toBe(300)
})
test('running or uncertain physical sends retain child cache and deny eviction at capacity', async () => {
  const { state, collector, authority } = fixture()
  state.terminal = false
  collector.remember(authority(0))
  await collector.collect()
  expect(state.native).toBe(0)
  expect(state.checks).toBe(0)
  state.terminal = true
  state.released = false
  await collector.collect()
  expect(state.native).toBe(0)
  expect(() => collector.remember(authority(1))).toThrow('PI_CHILD_MODEL_FACADE_LIMIT_EXCEEDED')
  state.released = true
  await collector.collect()
  collector.remember(authority(1))
  await collector.collect()
  expect(state.native).toBe(2)
  expect(state.canonical).toBe(2)
})
test('immutable child cache slot rejects changed admission and missing execution identity', () => {
  const { collector, authority } = fixture()
  collector.remember(authority(0))
  const changed = authority(0)
  changed.admission.selection.selectionRevision = 2
  expect(() => collector.remember(changed)).toThrow('PI_CHILD_MODEL_BINDING_CHANGED')
  const missing = authority(1)
  delete missing.request.executionId
  expect(() => collector.remember(missing)).toThrow('PI_CHILD_MODEL_EXECUTION_REQUIRED')
})
