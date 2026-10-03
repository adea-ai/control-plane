import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { DurableExecutionCancellationService } from '@control-plane/domain'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import {
  assertSqliteWorkflowExecutionReference,
  SqliteExecutionCancellationRepository,
  SqliteDurableUsageStore,
  SqliteToolCallRepository,
} from '@control-plane/sqlite-persistence'
import { FilesystemObjectStore } from '@control-plane/object-store'
import { ExecutionLifecycleService, InteractionService } from '@control-plane/domain'
import { GraphNodeEffectUnconfirmedError } from '@control-plane/orchestration'
import {
  EmbeddedExecutionWorkflowDispatcher,
  EmbeddedWorkflowRuntime,
  WorkflowJobStore,
} from '@control-plane/workflow-runtime'
import { DurableExecutionLifecycleActivities } from '@control-plane/workflow-worker'
import { LangGraphSqliteCheckpointSaver } from '@control-plane/langgraph-adapter'
import { LocalGraphToolOperations } from './local-graph-tool-operations.ts'
import { ManagedLocalGraphRuntime } from './managed-graph-runtime.ts'
import { createLocalGraphToolFixture } from './local-graph-tool-fixture.mjs'

async function overwriteStoredCall(persistence, workspaceId, call) {
  const namespace = `tool-calls-r-${createHash('sha256').update(workspaceId).digest('hex')}`
  await persistence.transaction(async (transaction) => {
    const record = (await transaction.list(namespace)).find(
      (candidate) => candidate.value?.toolCallId === call.toolCallId
    )
    if (!record) throw new Error('TEST_TOOL_CALL_NOT_FOUND')
    await transaction.put({
      namespace,
      id: record.id,
      expectedRevision: record.revision,
      value: { ...record.value, call },
    })
  })
}

function noEffectCallFrom(call, index, executionId = call.executionId) {
  const requestedAt = new Date(Date.parse(call.requestedAt) - (index + 1) * 60_000).toISOString()
  const completedAt = new Date(Date.parse(requestedAt) + 1_000).toISOString()
  return {
    ...call,
    toolCallId: `tlc_${createHash('sha256').update(`fixture-filler-${index}`).digest('hex').slice(0, 26).toUpperCase()}`,
    executionId,
    idempotencyKey: `fixture-filler-${String(index).padStart(4, '0')}`,
    status: 'denied',
    revision: 1,
    requestedAt,
    completedAt,
    errorCode: 'GRAPH_TOOL_CANCELLED',
    history: [
      { status: 'requested', at: requestedAt },
      { status: 'denied', at: completedAt, reasonCode: 'GRAPH_TOOL_CANCELLED' },
    ],
  }
}

test('inspects a lost immutable write response from its persisted checkpoint without exposing input', async () => {
  const fixture = await createLocalGraphToolFixture()
  const directory = await mkdtemp(join(tmpdir(), 'local-graph-tool-recovery-'))
  const storedObjects = new FilesystemObjectStore({
    rootDirectory: join(directory, 'objects'),
    maxObjectBytes: 4_096,
  })
  let loseReceipt = true
  let physicalCreates = 0
  let artifactState = 'normal'
  const objectStore = new Proxy(storedObjects, {
    get(target, property) {
      if (property === 'putIfAbsent')
        return async (input) => {
          const result = await target.putIfAbsent(input)
          if (result.outcome === 'created') physicalCreates += 1
          if (loseReceipt) {
            loseReceipt = false
            throw new Error('lost object-store response')
          }
          return result
        }
      if (property === 'get')
        return async (key) => {
          if (artifactState === 'missing') throw new Error('artifact not found')
          const object = await target.get(key)
          if (artifactState !== 'corrupt') return object
          const body = Uint8Array.from(object.body)
          body[0] = body[0] ^ 0xff
          return { ...object, body }
        }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const operations = new LocalGraphToolOperations({
    api: fixture.api,
    persistence: fixture.persistence,
    objectStore,
    prices: [
      {
        pin: fixture.operation.toolPin,
        currency: fixture.plan.constraints.limits.budget.currency,
        costMicrounits: 25,
      },
    ],
    now: () => fixture.at,
  })
  const graphRuntime = new ManagedLocalGraphRuntime(
    fixture.persistence,
    {
      capabilities: ['graph.tool-pins.v1'],
      compiler: {
        operationAllowlist: [{ kind: 'tool', name: 'store' }],
        schemaRegistry: {
          getValidator(reference) {
            if (reference === 'schema:json')
              return (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
            if (reference === 'local.graph-json-object.v1')
              return (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
            if (reference === 'local.graph-state.v1')
              return (value) => value !== null && typeof value === 'object'
            return undefined
          },
        },
        maximumSteps: 8,
      },
      operations,
    },
    objectStore
  )
  const calls = new SqliteToolCallRepository(fixture.persistence, fixture.operation.workspaceId)
  try {
    const activity = graphRuntime.activities(fixture.api)
    const request = {
      executionId: fixture.operation.executionId,
      attemptId: fixture.operation.attemptId,
      workspaceId: fixture.operation.workspaceId,
      workflowId: fixture.operation.workflowId,
      graph: fixture.graph.reference,
      threadId: fixture.operation.threadId,
      input: fixture.plan.graph.input,
      idempotencyKey: 'recovery-test:original-run',
    }
    const paused = await activity.runGraphSegment(request)
    expect(paused.outcome).toBe('awaiting_input')
    const resume = {
      ...request,
      checkpointId: paused.checkpointId,
      response: { action: 'approve' },
      idempotencyKey: 'recovery-test:untrusted-wakeup',
    }
    delete resume.input
    expect((await activity.resumeGraphSegment(resume)).outcome).toBe('awaiting_input')
    const interaction = await fixture.api.interactions.get(paused.interactionId)
    await new InteractionService(fixture.api.interactions).respond({
      interactionId: interaction.interactionId,
      executionId: request.executionId,
      attemptId: request.attemptId,
      expectedVersion: interaction.version,
      responseId: 'cmd_01JABCDEF0123456789ABCDEFM',
      respondingPrincipalId: 'svc_graph-tool-test',
      action: 'approve',
      respondedAt: fixture.at,
    })
    const result = await activity.resumeGraphSegment({
      ...resume,
      idempotencyKey: 'recovery-test:approved-wakeup',
    })
    expect(result.outcome).toBe('reconciliation_required')
    expect(result.checkpointId).toEqual(expect.any(String))

    let call = (await calls.listByExecution(fixture.operation.executionId))[0]
    expect(call).toMatchObject({ status: 'reconciliation_required' })
    const summary = await new DurableUsageLedger({
      store: new SqliteDurableUsageStore(fixture.persistence),
    }).summary(fixture.operation.workspaceId, fixture.operation.executionId)
    expect(summary).toMatchObject({ reservedMicrounits: 25, spentMicrounits: 0 })

    const lifecycle = new ExecutionLifecycleService(fixture.api.executions)
    const execution = await fixture.api.executions.getExecution(fixture.operation.executionId)
    const attempt = await fixture.api.executions.getAttempt(fixture.operation.attemptId)
    await lifecycle.transitionExecution({
      executionId: execution.executionId,
      expectedVersion: execution.version,
      to: 'reconciliation_required',
      transitionedAt: fixture.at,
    })
    await lifecycle.transitionAttempt({
      attemptId: attempt.attemptId,
      expectedVersion: attempt.version,
      to: 'reconciliation_required',
      transitionedAt: fixture.at,
    })
    const workflowJobs = new WorkflowJobStore(fixture.persistence, {
      beforeEnqueue: assertSqliteWorkflowExecutionReference,
    })
    const workflowDispatcher = new EmbeddedExecutionWorkflowDispatcher({
      store: workflowJobs,
      now: () => fixture.at,
    })
    fixture.api.executionCancellationService = new DurableExecutionCancellationService(
      new SqliteExecutionCancellationRepository(fixture.persistence),
      fixture.api.commandRepository,
      workflowDispatcher,
      () => fixture.at
    )
    operations.bindRecoveryRuntime({
      workflowJobs,
      workflowDispatcher,
      durableExecution: 'embedded-sqlite',
      executionLifecycleActivities: { persistStatus: async () => undefined },
    })

    const inspectEnvelope = {
      caller: { servicePrincipalId: 'svc_graph-tool-test' },
      operation: 'execution.tool-effect.inspect',
      workspaceId: fixture.operation.workspaceId,
      projectId: fixture.plan.correlation.projectId,
      parameters: {
        executionId: fixture.operation.executionId,
        toolCallId: call.toolCallId,
      },
    }
    const principal = {
      principalId: 'svc_graph-tool-test',
      workspaceIds: [fixture.operation.workspaceId],
      projectIds: [fixture.plan.correlation.projectId],
      scopes: ['execution:reconcile'],
      kind: 'internal_service',
    }
    let payload = {
      executionId: fixture.operation.executionId,
      toolCallId: call.toolCallId,
      expectedRevision: call.revision,
      action: 'resume',
    }
    let command = {
      contractVersion: { major: 3, minor: 0 },
      requestId: fixture.plan.correlation.requestId,
      correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
      operation: 'execution.tool-effect.reconcile',
      workspaceId: fixture.operation.workspaceId,
      projectId: fixture.plan.correlation.projectId,
      caller: { servicePrincipalId: 'svc_graph-tool-test' },
      commandId: 'cmd_01JABCDEF0123456789ABCDEFM',
      idempotencyKey: 'recovery-resume-command-0001',
      payloadHash: createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex'),
      payload,
    }
    await expect(
      operations.inspect(
        { ...inspectEnvelope, projectId: 'prj_01JABCDEF0123456789ABCDEFX' },
        principal
      )
    ).rejects.toThrow('TOOL_EFFECT_SCOPE_REJECTED')
    await expect(
      operations.inspect(inspectEnvelope, { ...principal, principalId: 'svc_intruder' })
    ).rejects.toThrow('TOOL_EFFECT_SCOPE_REJECTED')
    artifactState = 'missing'
    expect(await operations.inspect(inspectEnvelope, principal)).toMatchObject({
      calls: [{ artifact: { state: 'missing' } }],
    })
    expect(await operations.reconcile(command, principal)).toMatchObject({
      outcome: 'held',
      reason: 'missing',
    })
    artifactState = 'corrupt'
    expect(await operations.inspect(inspectEnvelope, principal)).toMatchObject({
      calls: [{ artifact: { state: 'conflict' } }],
    })
    expect(await operations.reconcile(command, principal)).toMatchObject({
      outcome: 'held',
      reason: 'conflict',
    })
    const heldSummary = await new DurableUsageLedger({
      store: new SqliteDurableUsageStore(fixture.persistence),
    }).summary(fixture.operation.workspaceId, fixture.operation.executionId)
    expect(heldSummary).toMatchObject({ reservedMicrounits: 25, spentMicrounits: 0 })
    artifactState = 'normal'
    const changedDigest = {
      ...call,
      revision: call.revision + 1,
      inputDigest: `sha256:${'0'.repeat(64)}`,
    }
    await overwriteStoredCall(fixture.persistence, call.workspaceId, changedDigest)
    expect(await operations.inspect(inspectEnvelope, principal)).toMatchObject({
      calls: [{ artifact: { state: 'unverifiable' } }],
    })
    const changedPin = {
      ...changedDigest,
      revision: changedDigest.revision + 1,
      toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFM',
    }
    await overwriteStoredCall(fixture.persistence, call.workspaceId, changedPin)
    expect(await operations.inspect(inspectEnvelope, principal)).toMatchObject({
      calls: [{ artifact: { state: 'unverifiable' } }],
    })
    const restoredCall = {
      ...changedPin,
      revision: changedPin.revision + 1,
      inputDigest: call.inputDigest,
      toolVersionId: call.toolVersionId,
    }
    await overwriteStoredCall(fixture.persistence, call.workspaceId, restoredCall)
    call = await calls.get(call.toolCallId)
    for (let index = 0; index < 64; index += 1) {
      expect(await calls.insert(noEffectCallFrom(call, index))).toBe(true)
    }
    expect(
      (await calls.listByExecution(fixture.operation.executionId)).findIndex(
        (candidate) => candidate.toolCallId === call.toolCallId
      )
    ).toBe(64)
    const foreignExecutionCall = noEffectCallFrom(call, 64, 'exe_01JABCDEF0123456789ABCDEFH')
    expect(await calls.insert(foreignExecutionCall)).toBe(true)
    await expect(
      operations.inspect(
        {
          ...inspectEnvelope,
          parameters: {
            executionId: fixture.operation.executionId,
            toolCallId: foreignExecutionCall.toolCallId,
          },
        },
        principal
      )
    ).rejects.toThrow('TOOL_EFFECT_CALL_MISSING')
    const orphanRecoveryKey = `${fixture.operation.executionId}:graph-recovery:legacy-orphan-recovery`
    const orphanExecution = await fixture.api.executions.getExecution(fixture.operation.executionId)
    await workflowJobs.enqueue({
      workflowKey: orphanRecoveryKey,
      input: {
        executionId: orphanExecution.executionId,
        workflowId: `wfl_${orphanExecution.executionId.slice(4)}`,
        executionPlan: orphanExecution.executionPlan,
        deadlineAt: new Date(Date.parse(fixture.at) + 60_000).toISOString(),
        ...(orphanExecution.marketplacePluginReferences === undefined
          ? {}
          : { marketplacePluginReferences: orphanExecution.marketplacePluginReferences }),
        graph: {
          workspaceId: fixture.operation.workspaceId,
          reference: fixture.plan.graph.reference,
          threadId: `graph:${orphanExecution.executionId}`,
          input: fixture.plan.graph.input,
        },
      },
      recovery: {
        recoveryId: 'legacy-orphan-recovery',
        checkpointId: result.checkpointId,
      },
      at: fixture.at,
    })
    expect(await operations.inspect(inspectEnvelope, principal)).toMatchObject({
      calls: [{ artifact: { state: 'unverifiable' } }],
    })
    await workflowJobs.provider.transaction((transaction) =>
      transaction.delete(
        'workflow-jobs',
        `r-${createHash('sha256').update(orphanRecoveryKey).digest('hex')}`
      )
    )
    payload = { ...payload, expectedRevision: call.revision }
    command = {
      ...command,
      payload,
      payloadHash: createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex'),
    }
    const inspection = await operations.inspect(inspectEnvelope, principal)
    expect(inspection).toMatchObject({
      executionId: fixture.operation.executionId,
      calls: [
        {
          toolCallId: call.toolCallId,
          revision: call.revision,
          status: 'reconciliation_required',
          artifact: { state: 'verified' },
          accounting: { charged: false, settled: false },
        },
      ],
    })
    expect(JSON.stringify(inspection)).not.toContain('execute')
    expect(physicalCreates).toBe(1)

    const scheduled = await operations.reconcile(command, principal)
    expect(scheduled).toMatchObject({ outcome: 'recovery_scheduled' })
    const workflowKey = scheduled.workflowKey
    const recoveryJob = await workflowJobs.get(workflowKey)
    expect(recoveryJob).toMatchObject({
      workflowKey,
      recovery: { checkpointId: result.checkpointId },
      status: 'queued',
    })
    const afterRecovery = await calls.get(call.toolCallId)
    expect(afterRecovery).toMatchObject({ status: 'succeeded', revision: call.revision + 1 })
    const repairedSummary = await new DurableUsageLedger({
      store: new SqliteDurableUsageStore(fixture.persistence),
    }).summary(fixture.operation.workspaceId, fixture.operation.executionId)
    expect(repairedSummary).toMatchObject({ reservedMicrounits: 0, spentMicrounits: 25 })
    payload = { ...payload, expectedRevision: afterRecovery.revision }
    command = {
      ...command,
      payload,
      payloadHash: createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex'),
    }
    expect(await operations.reconcile(command, principal)).toMatchObject({
      outcome: 'held',
      reason: 'unverifiable',
    })
    const replayWithNewCommand = {
      ...command,
      commandId: 'cmd_01JABCDEF0123456789ABCDEFN',
      idempotencyKey: 'recovery-resume-command-0002',
    }
    expect(await operations.reconcile(replayWithNewCommand, principal)).toMatchObject({
      outcome: 'held',
      reason: 'unverifiable',
    })
    expect(await workflowJobs.get(workflowKey)).toMatchObject({ status: 'queued', attempt: 0 })
    expect((await calls.get(call.toolCallId)).revision).toBe(afterRecovery.revision)
    expect(physicalCreates).toBe(1)

    const cancelPayload = { ...payload, action: 'cancel' }
    const cancelled = await operations.reconcile(
      {
        ...command,
        commandId: 'cmd_01JABCDEF0123456789ABCDEFR',
        idempotencyKey: 'recovery-cancel-command-0001',
        payloadHash: createHash('sha256')
          .update(canonicalJsonStringify(cancelPayload))
          .digest('hex'),
        payload: cancelPayload,
      },
      principal
    )
    expect(cancelled).toMatchObject({
      outcome: 'cancelled',
      executionId: fixture.operation.executionId,
    })
    expect(await workflowJobs.getCancellation(fixture.operation.executionId)).toMatchObject({
      commandId: 'cmd_01JABCDEF0123456789ABCDEFR',
    })
    const afterCancellation = await operations.reconcile(
      {
        ...command,
        commandId: 'cmd_01JABCDEF0123456789ABCDEFQ',
        idempotencyKey: 'recovery-resume-command-0003',
      },
      principal
    )
    expect(afterCancellation).toMatchObject({ outcome: 'held', reason: 'unverifiable' })
    expect((await workflowJobs.get(workflowKey)).status).toBe('queued')
    expect(physicalCreates).toBe(1)
  } finally {
    storedObjects.close()
    await fixture.cleanup()
    await rm(directory, { recursive: true, force: true })
  }
})

test('cancellation stays held while the immutable write outcome is unknown', async () => {
  const fixture = await createLocalGraphToolFixture()
  const storedObjects = new FilesystemObjectStore({
    rootDirectory: join(fixture.directory, 'cancel-objects'),
    maxObjectBytes: 4_096,
  })
  let writes = 0
  const objectStore = new Proxy(storedObjects, {
    get(target, property) {
      if (property === 'putIfAbsent')
        return async (input) => {
          await target.putIfAbsent(input)
          writes += 1
          throw new Error('lost write receipt')
        }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const operations = new LocalGraphToolOperations({
    api: fixture.api,
    persistence: fixture.persistence,
    objectStore,
    prices: [{ pin: fixture.operation.toolPin, currency: 'USD', costMicrounits: 25 }],
    now: () => fixture.at,
  })
  try {
    await expect(operations.invoke(fixture.operation)).rejects.toMatchObject({
      interaction: { kind: 'approval' },
    })
    const calls = new SqliteToolCallRepository(fixture.persistence, fixture.operation.workspaceId)
    const pending = (await calls.listByExecution(fixture.operation.executionId))[0]
    const interaction = await fixture.api.interactions.get(pending.approvalInteractionId)
    await new InteractionService(fixture.api.interactions).respond({
      interactionId: interaction.interactionId,
      executionId: fixture.operation.executionId,
      attemptId: fixture.operation.attemptId,
      expectedVersion: interaction.version,
      responseId: 'cmd_01JABCDEF0123456789ABCDEFV',
      respondingPrincipalId: 'svc_graph-tool-test',
      action: 'approve',
      respondedAt: fixture.at,
    })
    await expect(operations.invoke(fixture.operation)).rejects.toBeInstanceOf(
      GraphNodeEffectUnconfirmedError
    )
    expect(writes).toBe(1)
    expect(
      await operations.cancel(
        fixture.operation.executionId,
        fixture.operation.threadId,
        'graph-cancel-recovery-0001'
      )
    ).toBe(false)
    expect((await calls.get(pending.toolCallId)).status).toBe('reconciliation_required')
    const summary = await new DurableUsageLedger({
      store: new SqliteDurableUsageStore(fixture.persistence),
    }).summary(fixture.operation.workspaceId, fixture.operation.executionId)
    expect(summary).toMatchObject({ reservedMicrounits: 25, spentMicrounits: 0 })
  } finally {
    storedObjects.close()
    await fixture.cleanup()
  }
})

test('recovers a lost receipt at the later of two graph nodes sharing one tool pin', async () => {
  const fixture = await createLocalGraphToolFixture({ sharedPinNodes: true, approvalMode: 'never' })
  const directory = await mkdtemp(join(tmpdir(), 'local-graph-tool-shared-pin-recovery-'))
  const storedObjects = new FilesystemObjectStore({
    rootDirectory: join(directory, 'objects'),
    maxObjectBytes: 4_096,
  })
  let physicalCreates = 0
  let lostSecondReceipt = false
  const objectStore = new Proxy(storedObjects, {
    get(target, property) {
      if (property === 'putIfAbsent')
        return async (input) => {
          const result = await target.putIfAbsent(input)
          if (result.outcome === 'created') physicalCreates += 1
          if (physicalCreates === 2 && !lostSecondReceipt) {
            lostSecondReceipt = true
            throw new Error('lost later-node write response')
          }
          return result
        }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const operations = new LocalGraphToolOperations({
    api: fixture.api,
    persistence: fixture.persistence,
    objectStore,
    prices: [
      {
        pin: fixture.operation.toolPin,
        currency: fixture.plan.constraints.limits.budget.currency,
        costMicrounits: 25,
      },
    ],
    now: () => fixture.at,
  })
  const graphRuntime = new ManagedLocalGraphRuntime(
    fixture.persistence,
    {
      capabilities: ['graph.tool-pins.v1'],
      compiler: {
        operationAllowlist: [{ kind: 'tool', name: 'store' }],
        schemaRegistry: {
          getValidator(reference) {
            if (reference === 'schema:json' || reference === 'local.graph-json-object.v1')
              return (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
            if (reference === 'local.graph-state.v1')
              return (value) => value !== null && typeof value === 'object'
            return undefined
          },
        },
        maximumSteps: 8,
      },
      operations,
    },
    objectStore
  )
  const calls = new SqliteToolCallRepository(fixture.persistence, fixture.operation.workspaceId)
  try {
    const result = await graphRuntime.activities(fixture.api).runGraphSegment({
      executionId: fixture.operation.executionId,
      attemptId: fixture.operation.attemptId,
      workspaceId: fixture.operation.workspaceId,
      workflowId: fixture.operation.workflowId,
      graph: fixture.graph.reference,
      threadId: fixture.operation.threadId,
      input: fixture.plan.graph.input,
      idempotencyKey: 'shared-pin-recovery:original-run',
    })
    expect(result.outcome).toBe('reconciliation_required')
    expect(physicalCreates).toBe(2)
    const callList = await calls.listByExecution(fixture.operation.executionId)
    expect(callList).toHaveLength(2)
    expect(callList.filter((call) => call.status === 'succeeded')).toHaveLength(1)
    const uncertainCall = callList.find((call) => call.status === 'reconciliation_required')
    expect(uncertainCall).toMatchObject({ operation: 'store-json' })

    const lifecycle = new ExecutionLifecycleService(fixture.api.executions)
    const execution = await fixture.api.executions.getExecution(fixture.operation.executionId)
    const attempt = await fixture.api.executions.getAttempt(fixture.operation.attemptId)
    await lifecycle.transitionExecution({
      executionId: execution.executionId,
      expectedVersion: execution.version,
      to: 'reconciliation_required',
      transitionedAt: fixture.at,
    })
    await lifecycle.transitionAttempt({
      attemptId: attempt.attemptId,
      expectedVersion: attempt.version,
      to: 'reconciliation_required',
      transitionedAt: fixture.at,
    })
    const workflowJobs = new WorkflowJobStore(fixture.persistence, {
      beforeEnqueue: assertSqliteWorkflowExecutionReference,
    })
    const workflowDispatcher = new EmbeddedExecutionWorkflowDispatcher({
      store: workflowJobs,
      now: () => fixture.at,
    })
    operations.bindRecoveryRuntime({
      workflowJobs,
      workflowDispatcher,
      durableExecution: 'embedded-sqlite',
      executionLifecycleActivities: { persistStatus: async () => undefined },
    })
    const principal = {
      principalId: 'svc_graph-tool-test',
      workspaceIds: [fixture.operation.workspaceId],
      projectIds: [fixture.plan.correlation.projectId],
      scopes: ['execution:reconcile'],
      kind: 'internal_service',
    }
    const inspectionEnvelope = {
      caller: { servicePrincipalId: principal.principalId },
      operation: 'execution.tool-effect.inspect',
      workspaceId: fixture.operation.workspaceId,
      projectId: fixture.plan.correlation.projectId,
      parameters: {
        executionId: fixture.operation.executionId,
        toolCallId: uncertainCall.toolCallId,
      },
    }
    expect(await operations.inspect(inspectionEnvelope, principal)).toMatchObject({
      calls: [
        {
          toolCallId: uncertainCall.toolCallId,
          artifact: { state: 'verified' },
          accounting: { charged: false, settled: false },
        },
      ],
    })
    const payload = {
      executionId: fixture.operation.executionId,
      toolCallId: uncertainCall.toolCallId,
      expectedRevision: uncertainCall.revision,
      action: 'resume',
    }
    const scheduled = await operations.reconcile(
      {
        operation: 'execution.tool-effect.reconcile',
        workspaceId: fixture.operation.workspaceId,
        projectId: fixture.plan.correlation.projectId,
        caller: { servicePrincipalId: principal.principalId },
        commandId: 'cmd_01JABCDEF0123456789ABCDEFR',
        idempotencyKey: 'shared-pin-recovery-command-01',
        payloadHash: createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex'),
        payload,
      },
      principal
    )
    expect(scheduled).toMatchObject({ outcome: 'recovery_scheduled' })
    expect((await calls.get(uncertainCall.toolCallId)).status).toBe('succeeded')
    expect(
      await new DurableUsageLedger({
        store: new SqliteDurableUsageStore(fixture.persistence),
      }).summary(fixture.operation.workspaceId, fixture.operation.executionId)
    ).toMatchObject({ reservedMicrounits: 0, spentMicrounits: 50 })
    expect(physicalCreates).toBe(2)
  } finally {
    storedObjects.close()
    await fixture.cleanup()
    await rm(directory, { recursive: true, force: true })
  }
})

test('recovers a lost receipt after approved resumes advance beyond the per-run step limit', async () => {
  const toolNodeCount = 10
  const fixture = await createLocalGraphToolFixture({ toolNodeCount })
  const directory = await mkdtemp(join(tmpdir(), 'local-graph-tool-late-step-recovery-'))
  const storedObjects = new FilesystemObjectStore({
    rootDirectory: join(directory, 'objects'),
    maxObjectBytes: 4_096,
  })
  let physicalCreates = 0
  let lostReceipt = false
  const objectStore = new Proxy(storedObjects, {
    get(target, property) {
      if (property === 'putIfAbsent')
        return async (input) => {
          const result = await target.putIfAbsent(input)
          if (result.outcome === 'created') physicalCreates += 1
          if (physicalCreates === toolNodeCount && !lostReceipt) {
            lostReceipt = true
            throw new Error('lost late-step write response')
          }
          return result
        }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const operations = new LocalGraphToolOperations({
    api: fixture.api,
    persistence: fixture.persistence,
    objectStore,
    prices: [
      {
        pin: fixture.operation.toolPin,
        currency: fixture.plan.constraints.limits.budget.currency,
        costMicrounits: 25,
      },
    ],
    now: () => fixture.at,
  })
  const graphRuntime = new ManagedLocalGraphRuntime(
    fixture.persistence,
    {
      capabilities: ['graph.tool-pins.v1'],
      compiler: {
        operationAllowlist: [{ kind: 'tool', name: 'store' }],
        schemaRegistry: {
          getValidator(reference) {
            if (reference === 'schema:json' || reference === 'local.graph-json-object.v1')
              return (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
            if (reference === 'local.graph-state.v1')
              return (value) => value !== null && typeof value === 'object'
            return undefined
          },
        },
        maximumSteps: 8,
      },
      operations,
    },
    objectStore
  )
  const calls = new SqliteToolCallRepository(fixture.persistence, fixture.operation.workspaceId)
  try {
    const activity = graphRuntime.activities(fixture.api)
    const request = {
      executionId: fixture.operation.executionId,
      attemptId: fixture.operation.attemptId,
      workspaceId: fixture.operation.workspaceId,
      workflowId: fixture.operation.workflowId,
      graph: fixture.graph.reference,
      threadId: fixture.operation.threadId,
      input: fixture.plan.graph.input,
      idempotencyKey: 'late-step-recovery:original-run',
    }
    let outcome = await activity.runGraphSegment(request)
    let approvalCount = 0
    while (outcome.outcome === 'awaiting_input' && approvalCount < toolNodeCount) {
      const interaction = await fixture.api.interactions.get(outcome.interactionId)
      expect(interaction?.state).toBe('pending')
      const responseSuffix = 'ABCDEFGHJKMNPRTVWXYZ'[approvalCount]
      const responseId = `cmd_01JABCDEF0123456789ABCDEF${responseSuffix}`
      await new InteractionService(fixture.api.interactions).respond({
        interactionId: interaction.interactionId,
        executionId: fixture.operation.executionId,
        attemptId: fixture.operation.attemptId,
        expectedVersion: interaction.version,
        responseId,
        respondingPrincipalId: 'svc_graph-tool-test',
        action: 'approve',
        respondedAt: fixture.at,
      })
      const resume = {
        ...request,
        checkpointId: outcome.checkpointId,
        response: { action: 'approve', responseId },
        idempotencyKey: `late-step-recovery:approved:${approvalCount}`,
      }
      delete resume.input
      outcome = await activity.resumeGraphSegment(resume)
      approvalCount += 1
    }
    expect(approvalCount).toBe(toolNodeCount)
    expect(outcome.outcome).toBe('reconciliation_required')
    expect(physicalCreates).toBe(toolNodeCount)
    const callList = await calls.listByExecution(fixture.operation.executionId)
    expect(callList).toHaveLength(toolNodeCount)
    expect(callList.filter((call) => call.status === 'succeeded')).toHaveLength(toolNodeCount - 1)
    const uncertainCall = callList.find((call) => call.status === 'reconciliation_required')
    expect(uncertainCall).toMatchObject({ operation: 'store-json' })

    const checkpoint = await new LangGraphSqliteCheckpointSaver(
      fixture.persistence,
      'managed-graphs'
    ).getTuple({
      configurable: {
        thread_id: `${fixture.operation.workspaceId}:${fixture.operation.executionId}:${fixture.operation.threadId}`,
        checkpoint_id: outcome.checkpointId,
      },
    })
    expect(checkpoint?.metadata?.step).toBeGreaterThan(8)

    const lifecycle = new ExecutionLifecycleService(fixture.api.executions)
    const execution = await fixture.api.executions.getExecution(fixture.operation.executionId)
    const attempt = await fixture.api.executions.getAttempt(fixture.operation.attemptId)
    await lifecycle.transitionExecution({
      executionId: execution.executionId,
      expectedVersion: execution.version,
      to: 'reconciliation_required',
      transitionedAt: fixture.at,
    })
    await lifecycle.transitionAttempt({
      attemptId: attempt.attemptId,
      expectedVersion: attempt.version,
      to: 'reconciliation_required',
      transitionedAt: fixture.at,
    })
    const workflowJobs = new WorkflowJobStore(fixture.persistence, {
      beforeEnqueue: assertSqliteWorkflowExecutionReference,
    })
    const workflowDispatcher = new EmbeddedExecutionWorkflowDispatcher({
      store: workflowJobs,
      now: () => fixture.at,
    })
    operations.bindRecoveryRuntime({
      workflowJobs,
      workflowDispatcher,
      durableExecution: 'embedded-sqlite',
      executionLifecycleActivities: { persistStatus: async () => undefined },
    })
    const principal = {
      principalId: 'svc_graph-tool-test',
      workspaceIds: [fixture.operation.workspaceId],
      projectIds: [fixture.plan.correlation.projectId],
      scopes: ['execution:reconcile'],
      kind: 'internal_service',
    }
    const inspectionEnvelope = {
      caller: { servicePrincipalId: principal.principalId },
      operation: 'execution.tool-effect.inspect',
      workspaceId: fixture.operation.workspaceId,
      projectId: fixture.plan.correlation.projectId,
      parameters: {
        executionId: fixture.operation.executionId,
        toolCallId: uncertainCall.toolCallId,
      },
    }
    expect(await operations.inspect(inspectionEnvelope, principal)).toMatchObject({
      calls: [
        {
          toolCallId: uncertainCall.toolCallId,
          artifact: { state: 'verified' },
          accounting: { charged: false, settled: false },
        },
      ],
    })
    const payload = {
      executionId: fixture.operation.executionId,
      toolCallId: uncertainCall.toolCallId,
      expectedRevision: uncertainCall.revision,
      action: 'resume',
    }
    const scheduled = await operations.reconcile(
      {
        operation: 'execution.tool-effect.reconcile',
        workspaceId: fixture.operation.workspaceId,
        projectId: fixture.plan.correlation.projectId,
        caller: { servicePrincipalId: principal.principalId },
        commandId: 'cmd_01JABCDEF0123456789ABCDEFZ',
        idempotencyKey: 'late-step-recovery:operator-resume',
        payloadHash: createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex'),
        payload,
      },
      principal
    )
    expect(scheduled).toMatchObject({ outcome: 'recovery_scheduled' })
    expect((await calls.get(uncertainCall.toolCallId)).status).toBe('succeeded')
    expect(
      await new DurableUsageLedger({
        store: new SqliteDurableUsageStore(fixture.persistence),
      }).summary(fixture.operation.workspaceId, fixture.operation.executionId)
    ).toMatchObject({ reservedMicrounits: 0, spentMicrounits: toolNodeCount * 25 })
    expect(physicalCreates).toBe(toolNodeCount)
  } finally {
    storedObjects.close()
    await fixture.cleanup()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test('follows successive embedded recovery jobs after two lost write receipts', async () => {
  const fixture = await createLocalGraphToolFixture({
    activate: false,
    sharedPinNodes: true,
    approvalMode: 'never',
  })
  const directory = await mkdtemp(join(tmpdir(), 'local-graph-tool-chained-recovery-'))
  const storedObjects = new FilesystemObjectStore({
    rootDirectory: join(directory, 'objects'),
    maxObjectBytes: 4_096,
  })
  let physicalCreates = 0
  const objectStore = new Proxy(storedObjects, {
    get(target, property) {
      if (property === 'putIfAbsent')
        return async (input) => {
          const result = await target.putIfAbsent(input)
          if (result.outcome === 'created') {
            physicalCreates += 1
            throw new Error(`lost write receipt ${physicalCreates}`)
          }
          return result
        }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const operations = new LocalGraphToolOperations({
    api: fixture.api,
    persistence: fixture.persistence,
    objectStore,
    prices: [
      {
        pin: fixture.operation.toolPin,
        currency: fixture.plan.constraints.limits.budget.currency,
        costMicrounits: 25,
      },
    ],
    now: () => fixture.at,
  })
  const graphRuntime = new ManagedLocalGraphRuntime(
    fixture.persistence,
    {
      capabilities: ['graph.tool-pins.v1'],
      compiler: {
        operationAllowlist: [{ kind: 'tool', name: 'store' }],
        schemaRegistry: {
          getValidator(reference) {
            if (reference === 'schema:json' || reference === 'local.graph-json-object.v1')
              return (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
            if (reference === 'local.graph-state.v1')
              return (value) => value !== null && typeof value === 'object'
            return undefined
          },
        },
        maximumSteps: 8,
      },
      operations,
    },
    objectStore
  )
  const calls = new SqliteToolCallRepository(fixture.persistence, fixture.operation.workspaceId)
  const workflowJobs = new WorkflowJobStore(fixture.persistence, {
    beforeEnqueue: assertSqliteWorkflowExecutionReference,
  })
  const workflowDispatcher = new EmbeddedExecutionWorkflowDispatcher({
    store: workflowJobs,
    now: () => fixture.at,
  })
  const graphActivities = graphRuntime.activities(fixture.api)
  const lifecycleActivities = new DurableExecutionLifecycleActivities({
    lifecycle: new ExecutionLifecycleService(fixture.api.executions),
    plans: fixture.api.executionPlans,
    runtime: {
      dispatch: async () => ({ outcome: 'completed' }),
      applyInteraction: async () => ({ outcome: 'completed' }),
      cancel: async () => undefined,
      cleanup: async () => undefined,
    },
    graph: graphActivities,
    commands: fixture.api.commands,
    now: () => fixture.at,
  })
  const embedded = new EmbeddedWorkflowRuntime({
    provider: fixture.persistence,
    activities: lifecycleActivities,
    owner: 'chained-local-graph-recovery-test',
    pollIntervalMs: 5,
    leaseMs: 2_000,
    retryDelayMs: 5,
    stopGraceMs: 1_000,
    now: () => fixture.at,
  })
  let recoveryWorker = embedded
  operations.bindRecoveryRuntime({
    workflowJobs,
    workflowDispatcher,
    durableExecution: 'embedded-sqlite',
    executionLifecycleActivities: lifecycleActivities,
  })
  fixture.api.executionCancellationService = new DurableExecutionCancellationService(
    new SqliteExecutionCancellationRepository(fixture.persistence),
    fixture.api.commandRepository,
    workflowDispatcher,
    () => fixture.at
  )
  const execution = await fixture.api.executions.getExecution(fixture.operation.executionId)
  const acceptedCommand = await fixture.api.commandRepository.getByExecutionId(
    fixture.operation.executionId
  )
  const authoritativeDeadline = Math.min(
    Date.parse(
      execution.deadlineAt ??
        new Date(
          Date.parse(execution.acceptedAt) + fixture.plan.constraints.limits.duration.maximumMs
        ).toISOString()
    ),
    Date.parse(acceptedCommand.retentionExpiresAt)
  )
  const workflowInput = {
    executionId: execution.executionId,
    workflowId: fixture.operation.workflowId,
    deadlineAt: new Date(authoritativeDeadline).toISOString(),
    executionPlan: execution.executionPlan,
    graph: {
      workspaceId: fixture.operation.workspaceId,
      threadId: fixture.operation.threadId,
      reference: fixture.graph.reference,
      input: fixture.plan.graph.input,
    },
  }
  const principal = {
    principalId: 'svc_graph-tool-test',
    workspaceIds: [fixture.operation.workspaceId],
    projectIds: [fixture.plan.correlation.projectId],
    scopes: ['execution:reconcile'],
    kind: 'internal_service',
  }
  const originalRunKey = `${workflowInput.workflowId}:execution-lifecycle-v1:graph:run`

  async function waitFor(predicate) {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const value = await predicate()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('LOCAL_GRAPH_CHAINED_RECOVERY_TIMEOUT')
  }

  async function waitForJob(workflowKey) {
    return await waitFor(async () => {
      const job = await workflowJobs.get(workflowKey)
      if (job?.status === 'failed')
        throw new Error(`LOCAL_GRAPH_CHAINED_RECOVERY_JOB_FAILED:${job.lastError?.message}`)
      return job?.status === 'succeeded' ? job : undefined
    })
  }

  async function recover(call, index) {
    const payload = {
      executionId: fixture.operation.executionId,
      toolCallId: call.toolCallId,
      expectedRevision: call.revision,
      action: 'resume',
    }
    return await operations.reconcile(
      {
        operation: 'execution.tool-effect.reconcile',
        workspaceId: fixture.operation.workspaceId,
        projectId: fixture.plan.correlation.projectId,
        caller: { servicePrincipalId: principal.principalId },
        commandId: `cmd_01JABCDEF0123456789ABCDE${index}`,
        idempotencyKey: `chained-recovery-operator-${index}`,
        payloadHash: createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex'),
        payload,
      },
      principal
    )
  }

  try {
    await embedded.start()
    await workflowDispatcher.submit(workflowInput)
    const original = await waitForJob(fixture.operation.executionId)
    expect(original.outcome.status).toBe('reconciliation_required')
    const originalJournal = await workflowJobs.getEffect(
      fixture.operation.executionId,
      originalRunKey
    )
    expect(physicalCreates).toBe(1)
    const firstCall = (await calls.listByExecution(fixture.operation.executionId))[0]
    expect(firstCall.status).toBe('reconciliation_required')
    await embedded.stop()
    const firstScheduled = await recover(firstCall, '1')
    expect(firstScheduled).toMatchObject({ outcome: 'recovery_scheduled' })
    const firstRecoveryKey = firstScheduled.workflowKey
    const firstRecoveryId = firstRecoveryKey.slice(
      `${fixture.operation.executionId}:graph-recovery:`.length
    )
    expect(
      await workflowJobs.enqueue({
        workflowKey: firstRecoveryKey,
        input: workflowInput,
        recovery: {
          recoveryId: firstRecoveryId,
          checkpointId: original.outcome.graphCheckpointId,
          parentWorkflowKey: fixture.operation.executionId,
        },
        at: fixture.at,
      })
    ).toMatchObject({ outcome: 'duplicate' })
    expect(await workflowJobs.get(firstRecoveryKey)).toMatchObject({ status: 'queued', attempt: 0 })
    const firstCallAfterAccounting = await calls.get(firstCall.toolCallId)
    expect(firstCallAfterAccounting.status).toBe('succeeded')
    expect(await recover(firstCallAfterAccounting, '4')).toMatchObject({
      outcome: 'held',
      reason: 'unverifiable',
    })
    expect(await workflowJobs.get(firstRecoveryKey)).toMatchObject({ status: 'queued', attempt: 0 })
    expect(physicalCreates).toBe(1)
    recoveryWorker = new EmbeddedWorkflowRuntime({
      provider: fixture.persistence,
      activities: lifecycleActivities,
      owner: 'chained-local-graph-recovery-restart-test',
      pollIntervalMs: 5,
      leaseMs: 2_000,
      retryDelayMs: 5,
      stopGraceMs: 1_000,
      now: () => fixture.at,
    })
    await recoveryWorker.start()
    const firstRecovery = await waitForJob(firstRecoveryKey)
    expect(firstRecovery.outcome.status).toBe('reconciliation_required')
    expect(await workflowJobs.getEffect(fixture.operation.executionId, originalRunKey)).toEqual(
      originalJournal
    )
    expect(
      await workflowJobs.getEffect(firstRecoveryKey, firstRecoveryEffectKey(firstRecovery))
    ).toBeDefined()
    expect(physicalCreates).toBe(2)

    const secondCall = (await calls.listByExecution(fixture.operation.executionId)).find(
      (call) => call.toolCallId !== firstCall.toolCallId
    )
    expect(secondCall?.status).toBe('reconciliation_required')
    const firstCallAfterRecovery = await calls.get(firstCall.toolCallId)
    const jobsBeforeHistoricalResume = await workflowJobs.getExecutionGraphJobsSnapshot(
      fixture.operation.executionId
    )
    expect(await recover(firstCallAfterRecovery, '3')).toMatchObject({
      outcome: 'held',
      reason: 'recovery_checkpoint_advanced',
    })
    expect(await workflowJobs.getExecutionGraphJobsSnapshot(fixture.operation.executionId)).toEqual(
      jobsBeforeHistoricalResume
    )
    const secondInspection = await operations.inspect(
      {
        operation: 'execution.tool-effect.inspect',
        workspaceId: fixture.operation.workspaceId,
        projectId: fixture.plan.correlation.projectId,
        caller: { servicePrincipalId: principal.principalId },
        parameters: {
          executionId: fixture.operation.executionId,
          toolCallId: secondCall.toolCallId,
        },
      },
      principal
    )
    expect(secondInspection).toMatchObject({
      calls: [{ toolCallId: secondCall.toolCallId, artifact: { state: 'verified' } }],
    })
    const secondScheduled = await recover(secondCall, '2')
    expect(secondScheduled).toMatchObject({ outcome: 'recovery_scheduled' })
    const secondRecoveryKey = secondScheduled.workflowKey
    const secondRecovery = await waitForJob(secondRecoveryKey)
    expect(secondRecovery.outcome.status).toBe('completed')
    expect(firstRecovery.outcome).toMatchObject({
      status: 'reconciliation_required',
      graphCheckpointId: firstRecovery.outcome.graphCheckpointId,
    })
    expect(await workflowJobs.getEffect(fixture.operation.executionId, originalRunKey)).toEqual(
      originalJournal
    )
    const historicInspection = await operations.inspect(
      {
        operation: 'execution.tool-effect.inspect',
        workspaceId: fixture.operation.workspaceId,
        projectId: fixture.plan.correlation.projectId,
        caller: { servicePrincipalId: principal.principalId },
        parameters: {
          executionId: fixture.operation.executionId,
          toolCallId: firstCall.toolCallId,
        },
      },
      principal
    )
    expect(historicInspection).toMatchObject({
      calls: [{ toolCallId: firstCall.toolCallId, artifact: { state: 'verified' } }],
    })
    expect(
      (await calls.listByExecution(fixture.operation.executionId)).map((call) => call.status)
    ).toEqual(['succeeded', 'succeeded'])
    const summary = await new DurableUsageLedger({
      store: new SqliteDurableUsageStore(fixture.persistence),
    }).summary(fixture.operation.workspaceId, fixture.operation.executionId)
    expect(summary).toMatchObject({ reservedMicrounits: 0, spentMicrounits: 50 })
    expect(physicalCreates).toBe(2)
  } finally {
    await recoveryWorker.stop()
    storedObjects.close()
    await fixture.cleanup()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

function firstRecoveryEffectKey(job) {
  return `${job.input.workflowId}:execution-lifecycle-v1:graph:recovery:${job.recovery.recoveryId}:${job.recovery.checkpointId}`
}
