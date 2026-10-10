import { expect, test } from 'bun:test'
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
import { ids } from '../packages/orchestration/src/delegation-fixtures.mjs'
import {
  createGovernedChildHostFixture as fixture,
  parentAttemptId,
  identity,
} from './pi-durable-child-host.fixture.mjs'

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
  const { workspaceInput, currentSnapshot, actor, now } =
    await import('../packages/orchestration/src/delegation-workspace-fixtures.mjs')
  const workspace = workspaceInput()
  workspace.scopeAdmission = {
    now: () => now,
    resolveCallerPrincipalId: async () => actor,
    authority: { readCurrent: async (input) => currentSnapshot(input) },
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
    // Another canonical writer wins the latest-attempt fence during the host await.
    expect(
      await f.executions.compareAndSetExecution(execution.version, {
        ...execution,
        version: execution.version + 1,
        latestAttemptId: 'att_01JCBCDEF0123456789ABCDEFG',
        attemptCount: execution.attemptCount + 1,
      })
    ).toBe(true)
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
  const { workspaceInput, currentSnapshot, actor, now } =
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
    authority: { readCurrent: async (input) => currentSnapshot(input) },
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
    await expect(f.bridgeOptions.delegations.delegate(f.command.delegation)).rejects.toThrow(
      'CHILD_SCOPE_EXPANSION'
    )
    expect(await storage.delegations.listByParent(ids.parentExecutionId)).toEqual([])
    expect(f.starts).toHaveLength(0)
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
