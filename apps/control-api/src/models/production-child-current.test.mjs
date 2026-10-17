import { expect, test } from 'bun:test'
import { selection } from './model-selection-fixtures.mjs'
import { deriveExecutionPlan, ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { ExecutionAttemptSchema, ExecutionSchema } from '@control-plane/domain'
import { contextPackageSerializationFixtures, deriveContextPackage } from '@control-plane/context'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { createProductionChildBudgetAdmissionAuthority } from './production-child-budget-admission.ts'
import { createProductionChildCurrent } from './production-child-current.ts'
import { createProductionChildModelAuthority } from './production-child-model-authority.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const parentExecutionId = 'exe_01JABCDEF0123456789ABCDEFG'
const parentAttemptId = 'att_01JABCDEF0123456789ABCDEFG'
const childExecutionId = 'exe_01JBBCDEF0123456789ABCDEFG'
const childAttemptId = 'att_01JBBCDEF0123456789ABCDEFG'
const intentId = '11111111-1111-4111-8111-111111111112'
const actor = 'user:11111111-1111-4111-8111-111111111111'
const reader = 'svc_product-reader'
const at = '2026-10-09T12:00:00.000Z'
const deadlineAt = '2026-10-09T12:01:00.000Z'
const expiredAt = '2026-10-09T12:01:01.000Z'
const digest = (character) => `sha256:${character.repeat(64)}`

function deferred() {
  let resolve
  const promise = new Promise((done) => (resolve = done))
  return { promise, resolve }
}

function fixture({
  holdProductReadAt,
  executionDeadline = deadlineAt,
  attemptDeadline = '2026-10-09T12:02:00.000Z',
} = {}) {
  const parentPlan = new ExecutionPlanCompiler('1.0.0').compile(
    createExecutionPlanTestFixtureInputs({
      profileCapabilityRequirements: [],
      skillRequiredCapabilities: [],
    })
  )
  const childConstraints = structuredClone(parentPlan.constraints)
  childConstraints.tools.grants[0].operations = ['read']
  childConstraints.limits.budget.maximumMicrounits = 1_000_000
  childConstraints.limits.tokens.maximumTotal = 10_000
  childConstraints.limits.duration.maximumMs = 600_000
  const childPlan = deriveExecutionPlan(parentPlan, {
    correlation: {
      ...parentPlan.correlation,
      taskId: 'tsk_01JBBCDEF0123456789ABCDEFG',
      requestId: 'req_01JBBCDEF0123456789ABCDEFG',
    },
    contextPackage: deriveContextPackage(contextPackageSerializationFixtures.futurePi, {
      objective: 'Complete focused research',
      allowedStateItemIds: [],
      allowedArtifactIds: [],
      budgets: { maximumBytes: 512, maximumTokens: 128 },
      successCriteria: ['Return evidence'],
      returnContract: { contractRef: 'contract://adapter-result/v1' },
      compiledAt: at,
    }),
    constraints: childConstraints,
    runtimeRequirements: parentPlan.runtimeRequirements,
    outputContract: parentPlan.outputContract,
    compiledAt: at,
  })
  const parentPin = {
    executionPlanId: parentPlan.executionPlanId,
    contentDigest: parentPlan.contentDigest,
    schemaVersion: parentPlan.schemaVersion,
  }
  const childPin = {
    executionPlanId: childPlan.executionPlanId,
    contentDigest: childPlan.contentDigest,
    schemaVersion: childPlan.schemaVersion,
  }
  const execution = ExecutionSchema.parse({
    executionId: parentExecutionId,
    state: 'running',
    version: 4,
    correlation: parentPlan.correlation,
    executionPlan: parentPin,
    attemptCount: 1,
    latestAttemptId: parentAttemptId,
    acceptedAt: at,
    queuedAt: at,
    startingAt: at,
    runningAt: at,
    deadlineAt: executionDeadline,
    createdAt: at,
    updatedAt: at,
  })
  const attempt = ExecutionAttemptSchema.parse({
    attemptId: parentAttemptId,
    executionId: parentExecutionId,
    sequence: 1,
    state: 'running',
    version: 2,
    acceptedAt: at,
    queuedAt: at,
    startingAt: at,
    runningAt: at,
    deadlineAt: attemptDeadline,
    createdAt: at,
    updatedAt: at,
  })
  const intent = {
    intentId,
    workspaceId,
    executionId: parentExecutionId,
    attemptId: parentAttemptId,
    canonicalActorPrincipalId: actor,
    authorityRevision: 1,
    expiresAt: '2026-10-09T13:00:00.000Z',
    allowedPrincipalIds: [reader],
  }
  const evidence = {
    schemaVersion: 'pi-lead-intent/v1',
    intentId,
    workspaceId,
    messageRef: `message:${intentId}`,
    authorityRevision: 1,
    principalRef: actor,
    canonicalActorPrincipalId: actor,
    scopeRef: `scope:${intentId}`,
    expiresAt: '2026-10-09T13:00:00.000Z',
    allowedPrincipalIds: [reader],
    prompt: 'A bounded parent task',
    profileId: 'profile:parent',
    profileVersion: '1',
    profileRevision: 1,
  }
  const delegation = {
    parentExecutionId,
    parentAttemptId,
    admittedToolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
    childAttemptId,
    childExecutionPlanId: childPlan.executionPlanId,
    childExecutionPlanDigest: childPlan.contentDigest,
    parentExecutionPlanId: parentPlan.executionPlanId,
    parentExecutionPlanDigest: parentPlan.contentDigest,
    objective: 'Inspect a bounded child task',
    state: 'dispatched',
  }
  const toolCall = {
    toolCallId: delegation.admittedToolCallId,
    executionId: parentExecutionId,
    attemptId: parentAttemptId,
    workspaceId,
    operation: 'delegate-child',
    status: 'succeeded',
  }
  const request = {
    workspaceId,
    parentIntentId: intentId,
    parentExecutionId,
    parentAttemptId,
    parentExecutionVersion: execution.version,
    parentPlan: parentPin,
    admittedToolCallId: delegation.admittedToolCallId,
    delegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
    childRequestId: childPlan.correlation.requestId,
    childExecutionId,
    childAttemptId,
    childDispatch: {
      delegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
      childAttemptId,
      runtime: { runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG' },
      dispatchedAt: at,
    },
    childPlan: childPin,
    role: 'researcher',
    profileVersionId: parentPlan.profile.profileVersionId,
    originalActorPrincipalId: actor,
    childRequestDigest: digest('c'),
    acceptedAt: at,
  }
  const held = deferred()
  const release = deferred()
  const state = { now: at, productReads: 0, productPurposes: [], modelUnavailable: false }
  const current = createProductionChildCurrent({
    assertRetainedProductCurrent: async () => {},
    executions: {
      async getExecution(id) {
        return id === parentExecutionId ? execution : undefined
      },
      async getAttempt(id) {
        return id === parentAttemptId ? attempt : undefined
      },
    },
    plans: {
      async get() {
        return childPlan
      },
    },
    intents: {
      async getByAttempt(id) {
        return id === parentAttemptId ? intent : undefined
      },
      marker(id) {
        return id === intentId
          ? {
              state: 'ready',
              workspaceId,
              actorPrincipalId: reader,
              intent,
              planPin: {
                executionPlanId: parentPlan.executionPlanId,
                contentDigest: parentPlan.contentDigest,
              },
            }
          : undefined
      },
    },
    delegations: {
      async get() {
        return delegation
      },
      async findByChild(id) {
        return id === childExecutionId ? delegation : undefined
      },
    },
    toolCalls: {
      async get(id) {
        return id === toolCall.toolCallId ? toolCall : undefined
      },
    },
    product: {
      async readCurrent(_input, context) {
        state.productPurposes.push(context?.purpose)
        if (state.modelUnavailable && context?.purpose !== 'observe')
          throw new Error('TEST_MODEL_UNAVAILABLE')
        state.productReads += 1
        if (state.productReads === holdProductReadAt) {
          held.resolve()
          await release.promise
        }
        return evidence
      },
    },
    now: () => state.now,
  })
  return {
    request,
    childPlan,
    current,
    state,
    evidence,
    delegation,
    heldProductRead: held.promise,
    advancePastDeadline() {
      state.now = expiredAt
    },
    releaseProductRead() {
      release.resolve()
    },
  }
}

test('child cancellation reads current product authority for observation, while inference stays blocked', async () => {
  const f = fixture()
  const request = {
    executionId: childExecutionId,
    attemptId: childAttemptId,
    idempotencyKey: 'child-cancel-model-unavailable',
    executionPlan: f.childPlan,
  }
  const original = await f.current.readRuntime(request)
  f.state.modelUnavailable = true
  await expect(f.current.readRuntime(request)).rejects.toThrow('TEST_MODEL_UNAVAILABLE')
  f.state.productPurposes = []
  expect(await f.current.readRuntime(request, 'cancel')).toEqual(original)
  expect(await f.current.readRecord(request, 'cancel')).toMatchObject({ current: original })
  expect(f.state.productPurposes).toEqual(['observe', 'observe', 'observe', 'observe'])
  f.evidence.allowedPrincipalIds = ['svc_other']
  await expect(f.current.readRuntime(request, 'cancel')).rejects.toThrow(
    'PI_CHILD_MODEL_AUTHORITY_DENIED'
  )
})

test('observation purpose preserves child actor, workspace, expiry and delegation fences', async () => {
  for (const fault of ['actor', 'workspace', 'revision', 'expiry', 'delegation']) {
    const f = fixture()
    if (fault === 'actor')
      f.evidence.canonicalActorPrincipalId = 'user:11111111-1111-4111-8111-111111111114'
    if (fault === 'workspace') f.evidence.workspaceId = 'wsp_01JCBCDEF0123456789ABCDEFG'
    if (fault === 'revision') f.evidence.authorityRevision = 2
    if (fault === 'expiry') f.evidence.expiresAt = at
    if (fault === 'delegation') f.delegation.childAttemptId = 'att_01JCBCDEF0123456789ABCDEFG'
    await expect(
      f.current.readRuntime(
        {
          executionId: childExecutionId,
          attemptId: childAttemptId,
          idempotencyKey: 'child-cancel-current-fences',
          executionPlan: f.childPlan,
        },
        'cancel'
      )
    ).rejects.toThrow('PI_CHILD_MODEL_AUTHORITY_DENIED')
  }
})

test('a deadline expiring during the final cancellation product read is refused', async () => {
  const f = fixture({ holdProductReadAt: 2 })
  const pending = f.current.readRuntime(
    {
      executionId: childExecutionId,
      attemptId: childAttemptId,
      idempotencyKey: 'child-cancel-await-deadline',
      executionPlan: f.childPlan,
    },
    'cancel'
  )
  await f.heldProductRead
  f.advancePastDeadline()
  f.releaseProductRead()
  await expect(pending).rejects.toThrow('PI_CHILD_MODEL_AUTHORITY_DENIED')
})

test('child budget admission rejects a parent deadline that expires during its final stable product read', async () => {
  const f = fixture({ holdProductReadAt: 4 })
  const authority = createProductionChildBudgetAdmissionAuthority({
    readCurrent: (request) => f.current.readAdmission(request),
    product: {
      async resolveChildSelection() {
        return selection
      },
    },
    now: () => f.state.now,
  })
  const preparation = authority.prepare(f.request)
  await f.heldProductRead
  f.advancePastDeadline()
  f.releaseProductRead()
  await expect(preparation).rejects.toThrow('PI_CHILD_MODEL_AUTHORITY_DENIED')
})

test('child current authority expires at the earliest parent or attempt deadline', async () => {
  const f = fixture({ attemptDeadline: '2026-10-09T12:00:30.000Z' })
  const current = await f.current.readAdmission(f.request)
  expect(current.expiresAt).toBe('2026-10-09T12:00:30.000Z')
})

test('runtime child authority rejects a parent deadline that expires during its final stable product read', async () => {
  const f = fixture({ holdProductReadAt: 8 })
  const runtimeRequest = {
    executionId: childExecutionId,
    attemptId: childAttemptId,
    idempotencyKey: 'child-runtime-deadline-test',
    executionPlan: f.childPlan,
  }
  const authority = createProductionChildModelAuthority({
    readCurrent: (request) => f.current.readRuntime(request),
    product: {
      async resolveChildSelection() {
        return selection
      },
    },
    async admit() {
      return {
        schemaVersion: 'pi-durable-admission/v1',
        prompt: 'A bounded child objective',
        canonicalActorPrincipalId: actor,
        selection: {
          selectionRef: selection.selectionRef,
          selectionRevision: selection.selectionRevision,
        },
        authority: {
          revision: 1,
          principalRef: actor,
          scopeRef: `scope:${intentId}`,
          expiresAt: '2026-10-09T13:00:00.000Z',
        },
      }
    },
    async assertCurrent() {},
    now: () => f.state.now,
  })
  const preparation = authority.resolveAdmission(runtimeRequest)
  await f.heldProductRead
  f.advancePastDeadline()
  f.releaseProductRead()
  await expect(preparation).rejects.toThrow('PI_CHILD_MODEL_AUTHORITY_DENIED')
})
