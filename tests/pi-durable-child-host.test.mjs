import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { ToolGatewayError as PackageToolGatewayError } from '@control-plane/tool-execution'
import { DurableUsageLedger, PinnedModelPrice } from '@control-plane/usage-ledger'
import {
  ChildProgressEvidenceBuffer,
  ChildProgressLeadDispatcher,
  ChildProgressLeadFeed,
} from '@control-plane/orchestration'
import { createNodePiDurableRuntime } from '../packages/pi-durable-adapter/src/composition.ts'
import { cleanupChildHost } from './fixtures/pi-durable-child-host-cleanup.mjs'
import { createGovernedChildCompositionFixture } from './pi-durable-governed-child-composition.fixture.mjs'
import { createPiDurableUsageAuthority } from '../packages/pi-durable-adapter/src/usage-authority.ts'
import { PiDurableChildProgressScanner } from '../apps/control-api/src/pi-durable/child-progress-scanner.ts'
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { DelegationService } from '@control-plane/orchestration'
import { SqlitePersistenceProvider } from '../packages/sqlite-persistence/src/provider.ts'
import {
  SqliteExecutionRepository,
  SqliteExecutionPlanRepository,
} from '../packages/sqlite-persistence/src/repositories.ts'
import { SqliteContextPackageRepository } from '../packages/sqlite-persistence/src/repositories-extra.ts'
import { SqliteDelegationRepository } from '../packages/sqlite-persistence/src/delegation-repository.ts'
import { SqliteDelegationEventPublisher } from '../packages/sqlite-persistence/src/delegation-event-publisher.ts'
import { SqliteToolCallRepository } from '../packages/sqlite-persistence/src/tool-repositories.ts'
import { SqliteDelegationToolAdmissionRepository } from '../packages/sqlite-persistence/src/delegation-tool-admission-repository.ts'
import {
  DelegationToolAdmissionSchema,
  InMemoryDelegationToolAdmissionRepository,
} from '../packages/orchestration/src/delegation-tool-admission.ts'
import { ToolExecutionRequestSchema } from '../packages/tool-sdk/src/index.ts'
import {
  CanonicalDelegationRuntimeBridge,
  DelegateChildToolInputSchema,
  DelegationRuntimeAdmissionRequestSchema,
  GovernedDelegateChildExecutor,
} from '../packages/orchestration/src/delegation-runtime.ts'
import { ids, parentPlanInput } from '../packages/orchestration/src/delegation-fixtures.mjs'
import {
  createGovernedChildHostFixture,
  parentAttemptId,
  identity,
} from './pi-durable-child-host.fixture.mjs'
import { currentSnapshot as canonicalCurrentSnapshot } from '../packages/orchestration/src/delegation-workspace-fixtures.mjs'
import { SqliteDurableUsageStore } from '../packages/sqlite-persistence/src/usage-store.ts'

/**
 * Every governed-child host run gets the canonical governed admission stack:
 * a durable SQLite store (the only profile that ships the transactional
 * ChildAdmissionAllocator), scope admission over the canonical snapshot, a
 * child-admission authority that issues the retained receipt over the exact
 * service-built request, and the durable parent budget the allocation
 * transaction reserves on. No assertion or guard is relaxed — the in-memory
 * repositories never provided the allocator CP1041 mandates.
 */
const storeCleanups = []
afterEach(async () => {
  for (const cleanup of storeCleanups.splice(0)) await cleanup()
})

function canonicalScopeAdmission() {
  return {
    authority: { readCurrent: async (input) => canonicalCurrentSnapshot(input) },
    now: () => '2026-08-25T18:02:00.000Z',
    resolveCallerPrincipalId: async () => 'user:original',
  }
}

function canonicalChildAdmission() {
  return {
    async prepare(request) {
      return {
        schemaVersion: 'pi-child-admission/v1',
        ...request,
        authorityRevision: 1,
        productRevision: 'product:rev-1',
        productReaderPrincipalId: 'svc_product-reader',
        selectionRef: 'selection:child-role',
        selectionRevision: 1,
        expiresAt: '2999-01-01T00:00:00.000Z',
      }
    },
    async assertCurrent() {},
  }
}

async function canonicalStorage(provider) {
  return {
    executions: new SqliteExecutionRepository(provider),
    plans: new SqliteExecutionPlanRepository(provider),
    contexts: new SqliteContextPackageRepository(provider),
    delegations: new SqliteDelegationRepository(provider),
    events: new SqliteDelegationEventPublisher(provider, ids.parentExecutionId),
    calls: new SqliteToolCallRepository(provider, ids.workspaceId),
    admissions: new SqliteDelegationToolAdmissionRepository(provider, ids.workspaceId),
    usageStore: new SqliteDurableUsageStore(provider),
    scopeAdmission: canonicalScopeAdmission(),
    childAdmission: canonicalChildAdmission(),
  }
}

async function fixture(options = {}) {
  if (options.storage) {
    // Injected storage (existing SQLite tests): attach the canonical ports it
    // still needs before handing it to the composition.
    const storage = options.storage
    storage.childAllocator ??= storage.delegations
    storage.scopeAdmission ??= canonicalScopeAdmission()
    storage.childAdmission ??= canonicalChildAdmission()
    return createGovernedChildHostFixture({ ...options, storage })
  }
  const directory = await mkdtemp(join(tmpdir(), 'pi-child-host-store-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'canonical.sqlite') })
  await provider.migrate()
  const storage = await canonicalStorage(provider)
  storage.childAllocator = storage.delegations
  storeCleanups.push(async () => {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  })
  return createGovernedChildHostFixture({ ...options, storage })
}

for (const settings of [{ decision: 'deny' }, { approval: 'pending' }, { approval: 'denied' }]) {
  test(`governed child tool ${JSON.stringify(settings)} admits no child and sends no runtime effect`, async () => {
    const f = await fixture(settings)
    const result = await f.service.execute(f.request)
    expect(['denied', 'awaiting_approval']).toContain(result.state)
    expect(await f.delegations.listByParent(ids.parentExecutionId)).toEqual([])
    expect(f.starts).toHaveLength(0)
  })
}

test('governed child start binds canonical plan/attempt, deduplicates tool replay and recovers exact runtime session', async () => {
  const f = await fixture()
  const first = await f.service.execute(f.request)
  expect(first.state).toBe('succeeded')
  expect(first.result.output).toMatchObject({
    delegationId: ids.delegationId,
    childAttemptId: ids.childAttemptId,
  })
  expect(f.starts).toHaveLength(1)
  expect(f.starts[0].executionPlan).toEqual((await f.bridge.resolve(identity)).plan)
  expect(f.starts[0].attemptBudget.reservationKey).toBe(`runtime-attempt:${ids.childAttemptId}`)
  expect((await f.service.execute(f.request)).result).toEqual(first.result)
  expect(f.starts).toHaveLength(1)
  const reopenedBridge = new CanonicalDelegationRuntimeBridge(f.bridgeOptions)
  await reopenedBridge.startChild(identity)
  expect(f.sessions.size).toBe(1)
  expect(f.starts).toHaveLength(2)
  await f.bridge.recordProgress(identity, {
    delegationId: ids.delegationId,
    childAttemptId: ids.childAttemptId,
    state: 'running',
    observedAt: '2026-08-25T18:02:02.000Z',
  })
  await f.bridge.recordProgress(identity, {
    delegationId: ids.delegationId,
    childAttemptId: ids.childAttemptId,
    state: 'completed',
    observedAt: '2026-08-25T18:03:00.000Z',
    terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG',
  })
  expect((await f.delegations.get(ids.delegationId)).terminalPublication.status).toBe('published')
})

test('strict model and admission schemas reject authority, secrets and missing attempt identity', () => {
  expect(
    DelegateChildToolInputSchema.safeParse({
      objective: 'Bounded work',
      provider: 'guessed',
      apiKey: 'secret',
    }).success
  ).toBe(false)
  expect(
    DelegationRuntimeAdmissionRequestSchema.safeParse({ ...identity, childAttemptId: undefined })
      .success
  ).toBe(false)
  expect(
    DelegationRuntimeAdmissionRequestSchema.safeParse({ ...identity, credentialRef: 'secret' })
      .success
  ).toBe(false)
})

test('retained compiler admission accepts only the opaque native source key and bounded tool/context fields', async () => {
  const f = await fixture()
  expect(DelegationToolAdmissionSchema.safeParse(f.admission).success).toBe(true)
  for (const altered of [
    { ...f.admission, sourceKey: 'unverified-model-call-id' },
    { ...f.admission, epoch: 'current-process' },
    {
      ...f.admission,
      request: {
        ...f.request,
        input: { objective: f.command.delegation.objective, apiKey: 'synthetic-secret-canary' },
      },
    },
    {
      ...f.admission,
      command: {
        ...f.command,
        delegation: {
          ...f.command.delegation,
          childPlan: { ...f.command.delegation.childPlan, credential: 'synthetic-secret-canary' },
        },
      },
    },
  ])
    expect(DelegationToolAdmissionSchema.safeParse(altered).success).toBe(false)
  expect(f.starts).toHaveLength(0)
})

test('canonical child resolver rejects changed parent or child attempt and runtime before new start', async () => {
  const f = await fixture()
  await f.service.execute(f.request)
  for (const altered of [
    { parentAttemptId: 'att_01JCBCDEF0123456789ABCDEFG' },
    { childAttemptId: parentAttemptId },
    { parentExecutionId: ids.childExecutionId },
  ])
    await expect(f.bridge.startChild({ ...identity, ...altered })).rejects.toThrow(
      'DELEGATION_RUNTIME_ADMISSION_DENIED'
    )
  const foreign = new CanonicalDelegationRuntimeBridge({
    ...f.bridgeOptions,
    runtimeConnectionId: 'rtc_01JCBCDEF0123456789ABCDEFG',
  })
  await expect(foreign.startChild(identity)).rejects.toThrow('DELEGATION_RUNTIME_ADMISSION_DENIED')
  expect(f.starts).toHaveLength(1)
})

test('authority or parent cancellation during budget resolution stops inference', async () => {
  const f = await fixture()
  await f.service.execute(f.request)
  const cancelled = new CanonicalDelegationRuntimeBridge({
    ...f.bridgeOptions,
    async reserveBudget(admission) {
      const parent = await f.lifecycle.getExecution(ids.parentExecutionId)
      await f.lifecycle.transitionExecution({
        executionId: parent.executionId,
        expectedVersion: parent.version,
        to: 'cancelled',
        transitionedAt: '2026-08-25T18:02:01.000Z',
      })
      return f.bridgeOptions.reserveBudget(admission)
    },
  })
  await expect(cancelled.startChild(identity)).rejects.toThrow(
    'DELEGATION_RUNTIME_ADMISSION_DENIED'
  )
  expect(f.starts).toHaveLength(1)
})

for (const boundary of ['budget', 'final_authority']) {
  test(`child runtime observes abort after awaited ${boundary} before sending inference`, async () => {
    const f = await fixture()
    await f.service.execute(f.request)
    const controller = new AbortController()
    let authorityChecks = 0
    const bridge = new CanonicalDelegationRuntimeBridge({
      ...f.bridgeOptions,
      async assertAuthority(admission) {
        await f.bridgeOptions.assertAuthority(admission)
        authorityChecks += 1
        if (boundary === 'final_authority' && authorityChecks === 2) controller.abort()
      },
      async reserveBudget(admission) {
        const reservation = await f.bridgeOptions.reserveBudget(admission)
        if (boundary === 'budget') controller.abort()
        return reservation
      },
    })
    await expect(bridge.startChild(identity, controller.signal)).rejects.toThrow(
      'DELEGATION_RUNTIME_ADMISSION_DENIED'
    )
    expect(f.starts).toHaveLength(1)
  })
}

test('governed child executor observes abort after canonical dispatch before runtime start', async () => {
  const f = await fixture()
  const controller = new AbortController()
  const executor = new GovernedDelegateChildExecutor({
    ...f.executor.options,
    bridge: new CanonicalDelegationRuntimeBridge({
      ...f.bridgeOptions,
      // Isolate signal propagation from the separate retained tool-call authority checks.
      async assertAuthority() {},
    }),
    // Isolate the transient abort boundary from the gateway's executing-call lookup.
    async resolveCommand() {
      return structuredClone(f.command)
    },
    delegations: {
      delegate: (input) => f.executor.options.delegations.delegate(input),
      async dispatchChild(input) {
        const record = await f.executor.options.delegations.dispatchChild(input)
        controller.abort()
        return record
      },
    },
  })
  // Exercise the host boundary directly with the exact gateway request and signal.
  await expect(
    executor.execute(
      ToolExecutionRequestSchema.strip().parse(f.request),
      f.version,
      controller.signal
    )
  ).rejects.toThrow('DELEGATION_RUNTIME_ADMISSION_DENIED')
  expect(f.starts).toHaveLength(0)
  expect((await f.delegations.get(ids.delegationId)).childAttemptId).toBe(ids.childAttemptId)
})

test('child admission rejects altered model objective before persisting a child', async () => {
  const f = await fixture()
  const outcome = await f.service.execute({
    ...f.request,
    input: { objective: 'different objective' },
  })
  expect(outcome.state).toBe('reconciliation_required')
  expect(await f.delegations.listByParent(ids.parentExecutionId)).toEqual([])
})

test('child funding/authority rejection sends nothing and a changed reservation scope cannot start', async () => {
  const denied = await fixture({
    async onAuthority() {
      throw new Error('current funding denied')
    },
  })
  expect((await denied.service.execute(denied.request)).state).toBe('reconciliation_required')
  expect(denied.starts).toHaveLength(0)
  expect(denied.sessions.size).toBe(0)
  const admitted = await fixture()
  await admitted.service.execute(admitted.request)
  const changedBudget = new CanonicalDelegationRuntimeBridge({
    ...admitted.bridgeOptions,
    async reserveBudget(admission) {
      return {
        ...(await admitted.bridgeOptions.reserveBudget(admission)),
        workspaceId: 'wsp_01JCBCDEF0123456789ABCDEFG',
      }
    },
  })
  await expect(changedBudget.startChild(identity)).rejects.toThrow(
    'Runtime attempt authority must match'
  )
  expect(admitted.starts).toHaveLength(1)
})

function persistentStorage(provider) {
  return {
    executions: new SqliteExecutionRepository(provider),
    plans: new SqliteExecutionPlanRepository(provider),
    contexts: new SqliteContextPackageRepository(provider),
    delegations: new SqliteDelegationRepository(provider),
    events: new SqliteDelegationEventPublisher(provider, ids.parentExecutionId),
    calls: new SqliteToolCallRepository(provider, ids.workspaceId),
    admissions: new SqliteDelegationToolAdmissionRepository(provider, ids.workspaceId),
    usageStore: new SqliteDurableUsageStore(provider),
  }
}

test('child host reopens canonical SQLite identity, rejects a second bounded child and retains terminal evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-child-host-'))
  const path = join(directory, 'canonical.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    const initial = persistentStorage(provider)
    const f = await fixture({ storage: initial })
    expect((await f.service.execute(f.request)).state).toBe('succeeded')
    const record = await initial.delegations.get(ids.delegationId)
    const secondChildId = 'exe_01JCBCDEF0123456789ABCDEFG'
    const originalChild = await f.lifecycle.getExecution(ids.childExecutionId)
    await f.lifecycle.createExecution({
      executionId: secondChildId,
      parentExecutionId: ids.parentExecutionId,
      correlation: originalChild.correlation,
      executionPlan: originalChild.executionPlan,
      acceptedAt: '2026-08-25T18:01:00.000Z',
      deadlineAt: '2026-08-25T18:10:00.000Z',
    })
    // The writer transaction enforces the cap even if a service precheck saw stale siblings.
    expect(
      await initial.delegations.insert({
        ...record,
        delegationId: 'dlg_01JCBCDEF0123456789ABCDEFG',
        childExecutionId: secondChildId,
        revision: 1,
        state: 'requested',
        childAttemptId: undefined,
        runtimeConnectionId: undefined,
      })
    ).toBe(false)
    await provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    const reopened = persistentStorage(provider)
    expect(await reopened.admissions.getByRequestId(f.request.requestId)).toEqual(f.admission)
    expect((await reopened.admissions.retain(f.admission)).replayed).toBe(true)
    for (const changed of [
      { ...f.admission, sourceKey: `pi-tool:${'b'.repeat(64)}` },
      {
        ...f.admission,
        request: {
          ...f.request,
          grant: { ...f.request.grant, expiresAt: '2026-08-25T18:09:00.000Z' },
        },
      },
      {
        ...f.admission,
        request: {
          ...f.request,
          approval: { ...f.request.approval, allowedPrincipalIds: ['user:different'] },
        },
      },
      {
        ...f.admission,
        request: {
          ...f.request,
          audit: { ...f.request.audit, principalRef: 'service:http-transport' },
        },
      },
      { ...f.admission, request: { ...f.request, requestId: 'req_01JCBCDEF0123456789ABCDEFG' } },
    ])
      await expect(reopened.admissions.retain(changed)).rejects.toThrow(
        'DELEGATION_TOOL_ADMISSION_CONFLICT'
      )
    const lifecycle = new ExecutionLifecycleService(reopened.executions)
    const delegations = new DelegationService({ ...reopened, lifecycle })
    const bridge = new CanonicalDelegationRuntimeBridge({
      ...f.bridgeOptions,
      records: reopened.delegations,
      lifecycle,
      plans: reopened.plans,
      delegations,
      async assertAuthority(admission) {
        const call = await reopened.calls.get(admission.record.admittedToolCallId)
        expect(call).toMatchObject({
          executionId: admission.identity.parentExecutionId,
          attemptId: admission.identity.parentAttemptId,
          status: 'succeeded',
        })
      },
    })
    await bridge.startChild(identity)
    expect(f.sessions.size).toBe(1)
    expect(await reopened.executions.listAttempts(ids.childExecutionId)).toHaveLength(1)
    await bridge.recordProgress(identity, {
      delegationId: ids.delegationId,
      childAttemptId: ids.childAttemptId,
      state: 'running',
      observedAt: '2026-08-25T18:02:02.000Z',
    })
    await bridge.recordProgress(identity, {
      delegationId: ids.delegationId,
      childAttemptId: ids.childAttemptId,
      state: 'completed',
      observedAt: '2026-08-25T18:03:00.000Z',
      terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG',
    })
    await reopened.executions.deleteEligibleExecutions(new Date('2027-01-01T00:00:00.000Z'), {
      policyRetainMs: 1,
      dryRun: false,
    })
    await reopened.plans.deleteEligibleExecutionPlans(new Date('2027-01-01T00:00:00.000Z'), {
      policyRetainMs: 1,
      dryRun: false,
    })
    expect(await reopened.executions.getExecution(ids.childExecutionId)).toBeDefined()
    expect(await reopened.plans.get(originalChild.executionPlan)).toBeDefined()
    expect(
      (await reopened.events.list()).filter((event) => event.type === 'delegation.completed')
    ).toHaveLength(1)
    await expect(
      bridge.recordProgress(identity, {
        delegationId: ids.delegationId,
        childAttemptId: parentAttemptId,
        state: 'completed',
        observedAt: '2026-08-25T18:03:00.000Z',
        terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG',
      })
    ).rejects.toThrow('DELEGATION_RUNTIME_ADMISSION_DENIED')
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('pending compiler receipt pins canonical parent execution and plan before any child effect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-child-admission-retention-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'canonical.sqlite') })
  try {
    await provider.migrate()
    const storage = persistentStorage(provider)
    const f = await fixture({
      storage: {
        ...storage,
        admissions: new InMemoryDelegationToolAdmissionRepository(ids.workspaceId),
      },
    })
    const receipts = await Promise.all([
      storage.admissions.retain(f.admission),
      storage.admissions.retain(f.admission),
    ])
    expect(receipts.map((receipt) => receipt.replayed).toSorted()).toEqual([false, true])
    await expect(
      storage.admissions.retain({
        ...f.admission,
        request: { ...f.request, requestId: 'req_01JCBCDEF0123456789ABCDEFG' },
      })
    ).rejects.toThrow('DELEGATION_TOOL_ADMISSION_CONFLICT')
    const attempt = await f.executions.getAttempt(parentAttemptId)
    await f.lifecycle.transitionAttempt({
      attemptId: parentAttemptId,
      expectedVersion: attempt.version,
      to: 'completed',
      transitionedAt: '2026-08-25T18:03:00.000Z',
    })
    const parent = await f.lifecycle.getExecution(ids.parentExecutionId)
    await f.lifecycle.transitionExecution({
      executionId: parent.executionId,
      expectedVersion: parent.version,
      to: 'completed',
      transitionedAt: '2026-08-25T18:03:00.000Z',
    })
    const result = await storage.executions.deleteEligibleExecutions(
      new Date('2027-08-25T18:03:00.000Z'),
      { policyRetainMs: 1, dryRun: false }
    )
    expect(result.deleted).toBe(0)
    expect(result.retainedByReason).toEqual({ reference_pending: 1 })
    expect(await storage.executions.getAttempt(parentAttemptId)).toBeDefined()
    expect(
      await storage.plans.get({
        executionPlanId: f.parentPlan.executionPlanId,
        contentDigest: f.parentPlan.contentDigest,
      })
    ).toBeDefined()
    expect(await storage.admissions.getByRequestId(f.request.requestId)).toEqual(f.admission)
    expect(await storage.delegations.listByParent(ids.parentExecutionId)).toEqual([])
    expect(f.starts).toHaveLength(0)
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('reusable host compiler drives governed workspace lead to a real project child with original actor', async () => {
  const { workspaceInput, actor, now } =
    await import('../packages/orchestration/src/delegation-workspace-fixtures.mjs')
  const workspace = workspaceInput()
  workspace.scopeAdmission = {
    now: () => now,
    resolveCallerPrincipalId: async () => actor,
    authority: { readCurrent: async (input) => canonicalCurrentSnapshot(input) },
  }
  const f = await fixture({ workspace, principalRef: actor })
  expect((await f.service.execute(f.request)).state).toBe('succeeded')
  expect(f.parentPlan.correlation.projectId).toBeUndefined()
  expect(f.starts[0].executionPlan.schemaVersion).toBe(2)
  expect(f.starts[0].executionPlan.correlation.projectId).toBe(ids.projectId)
  expect((await f.resolver.getAdmission(f.request.requestId)).request.audit.principalRef).toBe(
    actor
  )
  expect(f.starts).toHaveLength(1)
})

async function mutateCanonicalStartFence(f, mutation) {
  const executionId =
    mutation === 'child_latest_attempt' ? ids.childExecutionId : ids.parentExecutionId
  const execution = await f.lifecycle.getExecution(executionId)
  if (mutation === 'parent_cancelled') {
    await f.lifecycle.transitionExecution({
      executionId,
      expectedVersion: execution.version,
      to: 'cancelled',
      transitionedAt: '2026-08-25T18:02:01.000Z',
    })
  } else {
    // Another canonical writer wins the latest-attempt fence during the host
    // await by creating the real next attempt — the only writer path allowed
    // to move latestAttemptId (compareAndSetExecution refuses a changed
    // latestAttemptId by contract, and the durable store enforces it).
    await f.lifecycle.createAttempt({
      executionId,
      attemptId: 'att_01JCBCDEF0123456789ABCDEFG',
      expectedExecutionVersion: execution.version,
      queuedAt: '2026-08-25T18:02:05.000Z',
    })
  }
}

for (const mutation of ['parent_cancelled', 'parent_latest_attempt', 'child_latest_attempt']) {
  test(`final authority await fences ${mutation} on first dispatch without an abort signal`, async () => {
    let checks = 0
    const f = await fixture({
      async onAuthority(_admission, host) {
        if (++checks === 2) await mutateCanonicalStartFence(host, mutation)
      },
    })
    const outcome = await f.service.execute(f.request)
    expect(outcome.state).not.toBe('succeeded')
    expect(checks).toBe(2)
    expect(f.starts).toHaveLength(0)
  })
  test(`final authority await fences ${mutation} on recovery without an abort signal`, async () => {
    const f = await fixture()
    expect((await f.service.execute(f.request)).state).toBe('succeeded')
    let checks = 0
    const bridge = new CanonicalDelegationRuntimeBridge({
      ...f.bridgeOptions,
      async assertAuthority(admission) {
        await f.bridgeOptions.assertAuthority(admission)
        if (++checks === 2) await mutateCanonicalStartFence(f, mutation)
      },
    })
    await expect(bridge.startChild(identity)).rejects.toThrow('DELEGATION_RUNTIME_ADMISSION_DENIED')
    expect(checks).toBe(2)
    expect(f.starts).toHaveLength(1)
  })
}

test('SQLite delegation admission rejects a composed child context that expands workspace ancestry', async () => {
  const { workspaceInput, actor, now } =
    await import('../packages/orchestration/src/delegation-workspace-fixtures.mjs')
  const { composeProviderContextPackage } = await import('@control-plane/context')
  const { deriveExecutionPlanWithAuthority, assertExecutionPlanDerivedFrom } =
    await import('@control-plane/execution-plan')
  const workspace = workspaceInput()
  const expanded = composeProviderContextPackage(workspace.childContext, {
    callerContextRefs: ['context://extra'],
    localProjectGrantRefs: [],
    contributions: [],
  })
  workspace.command.childPlan.contextPackage = expanded
  workspace.scopeAdmission = {
    now: () => now,
    resolveCallerPrincipalId: async () => actor,
    authority: { readCurrent: async (input) => canonicalCurrentSnapshot(input) },
  }
  const plan = await deriveExecutionPlanWithAuthority(
    workspace.parentPlan,
    workspace.command.childPlan,
    { callerPrincipalId: actor, authority: workspace.scopeAdmission.authority, now }
  )
  expect(() =>
    assertExecutionPlanDerivedFrom(workspace.parentPlan, plan, workspace.parentContext, expanded)
  ).toThrow('CHILD_SCOPE_EXPANSION')
  const directory = await mkdtemp(join(tmpdir(), 'pi-child-expanded-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'canonical.sqlite') })
  try {
    await provider.migrate()
    const storage = persistentStorage(provider)
    await storage.contexts.put(workspace.parentContext)
    await storage.contexts.put(expanded)
    const f = await fixture({ workspace, principalRef: actor, storage })
    await expect(
      f.bridgeOptions.delegations.delegate({
        ...f.command.delegation,
        initialDispatch: f.command.dispatch,
      })
    ).rejects.toThrow('CHILD_SCOPE_EXPANSION')
    expect(await storage.delegations.listByParent(ids.parentExecutionId)).toEqual([])
    expect(f.starts).toHaveLength(0)
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

const at = '2026-08-25T18:02:00.000Z'
const siblingId = (prefix, letter) => `${prefix}_01J${letter}BCDEF0123456789ABCDEFG`

function siblingAdmission(first, letter) {
  const admission = structuredClone(first)
  admission.sourceKey = `pi-tool:${letter.toLowerCase().repeat(64)}`
  Object.assign(admission.request, {
    requestId: siblingId('req', letter),
    toolCallId: siblingId('tlc', letter),
    idempotencyKey: `sibling:${letter}`,
  })
  admission.request.approval.interactionId = siblingId('int', letter)
  Object.assign(admission.command.delegation, {
    delegationId: siblingId('dlg', letter),
    childExecutionId: siblingId('exe', letter),
    childAttemptId: siblingId('att', letter),
    admittedToolCallId: admission.request.toolCallId,
  })
  Object.assign(admission.command.delegation.childPlan.correlation, {
    taskId: siblingId('tsk', letter),
    requestId: siblingId('req', letter),
  })
  Object.assign(admission.command.dispatch, {
    delegationId: admission.command.delegation.delegationId,
    childAttemptId: admission.command.delegation.childAttemptId,
  })
  return admission
}

// Actual Pi engines and SQLite journals; only the provider and external product/
// spending authority are loopback fixtures. Usage is read from provider receipts
// and priced/retained by the production usage authority, never invented on cancel.
test('separately governed siblings run Pi concurrently, retain responsive input and survive terminal restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-sibling-dispatch-'))
  let provider
  let server
  let runtime
  let reopenedCanonical
  let primaryFailure
  const ownedWork = []
  const trackAll = (promises) => {
    for (const promise of promises) {
      ownedWork.push(promise)
      void Promise.resolve(promise).catch(() => {})
    }
    return Promise.all(promises)
  }
  const arrived = [Promise.withResolvers(), Promise.withResolvers()]
  const release = [Promise.withResolvers(), Promise.withResolvers()]
  const requests = []
  try {
    provider = new SqlitePersistenceProvider({ path: join(directory, 'canonical.sqlite') })
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const index = requests.length
        requests.push(await request.json())
        arrived[index]?.resolve()
        await release[index]?.promise
        const chunks = [
          {
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: `Sibling ${index} result` },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          },
        ].map((chunk) => ({
          id: `chat_${index}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'sibling-loopback',
          ...chunk,
        }))
        return new Response(
          chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } }
        )
      },
    })
    let failTerminalPublication = false
    await provider.migrate()
    const publications = new SqliteDelegationEventPublisher(provider, ids.parentExecutionId)
    const makeFeed = (inbox = publications) =>
      new ChildProgressLeadFeed({
        publications: inbox,
        dispatcher: new ChildProgressLeadDispatcher({
          buffer: new ChildProgressEvidenceBuffer({ parentExecutionId: ids.parentExecutionId }),
        }),
        generationOf: () => 1,
      })
    const feed = makeFeed()
    const records = new SqliteDelegationRepository(provider)
    const ledger = new DurableUsageLedger({
      store: new SqliteDurableUsageStore(provider),
      now: () => at,
    })
    const storage = {
      executions: new SqliteExecutionRepository(provider),
      plans: new SqliteExecutionPlanRepository(provider),
      contexts: new SqliteContextPackageRepository(provider),
      delegations: records,
      events: {
        async publish(event, key) {
          if (failTerminalPublication && event.type === 'delegation.completed') {
            failTerminalPublication = false
            throw new Error('crash after terminal CAS before publication')
          }
          return feed.publish(event, key)
        },
      },
      childReceipts: records,
      terminalPublisher: feed,
      calls: new SqliteToolCallRepository(provider, ids.workspaceId),
      admissions: new SqliteDelegationToolAdmissionRepository(provider, ids.workspaceId),
      usageStore: new SqliteDurableUsageStore(provider),
      childAllocator: records,
      scopeAdmission: {
        authority: { readCurrent: async (input) => canonicalCurrentSnapshot(input) },
        now: () => at,
        resolveCallerPrincipalId: async () => 'user:original',
      },
      childAdmission: {
        prepare: async (request) => ({
          schemaVersion: 'pi-child-admission/v1',
          ...request,
          authorityRevision: 1,
          productRevision: 'product:1',
          productReaderPrincipalId: 'svc_product-reader',
          selectionRef: 'selection:sibling',
          selectionRevision: 1,
          expiresAt: '2999-01-01T00:00:00.000Z',
        }),
        assertCurrent: async () => {},
      },
    }
    const planInput = parentPlanInput()
    planInput.constraints.limits.childExecutions.maximumTotal = 2
    planInput.profile.definition.capabilityRequirements = []
    planInput.skills[0].manifest.requiredCapabilities = []
    const parentPlan = new ExecutionPlanCompiler('1.0.0').compile(planInput)
    const host = await createGovernedChildHostFixture({
      storage,
      workspace: { parentPlan },
      runtimeAdapter: { start: (request) => runtime.adapter.start(request) },
      reserveChildBudget: async (admission) => {
        const budget = {
          schemaVersion: 1,
          workspaceId: ids.workspaceId,
          executionId: admission.record.childExecutionId,
          attemptId: admission.attempt.attemptId,
          executionPlanId: admission.plan.executionPlanId,
          executionPlanDigest: admission.plan.contentDigest,
          reservationKey: `runtime-attempt:${admission.attempt.attemptId}`,
          currency: 'USD',
          maximumMicrounits: 500000,
          maximumTokens: 5000,
        }
        const {
          schemaVersion: _schemaVersion,
          executionPlanId: _planId,
          executionPlanDigest: _planDigest,
          currency: _currency,
          ...reservation
        } = budget
        await ledger.reserve({
          ...reservation,
          source: { sourceId: budget.reservationKey, idempotencyKey: budget.reservationKey },
        })
        return budget
      },
    })
    const price = new PinnedModelPrice(
      {
        schemaVersion: 1,
        deploymentId: 'sibling-fixture',
        provider: 'sibling-loopback',
        model: 'sibling-loopback',
        version: 'price:1',
        currency: 'USD',
        fundingSource: 'byo_api',
        validFrom: at,
        validUntil: '2027-01-01T00:00:00.000Z',
        maximumInputTokens: 1024,
        maximumOutputTokens: 32,
        ratesMicrounitsPerMillionTokens: { input: 1000000, cachedInput: 500000, output: 2000000 },
      },
      { now: () => at }
    )
    const usage = createPiDurableUsageAuthority({
      ledger,
      resolvePrice: async () => ({ price, maximumOutputTokens: 32 }),
      assertSpendingAuthorized: async () => ({
        authorizationRef: 'spend:sibling-fixture',
        evidenceDigest: `sha256:${'e'.repeat(64)}`,
        assertActive: async () => {},
      }),
    })
    const baseUrl = `${server.url}v1`
    const options = {
      directory: join(directory, 'runtime'),
      now: () => at,
      resolveAdmission: async (request) => ({
        schemaVersion: 'pi-durable-admission/v1',
        prompt: request.executionId,
        selection: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 },
        authority: {
          revision: 1,
          principalRef: 'user:original',
          scopeRef: 'scope:sibling',
          expiresAt: '2027-01-01T00:00:00.000Z',
        },
      }),
      assertAuthority: async () => {},
      reconcileInference: async () => 'unresolved',
      authorizeInference: usage.authorizeInference,
      settleUsage: usage.settleUsage,
      resolveProvider: async (selection) => ({
        ...selection,
        workspaceId: ids.workspaceId,
        provider: 'sibling-loopback',
        providerModel: 'sibling-loopback',
        location: 'remote_host',
        harness: 'pi_durable',
        harnessVersion: '1.1.0',
        providerBinding: 'pi_durable_models',
        withModels: async (use) => {
          const models = createModels()
          models.setProvider(
            createProvider({
              id: 'sibling-loopback',
              baseUrl,
              auth: {
                apiKey: {
                  name: 'Loopback fixture',
                  resolve: async () => ({ auth: { apiKey: 'fixture-no-paid-account' } }),
                },
              },
              models: [
                {
                  id: 'sibling-loopback',
                  provider: 'sibling-loopback',
                  name: 'Loopback',
                  api: 'openai-completions',
                  baseUrl,
                  reasoning: false,
                  input: ['text'],
                  contextWindow: 1024,
                  maxTokens: 32,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
              api: openAICompletionsApi(),
            })
          )
          return use(models)
        },
      }),
    }
    runtime = await createNodePiDurableRuntime(options)
    const second = siblingAdmission(host.admission, 'C')
    await host.admissions.retain(second)
    const outcomes = await trackAll([
      host.service.execute(host.request),
      host.service.execute(second.request),
    ])
    expect(outcomes.map((outcome) => outcome.state)).toEqual(['succeeded', 'succeeded'])
    expect(await host.service.execute(host.request)).toEqual(outcomes[0])
    expect(await host.service.execute(second.request)).toEqual(outcomes[1])
    expect(host.starts).toHaveLength(2)
    await Promise.all(arrived.map((item) => item.promise))
    const handles = host.starts.map(
      (request) =>
        runtime.adapter.journal.list().find((row) => row.attemptId === request.attemptId).admission
          .handle
    )
    expect(new Set(handles.map((handle) => handle.externalSessionId)).size).toBe(2)
    const returnedMappings = await trackAll(
      outcomes.map(async (outcome) => {
        const output = outcome.result.output
        const mapping = await records.getChildMapping(output.childAttemptId)
        expect(mapping).toEqual({
          workspaceId: ids.workspaceId,
          parentExecutionId: ids.parentExecutionId,
          delegationId: output.delegationId,
          childExecutionId: output.childExecutionId,
          childAttemptId: output.childAttemptId,
          runtimeConnectionId: host.bridgeOptions.runtimeConnectionId,
          externalSessionId: output.externalSessionId,
        })
        expect(
          handles.find((handle) => handle.attemptId === output.childAttemptId).externalSessionId
        ).toBe(mapping.externalSessionId)
        expect(
          await records.findChildBySession(mapping.runtimeConnectionId, mapping.externalSessionId)
        ).toEqual(mapping)
        return mapping
      })
    )
    expect(
      await trackAll(handles.map(async (handle) => (await runtime.adapter.status(handle)).state))
    ).toEqual(['running', 'running'])
    const scanner = new PiDurableChildProgressScanner({
      now: () => at,
      bridge: host.bridge,
      listRetainedChildren: async () =>
        trackAll(
          (await records.listByParent(ids.parentExecutionId)).map(async (record) => ({
            identity: {
              schemaVersion: 'delegation-runtime-admission/v1',
              parentExecutionId: record.parentExecutionId,
              parentAttemptId: record.parentAttemptId,
              delegationId: record.delegationId,
              childAttemptId: record.childAttemptId,
            },
            handle: handles.find((handle) => handle.attemptId === record.childAttemptId),
            canonicalState: (await storage.executions.getAttempt(record.childAttemptId)).state,
          }))
        ),
      assertCurrent: async (record) =>
        expect((await records.get(record.identity.delegationId)).childAttemptId).toBe(
          record.handle.attemptId
        ),
      retainTerminalResult: async (record, result) => {
        await provider.transaction(async (tx) =>
          tx.put({ namespace: 'sibling-results', id: record.handle.attemptId, value: result })
        )
        return siblingId('art', record.handle.attemptId.includes('01JC') ? 'C' : 'B')
      },
    })
    expect((await scanner.scan(runtime.adapter)).blocked).toEqual([])
    expect(feed.takeDeliveries()).toEqual([])
    feed.acceptHumanInput({ interactionId: siblingId('int', 'D'), kind: 'input', receivedAt: at })
    expect(feed.takeDeliveries()[0].kind).toBe('human_input')
    const third = siblingAdmission(host.admission, 'D')
    await host.admissions.retain(third)
    expect((await host.service.execute(third.request)).state).not.toBe('succeeded')
    expect(host.starts).toHaveLength(2)
    // Verify the exact retained runtime/CP target before ordinary cancellation.
    // No test-only coordinator supplies permission or an enduring grant.
    const storedCancellation = runtime.adapter.journal.get(handles[0].handleId).admission
    const cancelledExecution = await storage.executions.getExecution(
      storedCancellation.request.executionId
    )
    const cancelledAttempt = await storage.executions.getAttempt(handles[0].attemptId)
    expect(cancelledExecution.latestAttemptId).toBe(handles[0].attemptId)
    expect(cancelledAttempt.executionId).toBe(cancelledExecution.executionId)
    expect(typeof cancelledExecution.deadlineAt).toBe('string')
    expect(cancelledAttempt.deadlineAt).toBe(cancelledExecution.deadlineAt)
    expect(
      (
        await runtime.adapter.cancel(handles[0], {
          idempotencyKey: 'cancel:first',
          requestedAt: at,
        })
      ).state
    ).toBe('cancelling')
    const retainedCancellation = runtime.adapter.journal.get(handles[0].handleId).detail
      .cancellationIntent
    // A current ordinary cancellation retains exact target evidence, never an irrevocable grant.
    expect(retainedCancellation.authorityIntentId).toBeUndefined()
    expect(retainedCancellation.attemptId).toBe(handles[0].attemptId)
    expect(retainedCancellation.requestDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    release.forEach((item) => item.resolve())
    await runtime.adapter.drain()
    expect((await runtime.adapter.status(handles[1])).state).toBe('completed')
    failTerminalPublication = true
    expect((await scanner.scan(runtime.adapter)).blocked).toEqual([
      {
        delegationId: second.command.delegation.delegationId,
        childAttemptId: second.command.dispatch.childAttemptId,
        code: 'PI_CHILD_PROGRESS_BLOCKED',
      },
    ])
    const pending = await records.getTerminalReceipt(second.command.delegation.delegationId)
    expect(pending.status).toBe('pending')
    expect((await records.get(second.command.delegation.delegationId)).state).toBe('completed')
    expect(
      (await publications.list()).filter((event) => event.type === 'delegation.completed')
    ).toEqual([])
    reopenedCanonical = new SqlitePersistenceProvider({ path: join(directory, 'canonical.sqlite') })
    await reopenedCanonical.migrate()
    const recoveryRecords = new SqliteDelegationRepository(reopenedCanonical)
    const recoveryInbox = new SqliteDelegationEventPublisher(
      reopenedCanonical,
      ids.parentExecutionId
    )
    for (const mapping of returnedMappings)
      expect(
        await recoveryRecords.findChildBySession(
          mapping.runtimeConnectionId,
          mapping.externalSessionId
        )
      ).toEqual(mapping)
    const recoveryBridge = new CanonicalDelegationRuntimeBridge({
      ...host.bridgeOptions,
      records: recoveryRecords,
      childReceipts: recoveryRecords,
      terminalPublisher: makeFeed(recoveryInbox),
      runtime: {
        async start() {
          throw new Error('recovery must not start a child')
        },
      },
      async assertAuthority() {
        throw new Error('recovery must not request dispatch authority')
      },
      async reserveBudget() {
        throw new Error('recovery must not reserve another budget')
      },
    })
    const completedIdentity = {
      schemaVersion: 'delegation-runtime-admission/v1',
      parentExecutionId: ids.parentExecutionId,
      parentAttemptId,
      delegationId: second.command.delegation.delegationId,
      childAttemptId: second.command.dispatch.childAttemptId,
    }
    await expect(
      recoveryBridge.recoverTerminalPublication({
        ...completedIdentity,
        parentAttemptId: siblingId('att', 'D'),
      })
    ).rejects.toThrow('DELEGATION_RUNTIME_ADMISSION_DENIED')
    const usageBeforeRepair = await trackAll(
      host.starts.map((request) => ledger.entries(ids.workspaceId, request.executionId))
    )
    await trackAll([
      recoveryBridge.recoverTerminalPublication(completedIdentity),
      recoveryBridge.recoverTerminalPublication(completedIdentity),
    ])
    expect((await recoveryRecords.getTerminalReceipt(completedIdentity.delegationId)).status).toBe(
      'published'
    )
    expect(
      (await recoveryInbox.list()).filter((event) => event.type === 'delegation.completed')
    ).toEqual([pending.event])
    expect(
      await trackAll(
        host.starts.map((request) => ledger.entries(ids.workspaceId, request.executionId))
      )
    ).toEqual(usageBeforeRepair)
    await feed.replay()
    const packets = feed
      .takeDeliveries()
      .filter((delivery) => delivery.kind === 'evidence')
      .map((delivery) => delivery.packet)
    expect((await runtime.adapter.status(handles[0])).state).toBe('cancelling')
    expect(
      runtime.adapter.journal.get(handles[0].handleId).detail.cancellationIntent
    ).toMatchObject({ targetKind: 'active_generation' })
    expect(packets.flatMap((packet) => packet.entries).map((entry) => entry.phase)).toContain(
      'completed'
    )
    const entries = await trackAll(
      host.starts.map((request) => ledger.entries(ids.workspaceId, request.executionId))
    )
    expect(entries[0].filter((entry) => entry.kind === 'model_usage')).toEqual([])
    expect(entries[0].some((entry) => entry.kind === 'model_reservation')).toBe(true)
    expect(entries[1].filter((entry) => entry.kind === 'model_usage')).toMatchObject([
      { quantity: { value: 8, unit: 'tokens' }, costMicrounits: 11 },
    ])
    await runtime.close()
    runtime = await createNodePiDurableRuntime(options)
    expect(
      await trackAll(host.starts.map((request) => runtime.adapter.findExistingHandle(request)))
    ).toEqual(handles)
    expect(
      await trackAll(handles.map(async (handle) => (await runtime.adapter.status(handle)).state))
    ).toEqual(['cancelling', 'completed'])
    const restartedFeed = makeFeed()
    await restartedFeed.replay()
    expect(restartedFeed.takeDeliveries().length).toBeGreaterThan(0)
    await restartedFeed.replay()
    expect(restartedFeed.takeDeliveries()).toEqual([])
    expect(
      await trackAll(
        host.starts.map((request) => ledger.entries(ids.workspaceId, request.executionId))
      )
    ).toEqual(entries)
    expect(requests).toHaveLength(2)
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    release.forEach((item) => item.resolve())
    await cleanupChildHost({
      directory,
      ownedWork,
      primaryFailure,
      closeSteps: [
        () => runtime?.close(),
        () => server?.stop(true),
        () => reopenedCanonical?.close(),
        () => provider?.close(),
      ],
      removeDirectory: (path) => rm(path, { recursive: true, force: true }),
    })
  }
}, 30000)

test('child native-start-to-mapping recovery retains metadata without another runtime effect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-child-mapping-gap-'))
  let f
  let reopenedCanonical
  try {
    f = await createGovernedChildCompositionFixture(directory, {
      transactionalChildAdmission: true,
    })
    let mappingFaults = 0
    const failFirstMapping = new Proxy(f.storage.delegations, {
      get(target, key) {
        if (key === 'bindChildSession')
          return async (...args) => {
            if (++mappingFaults === 1) throw new Error('CRASH_AFTER_NATIVE_START_BEFORE_CP_MAPPING')
            return target.bindChildSession(...args)
          }
        const value = target[key]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const faultBridge = new CanonicalDelegationRuntimeBridge({
      ...f.host.bridgeOptions,
      childReceipts: failFirstMapping,
      terminalPublisher: f.storage.events,
    })
    // Only the receipt writer is faulted. Existing grants, compiler admission,
    // approvals, provider transport, funding and pricing are unchanged.
    f.host.executor.options.bridge = faultBridge
    let gatewayFailure
    const invoke = f.host.service.gateway.invoke.bind(f.host.service.gateway)
    f.host.service.gateway.invoke = async (...args) => {
      try {
        return await invoke(...args)
      } catch (error) {
        gatewayFailure = {
          effectState: error.effectState,
          packageErrorIdentity: error instanceof PackageToolGatewayError,
        }
        throw error
      }
    }
    await f.leadRuntime.adapter.start(f.leadRequest)
    await f.leadRuntime.adapter.drain()
    await f.childRuntime.adapter.drain()
    expect(mappingFaults).toBe(1)
    expect(f.host.starts).toHaveLength(1)
    expect(f.child.requests).toHaveLength(1)
    const startRequest = f.host.starts[0]
    const nativeHandle = await f.childRuntime.adapter.findExistingHandle(startRequest)
    expect(nativeHandle.externalSessionId).toBeDefined()
    const mappingBefore = await f.storage.delegations.getChildMapping(f.ids.childAttemptId)
    expect(mappingBefore.externalSessionId).toBeUndefined()
    const callBefore = await f.storage.calls.get(f.host.request.toolCallId)
    expect(gatewayFailure).toEqual({ effectState: 'unknown', packageErrorIdentity: true })
    expect(callBefore.status).toBe('reconciliation_required')
    // The composed gateway and service share typed error identity. Metadata repair
    // preserves the conservative tool outcome; CP935 still owns reconciliation.
    console.log(
      'native mapping fault evidence',
      JSON.stringify({
        toolStatus: callBefore.status,
        childRequests: f.child.requests.length,
        gatewayFailure,
      })
    )
    const compilerReceipt = await f.storage.admissions.getByRequestId(f.host.request.requestId)
    const replay = await f.host.service.execute(compilerReceipt.request)
    expect(replay.state).toBe('reconciliation_required')
    expect(replay.call).toEqual(callBefore)
    expect(f.host.starts).toHaveLength(1)
    const usageBefore = await f.ledger.entries(f.ids.workspaceId, f.ids.childExecutionId)
    expect(usageBefore.filter((entry) => entry.kind === 'model_usage')).toHaveLength(1)
    await f.reopenChild()
    reopenedCanonical = new SqlitePersistenceProvider({ path: join(directory, 'canonical.sqlite') })
    await reopenedCanonical.migrate()
    const records = new SqliteDelegationRepository(reopenedCanonical)
    const calls = new SqliteToolCallRepository(reopenedCanonical, f.ids.workspaceId)
    expect(await f.childRuntime.adapter.findExistingHandle(startRequest)).toEqual(nativeHandle)
    expect(await records.getChildMapping(f.ids.childAttemptId)).toEqual(mappingBefore)
    expect(await calls.get(f.host.request.toolCallId)).toEqual(callBefore)
    expect(f.child.requests).toHaveLength(1)
    expect(await f.ledger.entries(f.ids.workspaceId, f.ids.childExecutionId)).toEqual(usageBefore)
    let readChecks = 0
    const forbiddenEffect = async () => {
      throw new Error('METADATA_REPAIR_MUST_NOT_DISPATCH_OR_SPEND')
    }
    const nativeReceiptReader = {
      runtimeConnectionId: f.host.bridgeOptions.runtimeConnectionId,
      findExistingHandle: (request) => f.childRuntime.adapter.findExistingHandle(request),
    }
    const recoveryBridge = new CanonicalDelegationRuntimeBridge({
      ...f.host.bridgeOptions,
      records,
      childReceipts: records,
      plans: new SqliteExecutionPlanRepository(reopenedCanonical),
      lifecycle: new ExecutionLifecycleService(new SqliteExecutionRepository(reopenedCanonical)),
      terminalPublisher: f.storage.events,
      runtime: { start: forbiddenEffect },
      assertAuthority: forbiddenEffect,
      reserveBudget: forbiddenEffect,
      // Test-only qualified host read authority. Production composition must
      // independently authenticate/qualify its implementation; schema cannot.
      nativeReceiptReader,
      receiptReadAuthority: {
        readerPrincipalId: 'svc_product-reader',
        audienceRef: 'scope:workspace-lead',
        now: () => '2026-08-25T18:02:00.000Z',
        async assertQualified(scope) {
          expect(scope.nativeReceiptReader).toBe(nativeReceiptReader)
          expect(scope.workspaceId).toBe(f.ids.workspaceId)
          expect(scope.runtimeConnectionId).toBe(f.host.bridgeOptions.runtimeConnectionId)
          if (!f.state.active.lead || !f.state.active.child)
            throw new Error('CHILD_RECEIPT_READ_UNQUALIFIED')
        },
        async assertCurrent(receipt, reader) {
          readChecks++
          const call = reader
            ? await reader.getToolCall(f.host.request.toolCallId)
            : await calls.get(f.host.request.toolCallId)
          expect(receipt.originalActorPrincipalId).toBe(call.principalRef)
          expect(receipt.originalActorPrincipalId).toBe(f.actor)
          expect(receipt.workspaceId).toBe(f.ids.workspaceId)
          if (reader)
            expect((await reader.getAttempt(f.ids.childAttemptId)).executionId).toBe(
              f.ids.childExecutionId
            )
          if (!f.state.active.lead || !f.state.active.child)
            throw new Error('CHILD_RECEIPT_READ_REVOKED')
          return {
            workspaceId: receipt.workspaceId,
            runtimeConnectionId: receipt.runtimeConnectionId,
            originalActorPrincipalId: receipt.originalActorPrincipalId,
            readerPrincipalId: 'svc_product-reader',
            audienceRef: 'scope:workspace-lead',
            authorityRevision: 1,
            expiresAt: '2999-01-01T00:00:00.000Z',
          }
        },
      },
    })
    const repaired = await recoveryBridge.recoverChildSession(f.identity)
    expect(repaired.handle).toEqual(nativeHandle)
    expect(repaired.mapping).toEqual({
      ...mappingBefore,
      externalSessionId: nativeHandle.externalSessionId,
    })
    expect(await records.getChildMapping(f.ids.childAttemptId)).toEqual(repaired.mapping)
    expect(await recoveryBridge.recoverChildSession(f.identity)).toEqual(repaired)
    expect(readChecks).toBeGreaterThanOrEqual(2)
    expect(await calls.get(f.host.request.toolCallId)).toEqual(callBefore)
    expect(await f.ledger.entries(f.ids.workspaceId, f.ids.childExecutionId)).toEqual(usageBefore)
    expect(f.child.requests).toHaveLength(1)
    expect(f.host.starts).toHaveLength(1)
  } finally {
    await reopenedCanonical?.close()
    await f?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

for (const revoked of ['host grant', 'tool approval'])
  test(`receipt retention await rechecks revoked ${revoked} before native start`, async () => {
    const arrived = Promise.withResolvers()
    const release = Promise.withResolvers()
    let allowed = true
    let budgets = 0
    let retainedRequest
    const f = await fixture({
      async onBudget() {
        budgets++
      },
      async onAuthority() {
        if (!allowed) throw new Error('TEST_HOST_GRANT_REVOKED')
        const approval = await f.service.approvals.review({
          interactionId: f.request.approval.interactionId,
        })
        if (approval.state !== 'approved') throw new Error('TEST_TOOL_APPROVAL_REVOKED')
      },
    })
    f.bridgeOptions.childReceipts = new Proxy(f.delegations, {
      get(target, property) {
        if (property === 'retainChildRuntimeStart')
          return async (input) => {
            await target.retainChildRuntimeStart(input)
            retainedRequest = structuredClone(input.request)
            arrived.resolve()
            await release.promise
          }
        const value = target[property]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const before = await f.lifecycle.getExecution(ids.parentExecutionId)
    const pending = f.service.execute(f.request)
    await arrived.promise
    const parent = await f.lifecycle.getExecution(ids.parentExecutionId)
    const child = await f.lifecycle.getExecution(ids.childExecutionId)
    expect(parent.latestAttemptId).toBe(before.latestAttemptId)
    if (revoked === 'host grant') allowed = false
    else
      f.service.approvals.review = async () => ({
        state: 'revoked',
        interactionId: f.request.approval.interactionId,
      })
    release.resolve()
    const outcome = await pending
    expect(outcome.state).toBe('reconciliation_required')
    expect(f.starts).toHaveLength(0)
    expect(f.sessions.size).toBe(0)
    expect(budgets).toBe(1)
    expect(await f.lifecycle.getExecution(ids.parentExecutionId)).toEqual(parent)
    expect(await f.lifecycle.getExecution(ids.childExecutionId)).toEqual(child)
    expect((await f.delegations.getChildRuntimeStart(ids.delegationId)).receipt.request).toEqual(
      retainedRequest
    )
  })

test('receipt retention refresh rechecks canonical cancellation after the new authority await', async () => {
  const arrived = Promise.withResolvers()
  const release = Promise.withResolvers()
  let checks = 0
  let budgets = 0
  const f = await fixture({
    async onBudget() {
      budgets++
    },
    async onAuthority() {
      if (++checks === 3) {
        arrived.resolve()
        await release.promise
      }
    },
  })
  f.bridgeOptions.childReceipts = f.delegations
  const pending = f.service.execute(f.request)
  await arrived.promise
  await mutateCanonicalStartFence(f, 'parent_cancelled')
  release.resolve()
  expect((await pending).state).toBe('reconciliation_required')
  expect(checks).toBe(3)
  expect(budgets).toBe(1)
  expect(f.starts).toHaveLength(0)
  expect(f.sessions.size).toBe(0)
})
