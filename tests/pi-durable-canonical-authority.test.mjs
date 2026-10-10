import { test, expect } from 'bun:test'
import { ExecutionLifecycleService, InMemoryExecutionRepository } from '@control-plane/domain'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { InMemoryExecutionPlanRepository } from '@control-plane/execution-plan'
import { CanonicalPiDurableAuthority } from '../packages/pi-durable-adapter/src/canonical-authority.ts'
import { workspacePlan } from './pi-durable-workspace-scope.fixture.mjs'
const at = '2026-10-08T00:00:00.000Z'
const later = '2026-10-08T01:00:00.000Z'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
async function fixture(plan = createExecutionPlanTestFixture()) {
  const executions = new InMemoryExecutionRepository()
  const lifecycle = new ExecutionLifecycleService(executions)
  const execution = await lifecycle.createExecution({
    executionId,
    correlation: plan.correlation,
    executionPlan: {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
      schemaVersion: plan.schemaVersion,
    },
    acceptedAt: at,
    deadlineAt: later,
  })
  await lifecycle.createAttempt({
    executionId,
    attemptId,
    expectedExecutionVersion: execution.version,
    queuedAt: at,
  })
  const plans = new InMemoryExecutionPlanRepository()
  await plans.put(plan)
  const intent = {
    intentId,
    workspaceId: plan.correlation.workspaceId,
    projectId: plan.correlation.projectId,
    ...(plan.correlation.executionScope
      ? {
          executionScope: plan.correlation.executionScope,
          canonicalActorPrincipalId: 'principal:user',
        }
      : {}),
    messageRef: 'message:one',
    executionId,
    attemptId,
    authorityRevision: 1,
    principalRef: 'principal:lead',
    scopeRef: 'channel:one',
    expiresAt: later,
    selectionRef: `msel_${'a'.repeat(32)}`,
    selectionRevision: 1,
    allowedPrincipalIds: ['principal:user'],
  }
  let current = {
    prompt: 'Canonical message',
    authorityRevision: 1,
    principalRef: intent.principalRef,
    scopeRef: intent.scopeRef,
    expiresAt: later,
    allowedPrincipalIds: intent.allowedPrincipalIds,
  }
  let budget = {
    schemaVersion: 1,
    workspaceId: intent.workspaceId,
    executionId,
    attemptId,
    executionPlanId: plan.executionPlanId,
    executionPlanDigest: plan.contentDigest,
    reservationKey: `runtime-attempt:${attemptId}`,
    currency: 'USD',
    maximumMicrounits: 1000,
    maximumTokens: 100,
  }
  const options = {
    intents: {
      get: async (id) => (id === intentId ? structuredClone(intent) : undefined),
      getByAttempt: async (id) => (id === attemptId ? structuredClone(intent) : undefined),
    },
    executions,
    plans,
    messages: { readCurrent: async () => structuredClone(current) },
    budgets: { resolve: async () => structuredClone(budget) },
    now: () => at,
  }
  return {
    options,
    authority: new CanonicalPiDurableAuthority(options),
    executions,
    lifecycle,
    intent,
    plan,
    setCurrent: (value) => {
      current = value
    },
    current,
    setBudget: (value) => {
      budget = value
    },
    budget,
  }
}
async function admitted(setup) {
  return setup.authority.get(intentId, setup.intent.workspaceId, 'principal:user')
}
test('canonical admission derives and freezes request, selection and budget from persisted authority', async () => {
  const setup = await fixture()
  const result = await admitted(setup)
  expect(result.startRequest).toMatchObject({
    executionId,
    attemptId,
    idempotencyKey: `lead-turn:${intentId}`,
    executionPlan: setup.plan,
    attemptBudget: setup.budget,
  })
  expect(result.admission.prompt).toBe('Canonical message')
  expect(result.allowedPrincipalIds).toEqual(['principal:user'])
  expect(result.deadlineAt).toBe(later)
  expect(result.admissionDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(Object.isFrozen(result.startRequest.executionPlan.constraints)).toBe(true)
  expect(Object.isFrozen(result.admission.selection)).toBe(true)
  await setup.authority.assertAuthority({
    request: result.startRequest,
    admission: result.admission,
  })
})
test('restart resolves admission through durable attempt mapping without process cache', async () => {
  const setup = await fixture()
  const result = await admitted(setup)
  const restarted = new CanonicalPiDurableAuthority(setup.options)
  expect(await restarted.resolveAdmission(result.startRequest)).toEqual(result.admission)
  await restarted.assertAuthority({ request: result.startRequest, admission: result.admission })
})
test('superseding attempt blocks startup replay of previous attempt', async () => {
  const setup = await fixture()
  const result = await admitted(setup)
  const current = await setup.executions.getExecution(executionId)
  await setup.lifecycle.createAttempt({
    executionId,
    attemptId: 'att_01JBBCDEF0123456789ABCDEFG',
    expectedExecutionVersion: current.version,
    queuedAt: at,
  })
  await expect(setup.authority.resolveAdmission(result.startRequest)).rejects.toThrow(
    'PI_CANONICAL_AUTHORITY_REJECTED'
  )
  await expect(
    setup.authority.assertAuthority({ request: result.startRequest, admission: result.admission })
  ).rejects.toThrow('PI_CANONICAL_AUTHORITY_REJECTED')
})
test('foreign workspace and principals outside audience are rejected', async () => {
  const setup = await fixture()
  await expect(
    setup.authority.get(intentId, 'wsp_01JBBCDEF0123456789ABCDEFG', 'principal:user')
  ).rejects.toThrow('PI_CANONICAL_AUTHORITY_REJECTED')
  await expect(
    setup.authority.get(intentId, setup.intent.workspaceId, 'principal:intruder')
  ).rejects.toThrow('PI_CANONICAL_AUTHORITY_REJECTED')
})
test('message deletion and changed grant identity fail safely on restart', async () => {
  for (const change of [
    undefined,
    { authorityRevision: 2 },
    { allowedPrincipalIds: [] },
    { scopeRef: 'channel:other' },
    { principalRef: 'principal:other' },
    { expiresAt: at },
  ]) {
    const setup = await fixture()
    const result = await admitted(setup)
    setup.setCurrent(change === undefined ? undefined : { ...setup.current, ...change })
    await expect(
      new CanonicalPiDurableAuthority(setup.options).assertAuthority({
        request: result.startRequest,
        admission: result.admission,
      })
    ).rejects.toThrow('PI_CANONICAL_AUTHORITY_REJECTED')
  }
})
test('callers cannot replace prompt, selection, plan, key or budget', async () => {
  const setup = await fixture()
  const result = await admitted(setup)
  for (const request of [
    { ...result.startRequest, idempotencyKey: 'forged-key' },
    {
      ...result.startRequest,
      attemptBudget: { ...result.startRequest.attemptBudget, maximumTokens: 99 },
    },
    {
      ...result.startRequest,
      executionPlan: {
        ...result.startRequest.executionPlan,
        contentDigest: `sha256:${'b'.repeat(64)}`,
      },
    },
  ])
    await expect(setup.authority.resolveAdmission(request)).rejects.toThrow(
      'PI_CANONICAL_AUTHORITY_REJECTED'
    )
  for (const admission of [
    { ...result.admission, prompt: 'Caller replacement' },
    { ...result.admission, selection: { ...result.admission.selection, selectionRevision: 2 } },
  ])
    await expect(
      setup.authority.assertAuthority({ request: result.startRequest, admission })
    ).rejects.toThrow('PI_CANONICAL_AUTHORITY_REJECTED')
})
test('budget change, expiry and execution cancellation prevent continuing authority', async () => {
  const setup = await fixture()
  const result = await admitted(setup)
  setup.setBudget({ ...setup.budget, maximumTokens: 99 })
  await expect(
    setup.authority.assertAuthority({ request: result.startRequest, admission: result.admission })
  ).rejects.toThrow('PI_CANONICAL_AUTHORITY_REJECTED')
  const expired = new CanonicalPiDurableAuthority({ ...setup.options, now: () => later })
  await expect(expired.get(intentId, setup.intent.workspaceId, 'principal:user')).rejects.toThrow(
    'PI_CANONICAL_AUTHORITY_REJECTED'
  )
  const execution = await setup.executions.getExecution(executionId)
  await setup.lifecycle.transitionExecution({
    executionId,
    expectedVersion: execution.version,
    to: 'cancelled',
    transitionedAt: at,
  })
  await expect(admitted(setup)).rejects.toThrow('PI_CANONICAL_AUTHORITY_REJECTED')
})
test('corrupt plans and source diagnostics cannot escape authority boundary', async () => {
  const setup = await fixture()
  const corrupt = new CanonicalPiDurableAuthority({
    ...setup.options,
    plans: { get: async () => ({ ...setup.plan, contentDigest: `sha256:${'b'.repeat(64)}` }) },
  })
  await expect(corrupt.get(intentId, setup.intent.workspaceId, 'principal:user')).rejects.toThrow(
    'PI_CANONICAL_AUTHORITY_REJECTED'
  )
  const unavailable = new CanonicalPiDurableAuthority({
    ...setup.options,
    messages: {
      readCurrent: async () => {
        throw new Error('secret-access-token')
      },
    },
  })
  try {
    await unavailable.get(intentId, setup.intent.workspaceId, 'principal:user')
    throw new Error('unexpected admission')
  } catch (error) {
    expect(error.message).toBe('PI_CANONICAL_AUTHORITY_REJECTED')
    expect(JSON.stringify(error)).not.toContain('secret-access-token')
  }
})

test('supersession while trusted ports are awaited is caught by the final lifecycle read', async () => {
  const setup = await fixture()
  const authority = new CanonicalPiDurableAuthority({
    ...setup.options,
    budgets: {
      resolve: async () => {
        const current = await setup.executions.getExecution(executionId)
        await setup.lifecycle.createAttempt({
          executionId,
          attemptId: 'att_01JBBCDEF0123456789ABCDEFG',
          expectedExecutionVersion: current.version,
          queuedAt: at,
        })
        return setup.budget
      },
    },
  })
  await expect(authority.get(intentId, setup.intent.workspaceId, 'principal:user')).rejects.toThrow(
    'PI_CANONICAL_AUTHORITY_REJECTED'
  )
})

test('execution deadline bounds admission even when product grant remains valid', async () => {
  const setup = await fixture()
  const current = await setup.executions.getExecution(executionId)
  const deadlineAt = '2026-10-08T00:30:00.000Z'
  expect(
    await setup.executions.compareAndSetExecution(current.version, {
      ...current,
      version: current.version + 1,
      deadlineAt,
    })
  ).toBe(true)
  expect((await admitted(setup)).deadlineAt).toBe(deadlineAt)
  const expired = new CanonicalPiDurableAuthority({ ...setup.options, now: () => deadlineAt })
  await expect(expired.get(intentId, setup.intent.workspaceId, 'principal:user')).rejects.toThrow(
    'PI_CANONICAL_AUTHORITY_REJECTED'
  )
})

test('read purpose retains canonical audience and allocation while terminal inference is blocked', async () => {
  const setup = await fixture()
  const execution = await setup.executions.getExecution(executionId)
  await setup.lifecycle.transitionExecution({
    executionId,
    expectedVersion: execution.version,
    to: 'cancelled',
    transitionedAt: at,
  })
  const read = await setup.authority.get(
    intentId,
    setup.intent.workspaceId,
    'principal:user',
    'read'
  )
  expect(read.startRequest.attemptBudget).toEqual(setup.budget)
  await expect(admitted(setup)).rejects.toThrow('PI_CANONICAL_AUTHORITY_REJECTED')
  setup.setCurrent({ ...setup.current, allowedPrincipalIds: [] })
  await expect(
    setup.authority.get(intentId, setup.intent.workspaceId, 'principal:user', 'read')
  ).rejects.toThrow('PI_CANONICAL_AUTHORITY_REJECTED')
})

test('workspace canonical intent retains actor independently of authorized read audience', async () => {
  const setup = await fixture(workspacePlan())
  setup.intent.canonicalActorPrincipalId = 'product:original-sender'
  setup.intent.allowedPrincipalIds.push('principal:observer')
  const result = await setup.authority.get(intentId, setup.intent.workspaceId, 'principal:observer')
  expect(result.admission.canonicalActorPrincipalId).toBe('product:original-sender')
  expect(result.allowedPrincipalIds).not.toContain('product:original-sender')
  expect(result.startRequest.executionPlan.schemaVersion).toBe(2)
  expect(result.startRequest.executionPlan.correlation.projectId).toBeUndefined()
  await setup.authority.assertAuthority({
    request: result.startRequest,
    admission: result.admission,
  })
  setup.intent.canonicalActorPrincipalId = 'principal:observer'
  await expect(
    setup.authority.assertAuthority({ request: result.startRequest, admission: result.admission })
  ).rejects.toThrow('PI_CANONICAL_AUTHORITY_REJECTED')
})

test('workspace canonical intent requires original actor and rejects cross-scope replacement', async () => {
  for (const mutation of [
    (intent) => {
      delete intent.canonicalActorPrincipalId
    },
    (intent) => {
      intent.projectId = 'prj_01JABCDEF0123456789ABCDEFG'
      intent.executionScope = { schemaVersion: 1, kind: 'project', projectId: intent.projectId }
    },
  ]) {
    const setup = await fixture(workspacePlan())
    mutation(setup.intent)
    await expect(admitted(setup)).rejects.toThrow('PI_CANONICAL_AUTHORITY_REJECTED')
  }
})

test('legacy canonical admission keeps absent scope and actor absent from serialized bytes', async () => {
  const setup = await fixture()
  const result = await admitted(setup)
  expect(Object.hasOwn(result.admission, 'canonicalActorPrincipalId')).toBe(false)
  expect(Object.hasOwn(result.startRequest.executionPlan.correlation, 'executionScope')).toBe(false)
  expect(result.startRequest.executionPlan.contentDigest).toBe(
    'sha256:dc03a107d310cf14591b6d34fba4ed6443faedfb8e972ac31f2a50957b3d86fe'
  )
})
