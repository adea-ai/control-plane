import { expect, test } from 'bun:test'
import { DelegationService } from './delegation.ts'
import { createFixture, ids } from './delegation-fixtures.mjs'

import {
  workspaceInput,
  currentSnapshot,
  actor,
  now,
  workspaceScope,
} from './delegation-workspace-fixtures.mjs'

async function fixture({ authority, resolveCallerPrincipalId = async () => actor } = {}) {
  const compiled = workspaceInput()
  const f = await createFixture(undefined, { parentPlan: compiled.parentPlan })
  const reads = []
  const scopeAdmission = {
    now: () => now,
    resolveCallerPrincipalId,
    authority: authority ?? {
      async readCurrent(input) {
        reads.push(structuredClone(input))
        return currentSnapshot(input)
      },
    },
  }
  const options = {
    delegations: f.delegations,
    lifecycle: f.lifecycle,
    plans: f.plans,
    events: { publish: async (event) => f.events.push(event) },
  }
  return {
    ...f,
    ...compiled,
    reads,
    options,
    scopeAdmission,
    scoped: new DelegationService({ ...options, scopeAdmission }),
  }
}

test('workspace delegation narrows to the real project with both exact current pins; revoked replay is denied', async () => {
  const f = await fixture()
  expect(() => f.scoped.deriveChildPlan(f.parentPlan, f.command.childPlan)).toThrow(
    'CHILD_AUTHORITY_EXPANSION'
  )
  const first = await f.scoped.delegate(f.command)
  expect(first.plan.schemaVersion).toBe(2)
  expect(first.plan.correlation.projectId).toBe(ids.projectId)
  expect(f.parentPlan.correlation.projectId).toBeUndefined()
  expect(f.reads.map((value) => value.executionScope.kind)).toEqual([
    'workspace',
    'project',
    'workspace',
    'project',
  ])
  expect(f.reads[0].executionPlan.contentDigest).toBe(f.parentPlan.contentDigest)
  expect(f.reads[1].executionPlan.contentDigest).toBe(first.plan.contentDigest)
  expect((await f.scoped.delegate(f.command)).record).toEqual(first.record)
  const revoked = new DelegationService({
    ...f.options,
    scopeAdmission: {
      ...f.scopeAdmission,
      authority: {
        readCurrent: async (input) => ({ ...currentSnapshot(input), grantActive: false }),
      },
    },
  })
  await expect(revoked.delegate(f.command)).rejects.toThrow('SCOPE_ADMISSION_DENIED')
  expect(await f.delegations.listByParent(ids.parentExecutionId)).toHaveLength(1)
})

test('explicit workspace delegation without a trusted scope authority persists no child', async () => {
  const f = await fixture()
  await expect(new DelegationService(f.options).delegate(f.command)).rejects.toThrow(
    'SCOPE_ADMISSION_DENIED'
  )
  expect(await f.executions.getExecution(ids.childExecutionId)).toBeUndefined()
  expect(await f.delegations.listByParent(ids.parentExecutionId)).toEqual([])
})

for (const altered of [
  { principalActive: false },
  { grantActive: false },
  { allowedPrincipalIds: [] },
  { callerPrincipalId: 'service:http-transport' },
  { expiresAt: now },
  { projectWorkspaceId: 'wsp_01JCBCDEF0123456789ABCDEFG' },
  {
    executionPlan: {
      executionPlanId: 'pln_01JCBCDEF0123456789ABCDEFG',
      contentDigest: `sha256:${'f'.repeat(64)}`,
      schemaVersion: 2,
    },
  },
  { executionScope: workspaceScope },
]) {
  test(`real project current-authority denial ${JSON.stringify(altered)} creates no child`, async () => {
    const f = await fixture({
      authority: {
        readCurrent: async (input) =>
          input.executionScope.kind === 'project'
            ? { ...currentSnapshot(input), ...altered }
            : currentSnapshot(input),
      },
    })
    await expect(f.scoped.delegate(f.command)).rejects.toThrow('CHILD_AUTHORITY_EXPANSION')
    expect(await f.executions.getExecution(ids.childExecutionId)).toBeUndefined()
    expect(await f.delegations.listByParent(ids.parentExecutionId)).toEqual([])
  })
}

test('current scope is rechecked after derivation before any child write', async () => {
  let reads = 0
  const f = await fixture({
    authority: {
      async readCurrent(input) {
        return { ...currentSnapshot(input), grantActive: ++reads <= 2 }
      },
    },
  })
  await expect(f.scoped.delegate(f.command)).rejects.toThrow('SCOPE_ADMISSION_DENIED')
  expect(await f.executions.getExecution(ids.childExecutionId)).toBeUndefined()
  expect(await f.delegations.listByParent(ids.parentExecutionId)).toEqual([])
})

test('governed child readiness denial occurs before child plan or allocation writes', async () => {
  const f = await fixture()
  const parentAttempt = await f.lifecycle.createAttempt({
    executionId: ids.parentExecutionId,
    attemptId: ids.childAttemptId,
    expectedExecutionVersion: 1,
    queuedAt: '2026-08-25T18:00:30.000Z',
  })
  const input = {
    ...f.command,
    parentIntentId: 'intent:workspace-parent',
    parentAttemptId: parentAttempt.attemptId,
    childAttemptId: 'att_01JBBCDEF0123456789ABCDEFG',
    admittedToolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
    initialDispatch: {
      delegationId: ids.delegationId,
      childAttemptId: 'att_01JBBCDEF0123456789ABCDEFG',
      runtime: { runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG' },
      dispatchedAt: '2026-08-25T18:00:40.000Z',
    },
  }
  let allocated = 0
  const planWrites = []
  const governed = new DelegationService({
    ...f.options,
    plans: {
      get: (reference) => f.plans.get(reference),
      async put(plan) {
        planWrites.push(plan)
        return f.plans.put(plan)
      },
    },
    scopeAdmission: f.scopeAdmission,
    childAdmission: {
      async prepare() {
        return { malformed: 'receipt' }
      },
      async assertCurrent() {
        throw new Error('must not be reached')
      },
    },
    childAllocator: {
      async allocate() {
        allocated += 1
        return true
      },
    },
  })

  await expect(governed.delegate(input)).rejects.toMatchObject({
    code: 'CHILD_ADMISSION_DENIED',
  })
  expect(planWrites).toEqual([])
  expect(allocated).toBe(0)
  expect(await f.executions.getExecution(ids.childExecutionId)).toBeUndefined()
  expect(await f.executions.listAttempts(ids.childExecutionId)).toEqual([])
  expect(await f.delegations.listByParent(ids.parentExecutionId)).toEqual([])
  expect(f.events).toEqual([])
})

test('governed child fails closed when the product admission/allocator ports are missing', async () => {
  const f = await fixture()
  const parentAttempt = await f.lifecycle.createAttempt({
    executionId: ids.parentExecutionId,
    attemptId: ids.childAttemptId,
    expectedExecutionVersion: 1,
    queuedAt: '2026-08-25T18:00:30.000Z',
  })
  await expect(
    f.scoped.delegate({
      ...f.command,
      parentIntentId: 'intent:workspace-parent',
      parentAttemptId: parentAttempt.attemptId,
      childAttemptId: 'att_01JBBCDEF0123456789ABCDEFG',
      admittedToolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
    })
  ).rejects.toMatchObject({ code: 'CHILD_ADMISSION_UNAVAILABLE' })
  expect(await f.executions.getExecution(ids.childExecutionId)).toBeUndefined()
  expect(await f.executions.listAttempts(ids.childExecutionId)).toEqual([])
  expect(await f.delegations.listByParent(ids.parentExecutionId)).toEqual([])
  expect(f.events).toEqual([])
})

test('replay does not substitute an HTTP service for the recorded product actor', async () => {
  const f = await fixture()
  await f.scoped.delegate(f.command)
  const transport = new DelegationService({
    ...f.options,
    scopeAdmission: {
      ...f.scopeAdmission,
      resolveCallerPrincipalId: async () => 'service:http-transport',
    },
  })
  await expect(transport.delegate(f.command)).rejects.toThrow('SCOPE_ADMISSION_DENIED')
  expect(await f.delegations.listByParent(ids.parentExecutionId)).toHaveLength(1)
})
