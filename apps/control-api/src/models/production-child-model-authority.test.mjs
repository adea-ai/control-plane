import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { ExecutionPlanCompiler, deriveExecutionPlan } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { createProductionChildModelAuthority } from './production-child-model-authority.ts'

const at = '2026-10-08T00:00:00.000Z'
const actor = `user:${randomUUID()}`
const selection = { selectionRef: `msel_${'b'.repeat(32)}`, selectionRevision: 1 }
function fixture() {
  const base = createExecutionPlanTestFixtureInputs()
  const parent = new ExecutionPlanCompiler('1.0.0').compile(base)
  const plan = deriveExecutionPlan(parent, {
    correlation: { ...parent.correlation, requestId: 'req_01JBBCDEF0123456789ABCDEFG' },
    contextPackage: base.contextPackage,
    constraints: structuredClone(parent.constraints),
    runtimeRequirements: structuredClone(parent.runtimeRequirements),
    outputContract: parent.outputContract,
    compiledAt: at,
  })
  const request = {
    executionId: 'exe_01JBBCDEF0123456789ABCDEFG',
    attemptId: 'att_01JBBCDEF0123456789ABCDEFG',
    idempotencyKey: 'child:model',
    executionPlan: plan,
  }
  const state = {
    admits: 0,
    selects: 0,
    current: 0,
    denied: false,
    record: {
      workspaceId: plan.correlation.workspaceId,
      parentIntentId: randomUUID(),
      childRequestId: plan.correlation.requestId,
      executionId: request.executionId,
      attemptId: request.attemptId,
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
      parentExecutionPlanId: parent.executionPlanId,
      parentExecutionPlanDigest: parent.contentDigest,
      canonicalActorPrincipalId: actor,
      productReaderPrincipalId: 'svc_product',
      authorityRevision: 1,
      expiresAt: '2026-10-08T01:00:00.000Z',
      requestedSelection: selection,
    },
  }
  const options = {
    now: () => at,
    readCurrent: async () => state.record,
    product: {
      resolveChildSelection: async (input, child) => {
        state.selects++
        expect(input.principalId).toBe('svc_product')
        expect(child.canonicalActorPrincipalId).toBe(actor)
        expect(child.requestedSelection).toEqual(selection)
        if (state.denied) throw new Error('CHILD_SELECTION_REVOKED')
        return selection
      },
    },
    admit: async (_request, chosen) => {
      state.admits++
      return {
        schemaVersion: 'pi-durable-admission/v1',
        prompt: 'Synthetic child',
        canonicalActorPrincipalId: actor,
        selection: chosen,
        authority: {
          revision: 1,
          principalRef: 'svc_child',
          scopeRef: 'scope:child',
          expiresAt: state.record.expiresAt,
        },
      }
    },
    assertCurrent: async () => {
      state.current++
    },
  }
  return { request, state, options }
}
test('child selection readiness runs before canonical admission; exact selection rechecked on resume', async () => {
  const { request, state, options } = fixture()
  const port = createProductionChildModelAuthority(options)
  const admission = await port.resolveAdmission(request)
  expect(admission.selection).toEqual(selection)
  expect(state.admits).toBe(1)
  expect(state.selects).toBe(2)
  await port.assertAuthority({ request, admission })
  expect(state.selects).toBe(3)
  state.denied = true
  await expect(port.assertAuthority({ request, admission })).rejects.toThrow(
    'CHILD_SELECTION_REVOKED'
  )
  expect(state.admits).toBe(1)
})
test('missing current child, changed lineage, expiry or revoked selection cannot allocate', async () => {
  for (const fault of ['missing', 'parent', 'attempt', 'expired', 'revoked']) {
    const { request, state, options } = fixture()
    if (fault === 'missing') state.record = undefined
    if (fault === 'parent') state.record.parentExecutionPlanDigest = `sha256:${'f'.repeat(64)}`
    if (fault === 'attempt') state.record.attemptId = 'att_01JCBCDEF0123456789ABCDEFG'
    if (fault === 'expired') state.record.expiresAt = at
    if (fault === 'revoked') state.denied = true
    await expect(
      createProductionChildModelAuthority(options).resolveAdmission(request)
    ).rejects.toThrow()
    expect(state.admits).toBe(0)
  }
})
test('canonical admission cannot silently replace selected child model or original actor', async () => {
  for (const fault of ['selection', 'actor']) {
    const { request, options } = fixture()
    const admit = options.admit
    options.admit = async (...args) => {
      const value = await admit(...args)
      if (fault === 'selection')
        value.selection = { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 }
      else value.canonicalActorPrincipalId = `user:${randomUUID()}`
      return value
    }
    await expect(
      createProductionChildModelAuthority(options).resolveAdmission(request)
    ).rejects.toThrow('PI_CHILD_MODEL_SELECTION_CHANGED')
  }
})

test('child revoked, expired or changed during model readiness cannot allocate', async () => {
  for (const fault of ['revoked', 'expired', 'actor', 'lineage', 'clock']) {
    const { request, state, options } = fixture()
    const select = options.product.resolveChildSelection
    let invalid = false
    options.now = () => (invalid ? 'invalid' : at)
    options.product.resolveChildSelection = async (...args) => {
      const value = await select(...args)
      if (fault === 'revoked') state.record = undefined
      if (fault === 'expired') state.record.expiresAt = at
      if (fault === 'actor') state.record.canonicalActorPrincipalId = `user:${randomUUID()}`
      if (fault === 'lineage') state.record.parentExecutionPlanDigest = `sha256:${'a'.repeat(64)}`
      if (fault === 'clock') invalid = true
      return value
    }
    await expect(
      createProductionChildModelAuthority(options).resolveAdmission(request)
    ).rejects.toThrow()
    expect(state.admits).toBe(0)
  }
})
