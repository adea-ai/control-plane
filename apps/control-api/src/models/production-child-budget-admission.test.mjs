import { expect, test } from 'bun:test'
import { selection } from './model-selection-fixtures.mjs'
import { createProductionChildBudgetAdmissionAuthority } from './production-child-budget-admission.ts'

const actor = 'user:11111111-1111-4111-8111-111111111111'
const parentIntentId = '11111111-1111-4111-8111-111111111112'
const digest = (character) => `sha256:${character.repeat(64)}`
const request = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  parentIntentId,
  parentExecutionId: 'exe_01JABCDEF0123456789ABCDEFG',
  parentAttemptId: 'att_01JABCDEF0123456789ABCDEFG',
  parentExecutionVersion: 4,
  parentPlan: {
    executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
    contentDigest: digest('a'),
    schemaVersion: 2,
  },
  admittedToolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
  delegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
  childRequestId: 'req_01JBBCDEF0123456789ABCDEFG',
  childExecutionId: 'exe_01JBBCDEF0123456789ABCDEFG',
  childAttemptId: 'att_01JBBCDEF0123456789ABCDEFG',
  childDispatch: {
    delegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
    childAttemptId: 'att_01JBBCDEF0123456789ABCDEFG',
    runtime: { runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG' },
    dispatchedAt: '2026-10-09T12:00:05.000Z',
  },
  childPlan: {
    executionPlanId: 'pln_01JBBCDEF0123456789ABCDEFG',
    contentDigest: digest('b'),
    schemaVersion: 2,
  },
  role: 'researcher',
  profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
  originalActorPrincipalId: actor,
  childRequestDigest: digest('c'),
  acceptedAt: '2026-10-09T12:00:00.000Z',
}
const current = {
  workspaceId: request.workspaceId,
  parentIntentId,
  childRequestId: request.childRequestId,
  executionId: request.childExecutionId,
  attemptId: request.childAttemptId,
  executionPlanId: request.childPlan.executionPlanId,
  executionPlanDigest: request.childPlan.contentDigest,
  parentExecutionPlanId: request.parentPlan.executionPlanId,
  parentExecutionPlanDigest: request.parentPlan.contentDigest,
  canonicalActorPrincipalId: actor,
  productReaderPrincipalId: 'svc_product-reader',
  authorityRevision: 7,
  expiresAt: '2026-10-09T12:01:00.000Z',
}

function fixture() {
  const state = { current: structuredClone(current), selection: structuredClone(selection) }
  const calls = []
  const authority = createProductionChildBudgetAdmissionAuthority({
    now: () => '2026-10-09T12:00:10.000Z',
    async readCurrent(input) {
      expect(input).toEqual(request)
      return state.current
    },
    product: {
      async resolveChildSelection(input, child) {
        calls.push({ input, child })
        return state.selection
      },
    },
  })
  return { state, calls, authority }
}

test('production child preflight pins current actor, parent product selection, and ready child model by reference', async () => {
  const f = fixture()
  const receipt = await f.authority.prepare(request)
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0].input).toEqual({
    schemaVersion: 'pi-lead-intent/v1',
    workspaceId: request.workspaceId,
    intentId: parentIntentId,
    principalId: 'svc_product-reader',
  })
  expect(f.calls[0].child).toMatchObject({
    childRequestId: request.childRequestId,
    canonicalActorPrincipalId: actor,
  })
  expect(f.calls[0].child).not.toHaveProperty('requestedSelection')
  expect(receipt).toMatchObject({
    schemaVersion: 'pi-child-admission/v1',
    authorityRevision: 7,
    productReaderPrincipalId: 'svc_product-reader',
    selectionRef: selection.selectionRef,
    selectionRevision: selection.selectionRevision,
    expiresAt: current.expiresAt,
  })
  expect(receipt.productRevision).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(receipt).not.toHaveProperty('credentialRef')
  expect(receipt).not.toHaveProperty('providerModel')

  await f.authority.assertCurrent(request, receipt)
  expect(f.calls).toHaveLength(2)
})

test('production child preflight rejects current actor, audience, plan, or expiry changes', async () => {
  for (const mutate of [
    (state) =>
      (state.current.canonicalActorPrincipalId = 'user:22222222-2222-4222-8222-222222222222'),
    (state) => (state.current.executionPlanDigest = digest('d')),
    (state) => (state.current.expiresAt = '2026-10-09T12:00:05.000Z'),
  ]) {
    const f = fixture()
    const receipt = await f.authority.prepare(request)
    mutate(f.state)
    await expect(f.authority.assertCurrent(request, receipt)).rejects.toThrow()
  }
})

test('production child preflight rejects a changed ready selection before allocation can recheck it', async () => {
  const f = fixture()
  const receipt = await f.authority.prepare(request)
  f.state.selection = { ...f.state.selection, selectionRevision: 2 }
  await expect(f.authority.assertCurrent(request, receipt)).rejects.toThrow(
    'PI_CHILD_MODEL_AUTHORITY_CHANGED'
  )
})

test('production child preflight fails closed when actor audience or child-model readiness is unavailable', async () => {
  const f = fixture()
  f.state.current = undefined
  await expect(f.authority.prepare(request)).rejects.toThrow()

  const unavailable = createProductionChildBudgetAdmissionAuthority({
    now: () => '2026-10-09T12:00:10.000Z',
    readCurrent: async () => current,
    product: {
      resolveChildSelection: async () => {
        throw new Error('MODEL_NOT_READY')
      },
    },
  })
  await expect(unavailable.prepare(request)).rejects.toThrow('MODEL_NOT_READY')
})
