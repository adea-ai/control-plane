import { expect, test } from 'bun:test'
import { createPiLeadRuntimeAuthorityRouter } from './runtime-authority-router.ts'

test('lineage selects separate child admission and current authority without lead fallback', async () => {
  const calls = []
  const port = (name) => ({
    async resolveAdmission(request) {
      calls.push([name, 'resolve', request])
      return name
    },
    async assertAuthority(authority) {
      calls.push([name, 'assert', authority])
    },
  })
  const router = createPiLeadRuntimeAuthorityRouter(port('lead'), port('child'))
  const lead = { executionPlan: {} }
  const child = { executionPlan: { parentExecutionPlan: { executionPlanId: 'retained-parent' } } }
  expect(await router.resolveAdmission(lead)).toBe('lead')
  expect(await router.resolveAdmission(child)).toBe('child')
  await router.assertAuthority({ request: child })
  expect(calls.map(([name, operation]) => [name, operation])).toEqual([
    ['lead', 'resolve'],
    ['child', 'resolve'],
    ['child', 'assert'],
  ])
  expect(calls[1][2]).toBe(child)
})

test('missing or rejecting child authority never invokes lead admission', async () => {
  let leadCalls = 0
  const lead = {
    async resolveAdmission() {
      leadCalls++
      return {}
    },
    async assertAuthority() {
      leadCalls++
    },
  }
  const request = { executionPlan: { parentExecutionPlan: {} } }
  const missing = createPiLeadRuntimeAuthorityRouter(lead)
  await expect(missing.resolveAdmission(request)).rejects.toThrow('PI_CHILD_AUTHORITY_REQUIRED')
  await expect(missing.assertAuthority({ request })).rejects.toThrow('PI_CHILD_AUTHORITY_REQUIRED')
  const denied = createPiLeadRuntimeAuthorityRouter(lead, {
    async resolveAdmission() {
      throw new Error('CHILD_CURRENT_AUTHORITY_DENIED')
    },
    async assertAuthority() {
      throw new Error('CHILD_CURRENT_AUTHORITY_DENIED')
    },
  })
  await expect(denied.resolveAdmission(request)).rejects.toThrow('CHILD_CURRENT_AUTHORITY_DENIED')
  await expect(denied.assertAuthority({ request })).rejects.toThrow(
    'CHILD_CURRENT_AUTHORITY_DENIED'
  )
  expect(leadCalls).toBe(0)
})
