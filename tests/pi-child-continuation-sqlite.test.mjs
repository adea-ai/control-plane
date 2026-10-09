import { expect, test } from 'bun:test'
import { SqlitePiChildContinuationRepository } from '../apps/control-api/src/pi-durable/sqlite-child-continuations.ts'
test('missing current metadata and authority cannot retain a continuation', async () => {
  const repository = new SqlitePiChildContinuationRepository({
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
    provider: { transaction: async (fn) => fn({}) },
    now: () => new Date().toISOString(),
  })
  await expect(repository.retain({})).rejects.toThrow('PI_CHILD_CONTINUATION_DENIED')
})
import { afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { ChildProgressInputSchema, DelegationRecordSchema } from '@control-plane/orchestration'
import { toolRequestDigest } from '@control-plane/tool-execution'
import { ToolCallSchema } from '../packages/tool-sdk/dist/index.js'
import {
  SqlitePersistenceProvider,
  SqliteExecutionRepository,
  SqliteExecutionPlanRepository,
  SqliteContextPackageRepository,
  SqliteDelegationRepository,
  SqliteDelegationToolAdmissionRepository,
  SqliteToolCallRepository,
  SqliteDurableUsageStore,
} from '@control-plane/sqlite-persistence'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import {
  createFixture,
  delegationInput,
  ids,
} from '../packages/orchestration/src/delegation-fixtures.mjs'
import { piDurableToolSourceKey } from '@control-plane/pi-durable-adapter'
import {
  piChildContinuationRequestDigest,
  piChildContinuationAdmissionDigest,
  piChildContinuationStartRequestDigest,
} from '@control-plane/pi-durable-adapter'
import {
  workspaceInput,
  currentSnapshot,
} from '../packages/orchestration/src/delegation-workspace-fixtures.mjs'
const parentAttemptId = 'att_01JABCDEF0123456789ABCDEFG'
const at = '2026-08-25T18:03:00.000Z'
const expiresAt = '2026-08-25T18:09:00.000Z'
const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const hash = (value) =>
  `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`
const recordId = (value) => `r-${createHash('sha256').update(value).digest('hex')}`
const pin = (plan) => ({
  executionPlanId: plan.executionPlanId,
  contentDigest: plan.contentDigest,
  schemaVersion: plan.schemaVersion,
})
const cleanups = []
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f()
})
async function fixture({ crossScope = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-child-continuation-'))
  const path = join(directory, 'canonical.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  await provider.migrate()
  cleanups.push(async () => {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  })
  const state = { now: at, active: true, metadata: undefined, reads: 0, current: 0 }
  const workspace = crossScope ? workspaceInput() : undefined
  const scopeReads = []
  const scopeAuthority = {
    async readCurrent(input) {
      scopeReads.push(structuredClone(input))
      return {
        ...currentSnapshot(input),
        allowedPrincipalIds: [input.callerPrincipalId],
        grantActive: state.active,
      }
    },
  }
  let storage, repository
  const open = () => {
    storage = {
      executions: new SqliteExecutionRepository(provider),
      plans: new SqliteExecutionPlanRepository(provider),
      contexts: new SqliteContextPackageRepository(provider),
      delegations: new SqliteDelegationRepository(provider),
      // Canonical governed-child admission ports (CP1041): scope admission is
      // mandatory at delegate and dispatch, and the authority produces the
      // retained receipt over the exact request the service builds.
      scopeAdmission: {
        authority: scopeAuthority,
        now: () => state.now,
        resolveCallerPrincipalId: async () => 'principal:original-actor',
      },
      childAdmission: {
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
      },
    }
    storage.childAllocator = storage.delegations
    if (workspace)
      Object.assign(storage, {
        parentPlan: workspace.parentPlan,
        parentContext: workspace.parentContext,
        scopeAdmission: {
          authority: scopeAuthority,
          now: () => state.now,
          resolveCallerPrincipalId: async () => 'principal:original-actor',
        },
      })
    repository = new SqlitePiChildContinuationRepository({
      provider,
      workspaceId: ids.workspaceId,
      now: () => state.now,
      ...(crossScope ? { scopeAuthority: () => scopeAuthority } : {}),
      readChildMetadata: async () => {
        state.reads++
        return structuredClone(state.metadata)
      },
      readChildMetadataNow: () => structuredClone(state.metadata),
      assertCurrent: async () => {
        state.current++
        if (!state.active) throw new Error('private-revocation-canary')
      },
    })
  }
  open()
  const base = await createFixture(undefined, storage)
  // Governed allocation reserves on the canonical parent budget transaction,
  // so the durable parent budget must exist before any child admission; the
  // parent execution exists only after createFixture above.
  const usageLedger = new DurableUsageLedger({
    store: new SqliteDurableUsageStore(provider),
    now: () => state.now,
  })
  await usageLedger.openBudget({
    workspaceId: ids.workspaceId,
    executionId: ids.parentExecutionId,
    currency: 'USD',
    maximumMicrounits: 10_000_000,
    maximumTokens: 250_000,
    source: { sourceId: 'continuation-fixture', idempotencyKey: 'parent-budget-open' },
  })
  await base.lifecycle.createAttempt({
    executionId: ids.parentExecutionId,
    attemptId: parentAttemptId,
    expectedExecutionVersion: 1,
    queuedAt: '2026-08-25T18:00:01.000Z',
  })
  for (const target of ['queued', 'running']) {
    const e = await base.lifecycle.getExecution(ids.parentExecutionId)
    await base.lifecycle.transitionExecution({
      executionId: e.executionId,
      expectedVersion: e.version,
      to: target,
      transitionedAt: '2026-08-25T18:00:02.000Z',
    })
  }
  await base.lifecycle.transitionAttempt({
    attemptId: parentAttemptId,
    expectedVersion: 1,
    to: 'running',
    transitionedAt: '2026-08-25T18:00:02.000Z',
  })
  const command = workspace ? structuredClone(workspace.command) : delegationInput(base)
  command.parentAttemptId = parentAttemptId
  command.admittedToolCallId = id('tlc')
  // Canonical governed-child admission (CP1041): server-bound parent product
  // intent, stable child attempt identity, and the exact initial dispatch the
  // admission transaction allocates atomically.
  command.parentIntentId = '11111111-1111-4111-8111-111111111112'
  command.childAttemptId = ids.childAttemptId
  const dispatch = {
    delegationId: ids.delegationId,
    childAttemptId: ids.childAttemptId,
    runtime: { runtimeConnectionId: id('rtc') },
    dispatchedAt: '2026-08-25T18:02:00.000Z',
  }
  command.initialDispatch = structuredClone(dispatch)
  await storage.contexts.put(command.childPlan.contextPackage)
  const delegated = await base.service.delegate(command)
  await base.service.dispatchChild(dispatch)
  await base.service.recordChildProgress({
    delegationId: ids.delegationId,
    childAttemptId: ids.childAttemptId,
    state: 'running',
    observedAt: '2026-08-25T18:02:10.000Z',
  })
  const source = {
    schemaVersion: 'pi-tool-source/v1',
    workspaceId: ids.workspaceId,
    parentExecutionId: ids.parentExecutionId,
    parentAttemptId,
    runtimeHandleId: 'pi:parent:one',
    externalSessionId: id('ses'),
    admittedTurnKey: 'pi-turn:initial',
    conversationId: 'conversation:one',
    taskId: 'task:one',
    assistantEntryId: 'entry:one',
    callId: 'call:one',
  }
  const request = {
    requestId: id('req'),
    toolCallId: id('tlc'),
    executionId: ids.parentExecutionId,
    attemptId: parentAttemptId,
    workspaceId: ids.workspaceId,
    profileId: ids.profileId,
    toolDefinitionId: id('tld'),
    toolVersionId: id('tlv'),
    operation: 'delegate-child',
    input: { objective: command.objective },
    idempotencyKey: piDurableToolSourceKey(source),
    requestedAt: '2026-08-25T18:01:00.000Z',
    policySnapshotRef: 'policy://canonical/one',
    grant: {
      workspaceId: ids.workspaceId,
      profileId: ids.profileId,
      toolDefinitionId: id('tld'),
      toolVersionId: id('tlv'),
      operations: ['delegate-child'],
      expiresAt,
    },
    audit: { principalRef: 'principal:original-actor', traceId: id('trc') },
    approval: {
      interactionId: id('int'),
      allowedPrincipalIds: ['principal:original-actor'],
      requestedAt: '2026-08-25T18:01:00.000Z',
      expiresAt,
    },
  }
  await new SqliteDelegationToolAdmissionRepository(provider, ids.workspaceId).retain({
    schemaVersion: 'delegation-tool-admission/v1',
    sourceKey: piDurableToolSourceKey(source),
    request,
    command: { delegation: command, dispatch },
  })
  const handle = {
    handleId: 'pi:child:one',
    attemptId: ids.childAttemptId,
    externalSessionId: 'ses_01JBBCDEF0123456789ABCDEFG',
    startedAt: '2026-08-25T18:02:10.000Z',
  }
  const childPlan = delegated.plan
  const budget = {
    schemaVersion: 1,
    workspaceId: ids.workspaceId,
    executionId: ids.childExecutionId,
    attemptId: ids.childAttemptId,
    executionPlanId: childPlan.executionPlanId,
    executionPlanDigest: childPlan.contentDigest,
    reservationKey: `runtime-attempt:${ids.childAttemptId}`,
    currency: 'USD',
    maximumMicrounits: 1000,
    maximumTokens: 100,
  }
  const admission = {
    schemaVersion: 'pi-durable-admission/v1',
    prompt: 'Bounded child prompt',
    canonicalActorPrincipalId: 'principal:original-actor',
    selection: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 },
    authority: {
      revision: 1,
      principalRef: 'lease:canonical',
      scopeRef: 'scope:canonical',
      expiresAt,
    },
  }
  const startRequest = {
    executionId: ids.childExecutionId,
    attemptId: ids.childAttemptId,
    executionPlan: childPlan,
    idempotencyKey: `delegation:${ids.delegationId}:attempt:${ids.childAttemptId}`,
    attemptBudget: budget,
  }
  state.metadata = structuredClone({ handle, request: startRequest, admission, state: 'running' })
  const grant = {
    schemaVersion: 'pi-child-continuation/v1',
    grantRef: `pcc_${'a'.repeat(32)}`,
    workspaceId: ids.workspaceId,
    canonicalActorPrincipalId: 'principal:original-actor',
    parent: {
      executionId: ids.parentExecutionId,
      attemptId: parentAttemptId,
      runtime: (await storage.executions.getAttempt(parentAttemptId)).runtime ?? null,
      executionPlan: pin(base.parentPlan),
    },
    child: {
      executionId: ids.childExecutionId,
      attemptId: ids.childAttemptId,
      runtime: (await storage.executions.getAttempt(ids.childAttemptId)).runtime ?? null,
      executionPlan: pin(childPlan),
      handle,
      admissionDigest: piChildContinuationAdmissionDigest(admission),
      startRequestDigest: piChildContinuationStartRequestDigest(startRequest),
    },
    source,
    sourceKey: piDurableToolSourceKey(source),
    requestDigest: piChildContinuationRequestDigest(request),
    admittedToolCallId: request.toolCallId,
    approval: {
      interactionId: id('int'),
      principalRef: 'principal:original-actor',
      grantRef: 'grant:canonical',
      grantRevision: 1,
    },
    selection: admission.selection,
    budget,
    authorityRevision: 1,
    createdAt: at,
    expiresAt,
  }
  const executor = { type: 'internal', reference: 'internal://delegate-child' }
  const call = ToolCallSchema.parse({
    toolCallId: request.toolCallId,
    requestDigest: toolRequestDigest(request),
    executionId: request.executionId,
    attemptId: request.attemptId,
    workspaceId: request.workspaceId,
    profileId: request.profileId,
    principalRef: request.audit.principalRef,
    toolDefinitionId: request.toolDefinitionId,
    toolVersionId: request.toolVersionId,
    operation: request.operation,
    inputDigest: hash(request.input),
    policySnapshotRef: request.policySnapshotRef,
    policyDecision: {
      effect: 'allow',
      decisionId: 'decision:one',
      policyVersion: '1',
      reasonCode: 'ALLOW',
      requiresApproval: true,
      evaluatedAt: request.requestedAt,
    },
    approvalInteractionId: id('int'),
    approvalPrincipalRef: 'principal:original-actor',
    executor,
    idempotencyKey: request.idempotencyKey,
    status: 'succeeded',
    revision: 4,
    requestedAt: request.requestedAt,
    completedAt: at,
    history: [{ status: 'succeeded', at }],
    result: {
      toolDefinitionId: request.toolDefinitionId,
      toolVersionId: request.toolVersionId,
      operation: request.operation,
      output: {
        delegationId: ids.delegationId,
        childExecutionId: ids.childExecutionId,
        childAttemptId: ids.childAttemptId,
        externalSessionId: handle.externalSessionId,
      },
      artifactRefs: [],
      executor,
      attempts: 1,
      audit: {
        principalRef: request.audit.principalRef,
        traceId: request.audit.traceId,
        contentDigest: hash({}),
      },
    },
  })
  await new SqliteToolCallRepository(provider, ids.workspaceId).insert(call)
  await provider.transaction((tx) =>
    tx.put({
      namespace: 'interaction-requests',
      id: recordId(id('int')),
      value: {
        interactionId: id('int'),
        executionId: ids.parentExecutionId,
        attemptId: parentAttemptId,
        kind: 'approval',
        prompt: { title: 'Approve bounded child' },
        allowedActions: ['approve', 'deny'],
        allowedPrincipalIds: ['principal:original-actor'],
        state: 'responded',
        version: 2,
        requestedAt: request.requestedAt,
        expiresAt,
        response: {
          responseId: id('cmd'),
          action: 'approve',
          respondingPrincipalId: 'principal:original-actor',
          respondedAt: at,
        },
      },
    })
  )
  const mutate = async (namespace, identity, change) =>
    provider.transaction(async (tx) => {
      const row = await tx.get(namespace, recordId(identity))
      await tx.put({
        namespace,
        id: row.id,
        expectedRevision: row.revision,
        value: change(structuredClone(row.value)),
      })
    })
  const complete = async () => {
    const repo = new SqliteExecutionRepository(provider)
    const e = await repo.getExecution(ids.parentExecutionId)
    await repo.compareAndSetExecution(e.version, {
      ...e,
      state: 'completed',
      version: e.version + 1,
      terminalAt: at,
      updatedAt: at,
      terminalResultRef: id('art'),
    })
    const a = await repo.getAttempt(parentAttemptId)
    await repo.compareAndSetAttempt(a.version, {
      ...a,
      state: 'completed',
      version: a.version + 1,
      terminalAt: at,
      updatedAt: at,
      terminalResultRef: id('art'),
    })
  }
  return {
    grant,
    scopeReads,
    state,
    request,
    call,
    base,
    get storage() {
      return storage
    },
    get repository() {
      return repository
    },
    get provider() {
      return provider
    },
    mutate,
    complete,
    reopen: async () => {
      await provider.close()
      provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      open()
    },
  }
}

test('immutable grant survives SQLite close/reopen and parent completion without expiry or authority refresh', async () => {
  const f = await fixture()
  expect(await f.repository.retain(f.grant)).toEqual({ grant: f.grant, replayed: false })
  await f.complete()
  await f.reopen()
  expect(await f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)).toEqual(f.grant)
  expect(await f.repository.retain(structuredClone(f.grant))).toEqual({
    grant: f.grant,
    replayed: true,
  })
  expect(f.state.current).toBe(3)
  await expect(
    f.repository.retain({ ...f.grant, expiresAt: '2026-08-25T18:10:00.000Z' })
  ).rejects.toThrow('PI_CHILD_CONTINUATION_DENIED')
  expect(await f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)).toEqual(f.grant)
})
test('parent completion wins canonical writer race and prevents initial grant retention', async () => {
  const f = await fixture()
  const complete = f.complete()
  await complete
  await expect(f.repository.retain(f.grant)).rejects.toThrow('PI_CHILD_CONTINUATION_DENIED')
  expect(await f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)).toBeUndefined()
})
test.each([
  'latest-parent',
  'latest-child',
  'full-request',
  'delegation-command',
  'child-context',
  'source-index',
  'approval',
  'child-handle',
  'child-admission',
  'child-start',
  'current',
  'expired',
  'missing-metadata',
  'missing-current',
])('current %s mismatch fails closed without updating retained grant', async (fault) => {
  const f = await fixture()
  await f.repository.retain(f.grant)
  if (fault === 'latest-parent' || fault === 'latest-child')
    await f.mutate(
      'executions',
      fault === 'latest-parent' ? ids.parentExecutionId : ids.childExecutionId,
      (e) => ({ ...e, latestAttemptId: 'att_01JCBCDEF0123456789ABCDEFG', attemptCount: 2 })
    )
  if (fault === 'full-request')
    await f.mutate(
      `delegation-tool-admissions-${ids.workspaceId.toLowerCase()}`,
      f.request.requestId,
      (a) => ({
        ...a,
        request: {
          ...a.request,
          grant: { ...a.request.grant, expiresAt: '2026-08-25T18:10:00.000Z' },
        },
      })
    )
  if (fault === 'delegation-command')
    await f.mutate('delegations', ids.delegationId, (row) => ({
      ...row,
      inputDigest: hash({ tampered: true }),
    }))
  if (fault === 'child-context')
    await f.mutate(
      'context-packages',
      f.state.metadata.request.executionPlan.contextPackage.contextPackageId,
      (row) => ({ ...row, contentDigest: hash({ tampered: true }) })
    )
  if (fault === 'source-index')
    await f.provider.transaction((tx) =>
      tx.delete(
        `delegation-tool-sources-${ids.workspaceId.toLowerCase()}`,
        f.grant.sourceKey.slice(8)
      )
    )
  if (fault === 'approval')
    await f.mutate('interaction-requests', id('int'), (r) => ({
      ...r,
      response: { ...r.response, action: 'deny' },
    }))
  if (fault === 'child-handle') f.state.metadata.handle.handleId = 'pi:changed'
  if (fault === 'child-admission') f.state.metadata.admission.selection.selectionRevision++
  if (fault === 'child-start') f.state.metadata.request.idempotencyKey += ':different'
  if (fault === 'current') f.state.active = false
  if (fault === 'expired') f.state.now = f.grant.expiresAt
  if (fault === 'missing-metadata') f.state.metadata = undefined
  if (fault === 'missing-current') f.repository.options.assertCurrent = undefined
  await expect(f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)).rejects.toThrow(
    'PI_CHILD_CONTINUATION_DENIED'
  )
  const rows = await f.provider.transaction((tx) => tx.list('pi-child-continuations'))
  expect(rows).toHaveLength(1)
  expect(rows[0].value).toEqual(f.grant)
})

test('retention wins the writer race before completion and survives its later commit', async () => {
  const f = await fixture()
  let entered, release
  const enteredPromise = new Promise((resolve) => (entered = resolve))
  const releasePromise = new Promise((resolve) => (release = resolve))
  f.repository.options.readChildMetadata = async ({ transaction }) => {
    const parent = await transaction.get('executions', recordId(ids.parentExecutionId))
    expect(parent.value.state).toBe('running')
    entered()
    await releasePromise
    return structuredClone(f.state.metadata)
  }
  const retained = f.repository.retain(f.grant)
  await enteredPromise
  let completed = false
  const completion = f.complete().then(() => (completed = true))
  await Promise.resolve()
  expect(completed).toBe(false)
  release()
  expect((await retained).replayed).toBe(false)
  await completion
  f.repository.options.readChildMetadata = async () => structuredClone(f.state.metadata)
  expect(await f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)).toEqual(f.grant)
})

test('a competing completion writer queued first prevents grant commit', async () => {
  const f = await fixture()
  let entered, release
  const enteredPromise = new Promise((resolve) => (entered = resolve))
  const releasePromise = new Promise((resolve) => (release = resolve))
  const completion = f.provider.transaction(async (tx) => {
    const e = await tx.get('executions', recordId(ids.parentExecutionId))
    const a = await tx.get('execution-attempts', recordId(parentAttemptId))
    entered()
    await releasePromise
    for (const [row, namespace] of [
      [e, 'executions'],
      [a, 'execution-attempts'],
    ])
      await tx.put({
        namespace,
        id: row.id,
        expectedRevision: row.revision,
        value: {
          ...row.value,
          state: 'completed',
          version: row.value.version + 1,
          terminalAt: at,
          updatedAt: at,
          terminalResultRef: id('art'),
        },
      })
  })
  await enteredPromise
  const retain = f.repository.retain(f.grant)
  release()
  await completion
  await expect(retain).rejects.toThrow('PI_CHILD_CONTINUATION_DENIED')
  expect(await f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)).toBeUndefined()
})

test('expiry during awaited current authority check rolls back the initial grant and retention metadata', async () => {
  const f = await fixture()
  f.repository.options.assertCurrent = async () => {
    f.state.now = expiresAt
  }
  await expect(f.repository.retain(f.grant)).rejects.toThrow('PI_CHILD_CONTINUATION_DENIED')
  expect(await f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)).toBeUndefined()
})

test.each(['cancelled', 'failed'])(
  'retained evidence cannot resume under %s parent authority',
  async (state) => {
    const f = await fixture()
    await f.repository.retain(f.grant)
    await f.mutate('executions', ids.parentExecutionId, (e) => ({
      ...e,
      state,
      version: e.version + 1,
      updatedAt: at,
      ...(state === 'cancelled'
        ? { terminalAt: at }
        : {
            terminalAt: at,
            failure: { classification: 'runtime_error', code: 'FAILED', retryable: false },
          }),
    }))
    await expect(
      f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)
    ).rejects.toThrow('PI_CHILD_CONTINUATION_DENIED')
  }
)

test.each(['selection', 'budget', 'approval', 'authority'])(
  'identical replay cannot refresh %s pins',
  async (pinName) => {
    const f = await fixture()
    await f.repository.retain(f.grant)
    const changed = structuredClone(f.grant)
    if (pinName === 'selection') changed.selection.selectionRevision++
    if (pinName === 'budget') changed.budget.maximumTokens++
    if (pinName === 'approval') changed.approval.grantRevision++
    if (pinName === 'authority') changed.authorityRevision++
    await expect(f.repository.retain(changed)).rejects.toThrow('PI_CHILD_CONTINUATION_DENIED')
    expect(await f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)).toEqual(
      f.grant
    )
  }
)

test('host authority diagnostics are contained and grant reads reject cross-workspace scope', async () => {
  const f = await fixture()
  await f.repository.retain(f.grant)
  f.state.active = false
  let error
  try {
    await f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)
  } catch (value) {
    error = value
  }
  expect(String(error)).toBe('Error: PI_CHILD_CONTINUATION_DENIED')
  expect(String(error)).not.toContain('private-revocation-canary')
  await expect(
    f.repository.getByChildAttempt('wsp_01JBBCDEF0123456789ABCDEFG', ids.childAttemptId)
  ).rejects.toThrow('PI_CHILD_CONTINUATION_DENIED')
})

test('workspace parent and real project child retain and replay only with both current exact scope grants', async () => {
  const f = await fixture({ crossScope: true })
  f.scopeReads.length = 0
  await f.repository.retain(f.grant)
  expect(f.scopeReads.map((r) => r.executionScope.kind)).toEqual(['workspace', 'project'])
  expect(f.scopeReads.map((r) => r.executionPlan.contentDigest)).toEqual([
    f.grant.parent.executionPlan.contentDigest,
    f.grant.child.executionPlan.contentDigest,
  ])
  await f.complete()
  await f.reopen()
  f.scopeReads.length = 0
  expect(await f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)).toEqual(f.grant)
  expect(f.scopeReads.map((r) => r.executionScope.kind)).toEqual(['workspace', 'project'])
  f.repository.options.scopeAuthority = undefined
  await expect(f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)).rejects.toThrow(
    'PI_CHILD_CONTINUATION_DENIED'
  )
})

test.each(['initial', 'retained'])(
  'persisted pending child completion intent blocks %s continuation before canonical transitions',
  async (mode) => {
    const f = await fixture()
    if (mode === 'retained') await f.repository.retain(f.grant)
    const pendingProgress = ChildProgressInputSchema.parse({
      delegationId: ids.delegationId,
      childAttemptId: ids.childAttemptId,
      state: 'completed',
      observedAt: at,
      terminalResultRef: id('art'),
    })
    await f.mutate('delegations', ids.delegationId, (record) =>
      DelegationRecordSchema.parse({ ...record, pendingProgress, revision: record.revision + 1 })
    )
    await f.reopen()
    expect((await f.storage.executions.getExecution(ids.parentExecutionId)).state).toBe('running')
    expect((await f.storage.executions.getExecution(ids.childExecutionId)).state).toBe('running')
    if (mode === 'initial') {
      await expect(f.repository.retain(f.grant)).rejects.toThrow('PI_CHILD_CONTINUATION_DENIED')
      expect(
        await f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)
      ).toBeUndefined()
    } else {
      await expect(
        f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)
      ).rejects.toThrow('PI_CHILD_CONTINUATION_DENIED')
      await expect(f.repository.retain(f.grant)).rejects.toThrow('PI_CHILD_CONTINUATION_DENIED')
      const rows = await f.provider.transaction((tx) => tx.list('pi-child-continuations'))
      expect(rows).toHaveLength(1)
      expect(rows[0].value).toEqual(f.grant)
    }
  }
)

test.each(['initial', 'retained'])(
  'misplaced approved interaction sibling blocks %s continuation by exact row identity',
  async (mode) => {
    const f = await fixture()
    if (mode === 'retained') await f.repository.retain(f.grant)
    await f.mutate('interaction-requests', id('int'), (record) => ({
      ...record,
      interactionId: 'int_01JBBCDEF0123456789ABCDEFG',
    }))
    await f.reopen()
    if (mode === 'initial') {
      await expect(f.repository.retain(f.grant)).rejects.toThrow('PI_CHILD_CONTINUATION_DENIED')
      expect(
        await f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)
      ).toBeUndefined()
    } else {
      await expect(
        f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)
      ).rejects.toThrow('PI_CHILD_CONTINUATION_DENIED')
      await expect(f.repository.retain(f.grant)).rejects.toThrow('PI_CHILD_CONTINUATION_DENIED')
    }
  }
)

test.each(['completed', 'failed', 'cancelled', 'unknown', 'missing'])(
  'new continuation cannot be retained from child journal %s',
  async (state) => {
    const f = await fixture()
    if (state === 'missing') delete f.state.metadata.state
    else f.state.metadata.state = state
    await expect(f.repository.retain(f.grant)).rejects.toThrow('PI_CHILD_CONTINUATION_DENIED')
    expect(
      await f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)
    ).toBeUndefined()
  }
)

test('child completion during current authority await prevents a new continuation grant', async () => {
  const f = await fixture()
  f.repository.options.assertCurrent = async () => {
    f.state.metadata.state = 'completed'
  }
  await expect(f.repository.retain(f.grant)).rejects.toThrow('PI_CHILD_CONTINUATION_DENIED')
  expect(await f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)).toBeUndefined()
})

test('completed child journal preserves exact existing grant replay without minting authority', async () => {
  const f = await fixture()
  await f.repository.retain(f.grant)
  f.state.metadata.state = 'completed'
  await f.complete()
  expect(await f.repository.retain(structuredClone(f.grant))).toEqual({
    grant: f.grant,
    replayed: true,
  })
  expect(await f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)).toEqual(f.grant)
})

test('revocation during the awaited journal read prevents a new continuation grant', async () => {
  const f = await fixture()
  let calls = 0
  f.repository.options.readChildMetadata = async () => {
    if (++calls === 2) f.state.active = false
    return structuredClone(f.state.metadata)
  }
  await expect(f.repository.retain(f.grant)).rejects.toThrow('PI_CHILD_CONTINUATION_DENIED')
  expect(await f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)).toBeUndefined()
})

test.each(['missing', 'async'])(
  'new continuation fails closed without a synchronous final journal reader: %s',
  async (fault) => {
    const f = await fixture()
    if (fault === 'missing') f.repository.options.readChildMetadataNow = undefined
    else f.repository.options.readChildMetadataNow = async () => structuredClone(f.state.metadata)
    await expect(f.repository.retain(f.grant)).rejects.toThrow('PI_CHILD_CONTINUATION_DENIED')
    expect(
      await f.repository.getByChildAttempt(ids.workspaceId, ids.childAttemptId)
    ).toBeUndefined()
  }
)
