import { expect, test } from 'bun:test'
import { createProductionFacadeRetention } from './production-facade-retention.ts'

test('missing canonical execution denies before provider resolution', async () => {
  let calls = 0
  const retention = createProductionFacadeRetention({
    executions: {},
    ledger: {},
    forgetNative() {},
    forgetCanonical() {},
  })
  await expect(
    retention.resolveProvider({ request: { attemptId: 'attempt' } }, async () => {
      calls++
    })
  ).rejects.toThrow('PI_PRODUCTION_EXECUTION_REQUIRED')
  expect(calls).toBe(0)
})

test('terminal released attempts free both caches beyond their capacity; unknown holds remain', async () => {
  const freedNative = [],
    freedCanonical = []
  const retention = createProductionFacadeRetention({
    executions: {
      getAttempt: async (attemptId) => ({
        executionId: `exe-${attemptId}`,
        state: attemptId === 'active' ? 'running' : 'completed',
      }),
    },
    ledger: {
      assertRuntimeAttemptReleased: async (_workspace, _execution, attemptId) => {
        if (attemptId === 'unknown') throw new Error('UNKNOWN_HOLD')
      },
    },
    forgetNative: (authority) => freedNative.push(authority.request.attemptId),
    forgetCanonical: (binding) => freedCanonical.push(binding.attemptId),
  })
  for (const attemptId of [
    ...Array.from({ length: 300 }, (_, i) => String(i)),
    'unknown',
    'active',
  ]) {
    retention.rememberBinding({
      workspaceId: 'workspace',
      executionId: `exe-${attemptId}`,
      attemptId,
    })
    retention.rememberAuthority({ request: { executionId: `exe-${attemptId}`, attemptId } })
  }
  await Promise.all([retention.collect(), retention.collect()])
  expect(freedNative).toHaveLength(300)
  expect(freedCanonical).toEqual(freedNative)
  await retention.collect()
  expect(freedNative).toHaveLength(300)
  expect(freedNative).not.toContain('unknown')
  expect(freedNative).not.toContain('active')
})

test('resolution failure after facade allocation remains tracked until terminal release', async () => {
  let released = false
  const freed = []
  const retention = createProductionFacadeRetention({
    executions: { getAttempt: async () => ({ executionId: 'execution', state: 'failed' }) },
    ledger: {
      assertRuntimeAttemptReleased: async () => {
        if (!released) throw new Error('HOLD')
      },
    },
    forgetNative: () => freed.push('native'),
    forgetCanonical: () => freed.push('canonical'),
  })
  // Composition registers the authority before native resolution can allocate then fail.
  await expect(
    retention.resolveProvider(
      { request: { executionId: 'execution', attemptId: 'attempt' } },
      async () => {
        retention.rememberBinding({
          workspaceId: 'workspace',
          executionId: 'execution',
          attemptId: 'attempt',
        })
        throw new Error('CREDENTIAL_REVOKED')
      }
    )
  ).rejects.toThrow('CREDENTIAL_REVOKED')
  await retention.collect()
  expect(freed).toEqual([])
  released = true
  await retention.collect()
  expect(freed).toEqual(['native', 'canonical'])
})
