import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import {
  RuntimeAdapterError,
  RuntimeStartRequestSchema,
  RuntimeExecutionStatusSchema,
  RuntimeExecutionProgressSchema,
  RuntimeUsageSchema,
  RuntimeAdapterInspectionSchema,
  RuntimeInputRequestSchema,
  RuntimeApprovalRequestSchema,
  RuntimeCancelRequestSchema,
  RuntimeSessionOperationSchema,
  RuntimeSessionResultSchema,
  RuntimeExecutionHandleSchema,
  inspectRuntimeCapabilities,
  type RuntimeAdapter,
  type RuntimeExecutionHandle,
  type RuntimeExecutionStatus,
} from '@control-plane/runtime-sdk'
import {
  PiDurableAdmissionSchema,
  PiDurableVersion,
  ProviderBindingSchema,
  type DurableExecutionAuthority,
  type DurablePiEngine,
  type PiDurableRuntimeOptions,
} from './contracts.js'
import { SqliteDurableJournal, type JournalRecord } from './journal.js'
import { createPiDurableEngine } from './pi-engine.js'
import { NodeSessionLease } from './lease.js'

interface StoredAdmission extends DurableExecutionAuthority {
  readonly version: typeof PiDurableVersion
  readonly handle: RuntimeExecutionHandle
  readonly providerDigest: string
}

export class PiDurableRuntimeAdapter implements RuntimeAdapter {
  readonly journal: SqliteDurableJournal
  readonly #options: PiDurableRuntimeOptions
  readonly #active = new Map<string, Promise<void>>()
  readonly #engines = new Map<string, DurablePiEngine>()
  readonly #now: () => string
  #closed = false
  #closing = false
  #closePromise?: Promise<void>

  constructor(options: PiDurableRuntimeOptions) {
    this.#options = options
    this.#now = options.now ?? (() => new Date().toISOString())
    this.journal = new SqliteDurableJournal(join(options.directory, 'authority.sqlite'))
  }

  async inspect(requirements?: Parameters<RuntimeAdapter['inspect']>[0]) {
    const capabilities = [
      'stream.output',
      'stream.events',
      'interaction.user-input',
      'interaction.approval',
      'execution.cancel',
      'session.create',
      'session.list',
      'session.load',
      'session.resume',
      'session.close',
      'session.history',
      'model.select',
    ].map((name) => ({ name, support: 'supported' as const }))
    const parsed = RuntimeAdapterInspectionSchema.parse({
      metadata: {
        contractVersion: { major: 1, minor: 0 },
        adapterName: 'pi-durable',
        adapterVersion: PiDurableVersion.adapter,
        runtimeFamily: 'pi',
        driverVersion: PiDurableVersion.adapter,
        harnessVersion: PiDurableVersion.runtime,
        transportKind: 'direct-local',
      },
      health: this.#closing || this.#closed ? 'unavailable' : 'healthy',
      capabilities,
      limitations: [
        'NODE_SQLITE_REMOTE_HOST_ONLY',
        'NATIVE_TOOLS_DISABLED',
        'CLOUD_PROFILE_UNQUALIFIED',
        'PAID_INFERENCE_RESTART_REQUIRES_RECONCILIATION',
        'PROGRESS_COMMITTED_SNAPSHOT_ONLY',
      ],
      observedAt: this.#now(),
    })
    return RuntimeAdapterInspectionSchema.parse({
      ...parsed,
      ...(requirements
        ? { capabilityEvaluation: inspectRuntimeCapabilities(parsed.capabilities, requirements) }
        : {}),
    })
  }

  async awaitInput(handle: RuntimeExecutionHandle, interactionId: string): Promise<void> {
    const record = this.#record(handle)
    if (record.detail['sessionClosed']) fail('PI_SESSION_CLOSED', 'conflict')
    if (this.#active.has(handle.handleId)) fail('PI_EXECUTION_BUSY', 'conflict')
    await this.#authority(this.#stored(record))
    this.#assertOpen()
    const parsed = RuntimeInputRequestSchema.parse({
      interactionId,
      idempotencyKey: 'validate',
      text: 'validate',
    })
    const epoch = this.#claim(record)
    this.journal.update(
      record.handleId,
      epoch,
      {
        state: 'awaiting_input',
        detail: {
          ...record.detail,
          result: undefined,
          observedAt: this.#now(),
          pendingInput: parsed.interactionId,
        },
      },
      { type: 'interaction', data: { interactionId, kind: 'input' }, at: this.#now() }
    )
  }

  async awaitApproval(
    handle: RuntimeExecutionHandle,
    interactionId: string,
    effectIdentity: string
  ): Promise<void> {
    const record = this.#record(handle)
    if (record.detail['sessionClosed']) fail('PI_SESSION_CLOSED', 'conflict')
    if (this.#active.has(handle.handleId)) fail('PI_EXECUTION_BUSY', 'conflict')
    await this.#authority(this.#stored(record))
    this.#assertOpen()
    RuntimeInputRequestSchema.parse({ interactionId, idempotencyKey: 'validate', text: 'validate' })
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(effectIdentity))
      fail('PI_EFFECT_IDENTITY_INVALID', 'validation')
    const epoch = this.#claim(record)
    this.journal.update(
      record.handleId,
      epoch,
      {
        state: 'awaiting_input',
        detail: {
          ...record.detail,
          result: undefined,
          pendingInput: undefined,
          pendingApproval: { interactionId, effectIdentity },
          observedAt: this.#now(),
        },
      },
      {
        type: 'interaction',
        data: { interactionId, kind: 'approval', effectIdentity },
        at: this.#now(),
      }
    )
  }

  async submitInput(
    handle: RuntimeExecutionHandle,
    input: Parameters<RuntimeAdapter['submitInput']>[1]
  ) {
    const request = RuntimeInputRequestSchema.parse(input)
    const record = this.#record(handle)
    if (record.detail['sessionClosed']) fail('PI_SESSION_CLOSED', 'conflict')
    await this.#authority(this.#stored(record))
    this.#assertOpen()
    const actions = record.detail['actions'] as Record<string, string> | undefined
    if (actions?.[request.idempotencyKey]) {
      if (actions[request.idempotencyKey] !== digest(request))
        fail('IDEMPOTENCY_CONFLICT', 'conflict')
      return this.status(handle)
    }
    if (
      record.state !== 'awaiting_input' ||
      record.detail['pendingInput'] !== request.interactionId
    )
      fail('PI_INPUT_NOT_PENDING', 'conflict')
    const epoch = this.#claim(record)
    const next = this.journal.update(
      record.handleId,
      epoch,
      {
        state: 'starting',
        detail: {
          observedAt: this.#now(),
          actions: { ...actions, [request.idempotencyKey]: digest(request) },
          turn: {
            requestId: `pi-input:${record.attemptId}:${request.idempotencyKey}`,
            input: request.text,
          },
        },
      },
      { type: 'status', data: { state: 'starting' }, at: this.#now() }
    )
    this.#schedule(next)
    return this.status(handle)
  }

  async submitApproval(
    handle: RuntimeExecutionHandle,
    input: Parameters<RuntimeAdapter['submitApproval']>[1]
  ) {
    const request = RuntimeApprovalRequestSchema.parse(input)
    const record = this.#record(handle)
    const authority = this.#stored(record)
    await this.#authority(authority)
    this.#assertOpen()
    const actions = record.detail['actions'] as Record<string, string> | undefined
    if (actions?.[request.idempotencyKey]) {
      if (actions[request.idempotencyKey] !== digest(request))
        fail('IDEMPOTENCY_CONFLICT', 'conflict')
      return this.status(handle)
    }
    const pending = record.detail['pendingApproval'] as
      | { interactionId: string; effectIdentity: string }
      | undefined
    if (pending?.interactionId !== request.interactionId)
      fail('PI_APPROVAL_NOT_PENDING', 'conflict')
    const verified = await this.#options.verifyApproval?.(
      authority,
      pending.effectIdentity,
      request
    )
    this.#assertOpen()
    if (!verified) fail('PI_APPROVAL_NOT_AUTHORITATIVE', 'conflict')
    await this.#authority(authority)
    this.#assertOpen()
    const epoch = this.#claim(record)
    this.journal.update(
      record.handleId,
      epoch,
      {
        detail: {
          ...record.detail,
          pendingApproval: undefined,
          actions: { ...actions, [request.idempotencyKey]: digest(request) },
          approvalAcknowledgement: {
            interactionId: request.interactionId,
            decision: request.decision,
          },
          observedAt: this.#now(),
        },
      },
      {
        type: 'interaction',
        data: {
          interactionId: request.interactionId,
          decision: request.decision,
          acknowledged: true,
        },
        at: this.#now(),
      }
    )
    return this.status(handle)
  }

  async cancel(handle: RuntimeExecutionHandle, input: Parameters<RuntimeAdapter['cancel']>[1]) {
    const request = RuntimeCancelRequestSchema.parse(input)
    const record = this.#record(handle)
    await this.#authority(this.#stored(record))
    this.#assertOpen()
    const key = `cancel:${request.idempotencyKey}`
    const actions = record.detail['actions'] as Record<string, string> | undefined
    if (actions?.[key]) {
      if (actions[key] !== digest(request)) fail('IDEMPOTENCY_CONFLICT', 'conflict')
      return this.status(handle)
    }
    if (record.state === 'completed') fail('PI_EXECUTION_TERMINAL', 'conflict')
    const active = this.#engines.get(handle.handleId)
    const epoch = this.#claim(record)
    const state = record.detail['inferencePending'] ? 'cancelling' : 'cancelled'
    this.journal.update(
      record.handleId,
      epoch,
      {
        state,
        detail: {
          ...record.detail,
          observedAt: this.#now(),
          actions: { ...actions, [key]: digest(request) },
        },
      },
      { type: 'status', data: { state }, at: this.#now() }
    )
    // Retain and fence cancellation before abort can complete, fail or crash.
    if (active) {
      try {
        await active.cancel(this.#stored(record).handle.externalSessionId!)
      } catch {
        /* The retained cancellation requires trusted reconciliation. */
      }
    }
    return this.status(handle)
  }

  async session(input: Parameters<RuntimeAdapter['session']>[0]) {
    this.#assertOpen()
    const operation = RuntimeSessionOperationSchema.parse(input)
    if (operation.operation === 'create') {
      const session = this.journal.sessionCreate(
        {
          sessionId: externalSession(digest(operation.idempotencyKey).slice(7, 39)),
          state: 'active',
          observedAt: this.#now(),
        },
        operation.idempotencyKey
      )
      return RuntimeSessionResultSchema.parse({ operation: 'create', session })
    }
    const records = this.journal.list()
    const sessions = [
      ...this.journal.sessions(),
      ...records.map((record) => ({
        sessionId: this.#stored(record).handle.externalSessionId!,
        state: record.detail['sessionClosed'] ? ('closed' as const) : ('active' as const),
        observedAt: record.detail['observedAt'] ?? record.at,
      })),
    ]
    if (operation.operation === 'list')
      return RuntimeSessionResultSchema.parse({ operation: 'list', sessions })
    const session = sessions.find((item) => item.sessionId === operation.sessionId)
    if (!session) fail('PI_SESSION_NOT_FOUND', 'validation')
    const record = records.find(
      (item) => this.#stored(item).handle.externalSessionId === operation.sessionId
    )
    if (operation.operation === 'history') {
      return RuntimeSessionResultSchema.parse({
        operation: 'history',
        session,
        completeness: 'partial',
        limitations: ['ADAPTER_JOURNAL_ONLY'],
        entries: record
          ? this.journal.events(record.handleId, operation.afterSequence ?? 0).map((event) => ({
              sequence: event['sequence'],
              occurredAt: event['occurredAt'],
              data: event['data'],
            }))
          : [],
      })
    }
    if (operation.operation === 'close') {
      if (record && !['completed', 'cancelled', 'failed', 'timed_out'].includes(record.state))
        fail('PI_SESSION_BUSY', 'conflict')
      session.state = 'closed'
      if (record)
        this.journal.update(record.handleId, record.epoch, {
          detail: { ...record.detail, sessionClosed: true },
        })
      else this.journal.sessionUpdate({ ...session, observedAt: String(session.observedAt) })
    }
    // Resume/load reacquire the existing session identity; paid work requires reconcile/start.
    return RuntimeSessionResultSchema.parse({ operation: operation.operation, session })
  }

  async cleanup(handle: RuntimeExecutionHandle): Promise<void> {
    const record = this.#record(handle)
    if (!['completed', 'cancelled', 'failed', 'timed_out'].includes(record.state))
      fail('PI_RECONCILIATION_REQUIRED', 'conflict')
    this.journal.update(record.handleId, record.epoch, {
      detail: { ...record.detail, sessionClosed: true, cleanupComplete: true },
    })
  }

  async start(input: Parameters<RuntimeAdapter['start']>[0]): Promise<RuntimeExecutionHandle> {
    this.#assertOpen()
    const request = RuntimeStartRequestSchema.parse(input)
    const plan = assertExecutionPlanIntegrity(request.executionPlan)
    if (!request.executionId || !request.attemptBudget)
      fail('PI_ATTEMPT_AUTHORITY_REQUIRED', 'validation')
    const inspection = await this.inspect(plan.runtimeRequirements)
    this.#assertOpen()
    if (
      !inspection.capabilityEvaluation?.eligible ||
      !plan.constraints.runtime.allowedFamilies.includes('pi') ||
      !plan.constraints.runtime.allowedLocations.includes('remote')
    )
      fail('PI_PLAN_RUNTIME_INELIGIBLE', 'unsupported')
    if (request.attemptBudget.maximumTokens < 1) fail('PI_ATTEMPT_BUDGET_EXHAUSTED', 'validation')
    let admission
    try {
      admission = PiDurableAdmissionSchema.parse(await this.#options.resolveAdmission(request))
    } catch {
      this.#assertOpen()
      fail('PI_ADMISSION_AUTHORITY_REJECTED', 'conflict')
    }
    this.#assertOpen()
    const authority = { request, admission }
    await this.#authority(authority)
    this.#assertOpen()
    const provider = await this.#provider(authority)
    this.#assertOpen()
    const id = digest([request.attemptBudget.workspaceId, request.attemptId]).slice(7, 39)
    const handle = RuntimeExecutionHandleSchema.parse({
      handleId: `pi-durable:${id}`,
      attemptId: request.attemptId,
      externalSessionId: externalSession(id),
      startedAt: this.#now(),
    })
    const previous = this.journal
      .list()
      .find(
        (record) =>
          record.startKey === `${request.attemptBudget?.workspaceId}:${request.idempotencyKey}`
      )
    if (previous) handle.startedAt = this.#stored(previous).handle.startedAt
    const stored: StoredAdmission = {
      version: PiDurableVersion,
      request,
      admission,
      handle,
      providerDigest: digest(provider.binding),
    }
    let record: JournalRecord
    try {
      record = this.journal.admit({
        handleId: handle.handleId,
        attemptId: handle.attemptId,
        startKey: `${request.attemptBudget.workspaceId}:${request.idempotencyKey}`,
        admission: stored,
        at: handle.startedAt,
      })
    } catch (error) {
      fail(error instanceof Error ? error.message : 'PI_ADMISSION_CONFLICT', 'conflict')
    }
    if (record.state === 'starting') this.#schedule(record)
    return this.#stored(record).handle
  }

  async status(handle: RuntimeExecutionHandle): Promise<RuntimeExecutionStatus> {
    const record = this.#record(handle)
    return RuntimeExecutionStatusSchema.parse({
      handle: this.#stored(record).handle,
      state: record.state,
      observedAt: record.detail['observedAt'] ?? record.at,
      ...(record.detail['result'] ? { result: record.detail['result'] } : {}),
    })
  }

  async *progress(
    handle: RuntimeExecutionHandle,
    options?: Parameters<RuntimeAdapter['progress']>[1]
  ) {
    this.#record(handle)
    for (const event of this.journal.events(handle.handleId, options?.afterSequence ?? 0)) {
      if (options?.signal?.aborted) return
      yield RuntimeExecutionProgressSchema.parse(event)
    }
  }

  async reconcile(handle: RuntimeExecutionHandle): Promise<RuntimeExecutionStatus> {
    const record = this.#record(handle)
    const authority = this.#stored(record)
    await this.#authority(authority)
    this.#assertOpen()
    if (!this.#active.has(handle.handleId) && record.state === 'cancelling') {
      const safe = await this.#options.reconcileInference(authority, turnKey(record))
      this.#assertOpen()
      const epoch = this.#claim(record)
      const state = safe === 'safe_to_resume' ? 'cancelled' : 'cancelling'
      this.journal.update(
        record.handleId,
        epoch,
        {
          state,
          detail: {
            ...record.detail,
            inferencePending: state === 'cancelling',
            observedAt: this.#now(),
            reasonCode:
              state === 'cancelling' ? 'PI_CANCELLATION_RECONCILIATION_REQUIRED' : undefined,
          },
        },
        { type: 'status', data: { state }, at: this.#now() }
      )
    } else if (
      !this.#active.has(handle.handleId) &&
      ['running', 'unknown'].includes(record.state)
    ) {
      const safe = await this.#options.reconcileInference(authority, turnKey(record))
      this.#assertOpen()
      if (safe === 'safe_to_resume') this.#schedule(record)
      else {
        const epoch = this.#claim(record)
        this.journal.update(record.handleId, epoch, {
          state: 'unknown',
          detail: {
            ...record.detail,
            observedAt: this.#now(),
            reasonCode: 'PI_INFERENCE_RECONCILIATION_REQUIRED',
          },
        })
      }
    } else if (record.state === 'starting') this.#schedule(record)
    return this.status(handle)
  }

  async drain(): Promise<void> {
    await Promise.all(this.#active.values())
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    // Fence admission before taking the active snapshot; admitted runs retain their authority.
    this.#closing = true
    this.#closePromise = (async () => {
      const work = await Promise.allSettled(this.#active.values())
      const engines = await Promise.allSettled(
        [...this.#engines.values()].map((engine) => Promise.resolve().then(() => engine.close()))
      )
      this.#engines.clear()
      this.#closed = true
      this.journal.close()
      const failure = [...work, ...engines].find((item) => item.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })()
    return this.#closePromise
  }

  #schedule(record: JournalRecord): void {
    this.#assertOpen()
    if (this.#active.has(record.handleId)) return
    const work = this.#run(record).finally(() => this.#active.delete(record.handleId))
    this.#active.set(record.handleId, work)
  }

  async #run(record: JournalRecord): Promise<void> {
    const authority = this.#stored(record)
    let epoch: number
    try {
      epoch = this.journal.claimProcess(record.handleId, record)
    } catch {
      return
    }
    let lease: NodeSessionLease
    try {
      lease = new NodeSessionLease(
        join(this.#options.directory, 'owners'),
        authority.handle.externalSessionId!
      )
    } catch {
      this.journal.releaseProcess(record.handleId, epoch)
      return // A live owner is responsible; do not fence it or open its Pi store.
    }
    try {
      await this.#authority(authority)
      const provider = await this.#provider(authority)
      if (digest(provider.binding) !== authority.providerDigest)
        fail('PI_PROVIDER_BINDING_CHANGED', 'conflict')
      const assertCurrent = async () => {
        this.journal.assertOwner(record.handleId, epoch)
        await this.#authority(authority)
      }
      const engine = await (this.#options.engineFactory ?? createPiDurableEngine)({
        directory: join(this.#options.directory, 'sessions'),
        model: { provider: provider.binding.provider, modelId: provider.binding.providerModel },
        maxOutputTokens: authority.request.attemptBudget!.maximumTokens,
        assertAuthority: assertCurrent,
        authorizeInference: async (inference) => {
          await assertCurrent()
          const allowance = await this.#options.authorizeInference(
            authority,
            `${turnKey(record)}:${inference.inferenceId}`
          )
          if (typeof allowance.assertActive !== 'function')
            fail('PI_MODEL_SPENDING_AUTHORITY_REQUIRED', 'validation')
          if (
            !Number.isSafeInteger(allowance.maxOutputTokens) ||
            allowance.maxOutputTokens < 1 ||
            allowance.maxOutputTokens > authority.request.attemptBudget!.maximumTokens
          )
            fail('PI_INFERENCE_ALLOWANCE_INVALID', 'validation')
          if (
            !Number.isSafeInteger(allowance.maximumInputTokens) ||
            allowance.maximumInputTokens < 1 ||
            !Number.isSafeInteger(allowance.maximumInputTokens + allowance.maxOutputTokens) ||
            allowance.maximumInputTokens + allowance.maxOutputTokens >
              authority.request.attemptBudget!.maximumTokens
          )
            fail('PI_INFERENCE_ALLOWANCE_INVALID', 'validation')
          await assertCurrent()
          return allowance
        },
        withModels: async (use) => {
          await assertCurrent()
          const current = await this.#provider(authority)
          if (digest(current.binding) !== authority.providerDigest)
            fail('PI_PROVIDER_BINDING_CHANGED', 'conflict')
          return current.access.withModels(use)
        },
      })
      this.#engines.set(record.handleId, engine)
      this.journal.update(
        record.handleId,
        epoch,
        {
          state: 'running',
          detail: {
            ...record.detail,
            ownerPid: process.pid,
            ownerEpoch: epoch,
            observedAt: this.#now(),
            inferencePending: true,
          },
        },
        { type: 'status', data: { state: 'running' }, at: this.#now() }
      )
      const turn = record.detail['turn'] as { requestId: string; input: string } | undefined
      const result = await engine.run({
        sessionId: authority.handle.externalSessionId!,
        requestId: turnKey(record),
        input: turn?.input ?? authority.admission.prompt,
      })
      await assertCurrent()
      const settlements = []
      for (const inference of result.inferences) {
        const receipt = RuntimeUsageSchema.parse({
          inputTokens: inference.usage.inputTokens,
          outputTokens: inference.usage.outputTokens,
          durationMs: inference.usage.durationMs,
        })
        settlements.push(
          RuntimeUsageSchema.parse(
            await this.#options.settleUsage(
              authority,
              `${turnKey(record)}:${inference.inferenceId}`,
              receipt,
              inference.usage
            )
          )
        )
      }
      if (settlements.length !== 1) fail('PI_INFERENCE_RECEIPT_REQUIRED', 'validation')
      const usage = settlements[0]!
      if (usage.inputTokens + usage.outputTokens > authority.request.attemptBudget!.maximumTokens)
        fail('PI_USAGE_EXCEEDS_AUTHORITY', 'validation')
      await assertCurrent()
      this.journal.update(
        record.handleId,
        epoch,
        {
          state: 'completed',
          detail: {
            ...record.detail,
            ownerPid: process.pid,
            ownerEpoch: epoch,
            inferencePending: false,
            observedAt: this.#now(),
            result: { outcome: 'completed', output: { text: result.text }, usage, artifacts: [] },
          },
        },
        [
          { type: 'output', data: { text: result.text }, at: this.#now() },
          { type: 'status', data: { state: 'completed' }, at: this.#now() },
        ]
      )
    } catch {
      try {
        this.journal.update(
          record.handleId,
          epoch,
          {
            state: 'unknown',
            detail: {
              ...this.journal.get(record.handleId).detail,
              observedAt: this.#now(),
              reasonCode: 'PI_INFERENCE_RECONCILIATION_REQUIRED',
            },
          },
          {
            type: 'status',
            data: { state: 'unknown', reasonCode: 'PI_INFERENCE_RECONCILIATION_REQUIRED' },
            at: this.#now(),
          }
        )
      } catch {
        /* A replacement owner retains the journal. */
      }
    } finally {
      const engine = this.#engines.get(record.handleId)
      try {
        if (engine) await engine.close()
      } finally {
        this.#engines.delete(record.handleId)
        lease.release()
        this.journal.releaseProcess(record.handleId, epoch)
      }
    }
  }

  async #authority(authority: DurableExecutionAuthority): Promise<void> {
    if (Date.parse(authority.admission.authority.expiresAt) <= Date.parse(this.#now()))
      fail('PI_AUTHORITY_EXPIRED', 'conflict')
    try {
      await this.#options.assertAuthority(authority)
    } catch {
      fail('PI_AUTHORITY_REJECTED', 'conflict')
    }
  }

  async #provider(authority: DurableExecutionAuthority) {
    let access
    try {
      access = await this.#options.resolveProvider(authority.admission.selection, authority)
    } catch {
      fail('PI_PROVIDER_READINESS_BLOCKED', 'unavailable')
    }
    const { withModels: _, ...input } = access
    const binding = ProviderBindingSchema.parse(input)
    if (
      binding.selectionRef !== authority.admission.selection.selectionRef ||
      binding.selectionRevision !== authority.admission.selection.selectionRevision ||
      binding.workspaceId !== authority.request.attemptBudget?.workspaceId
    )
      fail('PI_PROVIDER_SCOPE_MISMATCH', 'conflict')
    return { access, binding }
  }

  #stored(record: JournalRecord): StoredAdmission {
    const value = record.admission as StoredAdmission
    if (canonicalJsonStringify(value.version) !== canonicalJsonStringify(PiDurableVersion))
      fail('PI_JOURNAL_VERSION_UNSUPPORTED', 'unsupported')
    const request = RuntimeStartRequestSchema.parse(value.request)
    const admission = PiDurableAdmissionSchema.parse(value.admission)
    const handle = RuntimeExecutionHandleSchema.parse(value.handle)
    assertExecutionPlanIntegrity(request.executionPlan)
    if (
      handle.handleId !== record.handleId ||
      handle.attemptId !== record.attemptId ||
      request.attemptId !== record.attemptId ||
      !/^sha256:[a-f0-9]{64}$/.test(value.providerDigest)
    )
      fail('PI_JOURNAL_AUTHORITY_INVALID', 'conflict')
    return { ...value, request, admission, handle }
  }

  #record(handle: RuntimeExecutionHandle): JournalRecord {
    this.#assertOpen()
    const record = this.journal.get(handle.handleId)
    if (canonicalJsonStringify(this.#stored(record).handle) !== canonicalJsonStringify(handle))
      fail('PI_HANDLE_MISMATCH', 'conflict')
    return record
  }

  #claim(record: JournalRecord): number {
    this.#assertOpen()
    try {
      return this.journal.claim(record.handleId, record)
    } catch {
      fail('PI_RUNTIME_STATE_CONFLICT', 'conflict')
    }
  }

  #assertOpen(): void {
    if (this.#closing || this.#closed) fail('PI_ADAPTER_CLOSED', 'unavailable')
  }
}

function turnKey(record: JournalRecord): string {
  return (
    (record.detail['turn'] as { requestId: string } | undefined)?.requestId ??
    `pi-turn:${record.attemptId}:initial`
  )
}
function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`
}
function externalSession(hex: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let value = BigInt(`0x${hex}`)
  let encoded = ''
  for (let i = 0; i < 26; i++) {
    encoded = alphabet[Number(value & 31n)]! + encoded
    value >>= 5n
  }
  return `ses_${encoded}`
}
function fail(
  code: string,
  classification: 'validation' | 'conflict' | 'unavailable' | 'unsupported'
): never {
  throw new RuntimeAdapterError({ code, classification, message: code, retryable: false })
}
