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
  WorkflowJobStore,
} from '@control-plane/workflow-runtime'
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
    expect(await operations.reconcile(command, principal)).toMatchObject({
      outcome: 'recovery_scheduled',
    })
    const replayWithNewCommand = {
      ...command,
      commandId: 'cmd_01JABCDEF0123456789ABCDEFN',
      idempotencyKey: 'recovery-resume-command-0002',
    }
    expect(await operations.reconcile(replayWithNewCommand, principal)).toMatchObject({
      outcome: 'recovery_scheduled',
      workflowKey,
    })
    expect((await workflowJobs.get(workflowKey)).attempt).toBe(0)
    expect((await calls.get(call.toolCallId)).revision).toBe(call.revision + 1)
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
    expect(afterCancellation).toMatchObject({ outcome: 'accounted_awaiting_cancel' })
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
