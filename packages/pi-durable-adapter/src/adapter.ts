import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import {
  assertExecutionPlanIntegrity,
  currentExecutionScopeAllows,
} from '@control-plane/execution-plan'
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
  type RuntimeStartRequest,
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
import { createPiDurableEngine, PiDurableEngineToolBlockedError } from './pi-engine.js'
import { NodeSessionLease } from './lease.js'
import { DurableToolCallRequestSchema, type DurableToolCallRequest } from '@control-plane/tool-sdk'
import { z } from 'zod'
import { PiDurableEffectGate, type DurableEffectGateOutcome } from './effect-gate.js'
import {
  PiDurableToolSourceSchema,
  verifyPiDurableToolSource,
  piDurableToolSourceKey,
  type PiDurableToolSource,
} from './tool-source.js'
import {
  PiDurableDelegateChildOutcomeSchema,
  type PiDurableGovernedDelegateChildEnginePort,
  type PiEngineResult,
} from './contracts.js'

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
      ...(this.#options.governedDelegateChild ? ['execution.child'] : []),
      ...(this.#options.scopeAuthority ? ['execution.scope.workspace.v1'] : []),
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
        ...(this.#options.governedDelegateChild
          ? ['GOVERNED_DELEGATE_CHILD_ONLY', 'NATIVE_AMBIENT_TOOLS_DISABLED']
          : ['NATIVE_TOOLS_DISABLED']),
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

  /** Host-only metadata recovery after a lost receipt acknowledgement.
   * The host MUST authorize the original actor/audience and current read scope
   * separately. This lookup validates retained immutable pins; it does not
   * require provider/spending readiness, create admission, or resume inference.
   */
  async findExistingHandle(
    input: RuntimeStartRequest
  ): Promise<RuntimeExecutionHandle | undefined> {
    this.#assertOpen()
    const request = RuntimeStartRequestSchema.parse(input)
    assertExecutionPlanIntegrity(request.executionPlan)
    if (!request.executionId || !request.attemptBudget)
      fail('PI_ATTEMPT_AUTHORITY_REQUIRED', 'validation')
    const startKey = `${request.attemptBudget.workspaceId}:${request.idempotencyKey}`
    const record = this.journal
      .list()
      .find(
        (candidate) => candidate.startKey === startKey || candidate.attemptId === request.attemptId
      )
    if (!record) return undefined
    const retained = this.#stored(record)
    if (
      record.startKey !== startKey ||
      retained.request.executionId !== request.executionId ||
      retained.request.attemptId !== request.attemptId ||
      digest(retained.request) !== digest(request) ||
      canonicalJsonStringify(retained.request) !== canonicalJsonStringify(request)
    )
      fail('PI_ADMISSION_CONFLICT', 'conflict')
    return structuredClone(retained.handle)
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
    this.#transitionInteraction(record, 'input', (current) => {
      if (current.detail['pendingInput']) {
        if (current.detail['pendingInput'] !== parsed.interactionId)
          fail('PI_INPUT_IDENTITY_CONFLICT', 'conflict')
        return undefined
      }
      return {
        change: {
          state: 'awaiting_input',
          detail: {
            ...current.detail,
            result: undefined,
            observedAt: this.#now(),
            pendingInput: parsed.interactionId,
          },
        },
        event: { type: 'interaction', data: { interactionId, kind: 'input' }, at: this.#now() },
      }
    })
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
    this.#transitionInteraction(record, 'approval', (current) => {
      const pending = current.detail['pendingApproval'] as
        | { interactionId: string; effectIdentity: string }
        | undefined
      if (pending) {
        if (pending.interactionId !== interactionId || pending.effectIdentity !== effectIdentity)
          fail('PI_APPROVAL_IDENTITY_CONFLICT', 'conflict')
        return undefined
      }
      return {
        change: {
          state: 'awaiting_input',
          detail: {
            ...current.detail,
            result: undefined,
            pendingInput: undefined,
            pendingApproval: { interactionId, effectIdentity },
            observedAt: this.#now(),
          },
        },
        event: {
          type: 'interaction',
          data: { interactionId, kind: 'approval', effectIdentity },
          at: this.#now(),
        },
      }
    })
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
    const next = this.#transitionInteraction(record, 'input', (current) => {
      if (
        current.state !== 'awaiting_input' ||
        current.detail['pendingInput'] !== request.interactionId
      )
        fail('PI_INPUT_NOT_PENDING', 'conflict')
      return {
        change: {
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
        event: { type: 'status', data: { state: 'starting' }, at: this.#now() },
      }
    })
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
    if (operation.operation === 'resume' && record) {
      const authority = this.#stored(record)
      if (authority.request.executionPlan.schemaVersion === 2) {
        await this.#authority(authority)
        this.#assertOpen()
      }
    }
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
    // Provider readiness may await while a canonical attempt is cancelled or its
    // unused allocation is reclaimed. Fence that change before retaining a
    // runtime admission; readiness itself never grants execution authority.
    await this.#authority(authority)
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
      ...(record.detail['error'] ? { error: record.detail['error'] } : {}),
      ...(record.detail['terminalUsage'] ? { terminalUsage: record.detail['terminalUsage'] } : {}),
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
      record.state === 'awaiting_input' &&
      record.detail['nativeToolBlocked'] &&
      !record.detail['pendingApproval']
    ) {
      // An acknowledgement admits no child effect. Explicit recovery reopens the same
      // native task; its retained full request still passes the independent effect gate.
      const epoch = this.#claim(record)
      const next = this.journal.update(
        record.handleId,
        epoch,
        { state: 'starting', detail: { ...record.detail, observedAt: this.#now() } },
        { type: 'status', data: { state: 'starting' }, at: this.#now() }
      )
      this.#schedule(next)
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
    const plan = assertExecutionPlanIntegrity(authority.request.executionPlan)
    const nativeAdmissions = new Map<string, DurableToolCallRequest>()
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
    const assertCurrent = async () => {
      this.journal.assertOwner(record.handleId, epoch)
      await this.#authority(authority)
      this.journal.assertOwner(record.handleId, epoch)
    }
    try {
      await this.#authority(authority)
      const provider = await this.#provider(authority)
      if (digest(provider.binding) !== authority.providerDigest)
        fail('PI_PROVIDER_BINDING_CHANGED', 'conflict')
      const governance =
        plan.constraints.limits.childExecutions.maximumTotal === 1 &&
        authority.admission.canonicalActorPrincipalId
          ? this.#options.governedDelegateChild
          : undefined
      const sourcePrefix = {
        workspaceId: IdentifierSchemas.workspaceId.parse(
          authority.request.attemptBudget!.workspaceId
        ),
        parentExecutionId: IdentifierSchemas.executionId.parse(authority.request.executionId),
        parentAttemptId: IdentifierSchemas.attemptId.parse(authority.request.attemptId),
        runtimeHandleId: record.handleId,
        externalSessionId: authority.handle.externalSessionId!,
        admittedTurnKey: turnKey(record),
      }
      const assertToolCurrent = async (input: PiDurableToolSource) => {
        const source = PiDurableToolSourceSchema.parse(input)
        await assertCurrent()
        const retained = this.journal.get(record.handleId)
        if (
          retained.state !== 'running' ||
          turnKey(retained) !== sourcePrefix.admittedTurnKey ||
          Object.entries(sourcePrefix).some(([key, value]) => Reflect.get(source, key) !== value)
        )
          fail('PI_TOOL_SOURCE_REJECTED', 'conflict')
      }
      const governedDelegateChild: PiDurableGovernedDelegateChildEnginePort | undefined = governance
        ? {
            source: sourcePrefix,
            assertCurrent: assertToolCurrent,
            execute: async (input, reader, signal) => {
              try {
                signal?.throwIfAborted()
                const nativeReader = { ...reader, assertCurrent: assertToolCurrent }
                const verified = await verifyPiDurableToolSource(
                  input.source,
                  { objective: input.objective },
                  nativeReader
                )
                if (verified.sourceKey !== input.sourceKey)
                  fail('PI_TOOL_SOURCE_REJECTED', 'conflict')
                signal?.throwIfAborted()
                const request = DurableToolCallRequestSchema.parse(
                  await governance.prepare(structuredClone(authority), structuredClone(verified))
                )
                if (
                  request.workspaceId !== sourcePrefix.workspaceId ||
                  request.executionId !== sourcePrefix.parentExecutionId ||
                  request.attemptId !== sourcePrefix.parentAttemptId ||
                  request.profileId !== plan.profile.profileId ||
                  !authority.admission.canonicalActorPrincipalId ||
                  request.audit.principalRef !== authority.admission.canonicalActorPrincipalId ||
                  request.operation !== 'delegate-child' ||
                  canonicalJsonStringify(
                    z
                      .strictObject({ objective: z.string().trim().min(1).max(8192) })
                      .parse(request.input)
                  ) !== canonicalJsonStringify({ objective: verified.objective })
                )
                  fail('PI_CHILD_REQUEST_AUTHORITY_REJECTED', 'conflict')
                await verifyPiDurableToolSource(
                  verified.source,
                  { objective: verified.objective },
                  nativeReader
                )
                signal?.throwIfAborted()
                nativeAdmissions.set(verified.sourceKey, request)
                const base = governance.gate()
                const gate = new PiDurableEffectGate({
                  ...base.options,
                  assertAuthority: async (call, boundary) => {
                    signal?.throwIfAborted()
                    await verifyPiDurableToolSource(
                      verified.source,
                      { objective: verified.objective },
                      nativeReader
                    )
                    await base.options.assertAuthority(call, boundary)
                    await assertToolCurrent(verified.source)
                    signal?.throwIfAborted()
                  },
                })
                return delegateChildOutcome(
                  await gate.execute(request, signal ? { signal } : {}),
                  request
                )
              } catch {
                fail('PI_CHILD_DELEGATION_REJECTED', 'conflict')
              }
            },
          }
        : undefined
      const runningAt = this.#now()
      this.journal.update(
        record.handleId,
        epoch,
        {
          state: 'running',
          detail: {
            ...record.detail,
            ownerPid: process.pid,
            ownerEpoch: epoch,
            observedAt: runningAt,
            inferencePending: true,
          },
        },
        { type: 'status', data: { state: 'running' }, at: runningAt }
      )
      await this.#options.onExecutionRunning?.({
        request: structuredClone(authority.request),
        admission: structuredClone(authority.admission),
        handle: structuredClone(authority.handle),
        observedAt: runningAt,
      })
      await assertCurrent()
      const engine = await (this.#options.engineFactory ?? createPiDurableEngine)({
        directory: join(this.#options.directory, 'sessions'),
        model: { provider: provider.binding.provider, modelId: provider.binding.providerModel },
        maxOutputTokens: authority.request.attemptBudget!.maximumTokens,
        assertAuthority: assertCurrent,
        retainInferences: async (inferences) => {
          await this.#retainInferences(record, epoch, authority, inferences, assertCurrent)
        },
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
        ...(governedDelegateChild ? { governedDelegateChild } : {}),
      })
      this.#engines.set(record.handleId, engine)
      await assertCurrent()
      const turn = record.detail['turn'] as { requestId: string; input: string } | undefined
      const result = await engine.run({
        sessionId: authority.handle.externalSessionId!,
        requestId: turnKey(record),
        input: turn?.input ?? authority.admission.prompt,
      })
      await assertCurrent()
      const usage = await this.#retainInferences(
        record,
        epoch,
        authority,
        result.inferences,
        assertCurrent
      )
      if (usage.inputTokens + usage.outputTokens > authority.request.attemptBudget!.maximumTokens)
        fail('PI_USAGE_EXCEEDS_AUTHORITY', 'validation')
      await assertCurrent()
      this.journal.update(
        record.handleId,
        epoch,
        {
          state: 'completed',
          detail: {
            ...this.journal.get(record.handleId).detail,
            nativeToolBlocked: undefined,
            pendingApproval: undefined,
            error: undefined,
            terminalUsage: undefined,
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
    } catch (error) {
      if (error instanceof PiDurableEngineToolBlockedError) {
        try {
          const source = PiDurableToolSourceSchema.parse(error.source)
          const request = nativeAdmissions.get(error.sourceKey)
          const outcome = PiDurableDelegateChildOutcomeSchema.parse(error.outcome)
          if (
            !request ||
            error.sourceKey !== piDurableToolSourceKey(source) ||
            request.toolCallId !== outcome.toolCallId ||
            source.runtimeHandleId !== record.handleId ||
            source.admittedTurnKey !== turnKey(record) ||
            source.parentAttemptId !== record.attemptId
          )
            fail('PI_TOOL_SOURCE_REJECTED', 'conflict')
          const usage = await this.#retainInferences(
            record,
            epoch,
            authority,
            error.inferences,
            assertCurrent
          )
          const state =
            outcome.state === 'awaiting_approval'
              ? 'awaiting_input'
              : outcome.state === 'denied'
                ? 'failed'
                : 'unknown'
          if (outcome.state === 'succeeded') fail('PI_CHILD_OUTCOME_INVALID', 'conflict')
          await assertCurrent()
          this.journal.update(
            record.handleId,
            epoch,
            {
              state,
              detail: {
                ...this.journal.get(record.handleId).detail,
                inferencePending: false,
                observedAt: this.#now(),
                nativeToolBlocked: { source, sourceKey: error.sourceKey, outcome },
                ...(state === 'awaiting_input' && request.approval
                  ? {
                      pendingApproval: {
                        interactionId: request.approval.interactionId,
                        effectIdentity: digest(request),
                      },
                    }
                  : {}),
                ...(state === 'failed'
                  ? {
                      error: {
                        code: 'PI_CHILD_DELEGATION_DENIED',
                        classification: 'conflict',
                        message: 'PI_CHILD_DELEGATION_DENIED',
                        retryable: false,
                      },
                      terminalUsage: usage,
                    }
                  : {}),
              },
            },
            [
              { type: 'usage', data: { usage }, at: this.#now() },
              {
                type: state === 'awaiting_input' ? 'interaction' : 'status',
                data: { ...outcome, state },
                at: this.#now(),
              },
            ]
          )
          return
        } catch {
          // Failed receipt/authority retention remains unresolved rather than admitting effects again.
        }
      }
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

  async #retainInferences(
    record: JournalRecord,
    epoch: number,
    authority: DurableExecutionAuthority,
    inferences: PiEngineResult['inferences'],
    assertCurrent: () => Promise<void>
  ) {
    if (
      !inferences.length ||
      inferences.length > 1024 ||
      new Set(inferences.map((item) => item.inferenceId)).size !== inferences.length
    )
      fail('PI_INFERENCE_RECEIPT_REQUIRED', 'validation')
    for (const inference of inferences) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(inference.inferenceId))
        fail('PI_INFERENCE_RECEIPT_REQUIRED', 'validation')
      await assertCurrent()
      const key = `${turnKey(record)}:${inference.inferenceId}`
      const retained = this.journal.get(record.handleId).detail['inferenceReceipts'] as
        | Record<
            string,
            {
              turnKey: string
              nativeDigest: string
              usage: ReturnType<typeof RuntimeUsageSchema.parse>
            }
          >
        | undefined
      if (retained?.[key]) {
        if (
          retained[key].turnKey !== turnKey(record) ||
          retained[key].nativeDigest !== digest(inference.usage)
        )
          fail('PI_INFERENCE_RECEIPT_CONFLICT', 'conflict')
        RuntimeUsageSchema.parse(retained[key].usage)
        continue
      }
      const usage = RuntimeUsageSchema.parse(
        await this.#options.settleUsage(
          authority,
          key,
          RuntimeUsageSchema.parse({
            inputTokens: inference.usage.inputTokens,
            outputTokens: inference.usage.outputTokens,
            durationMs: inference.usage.durationMs,
          }),
          inference.usage
        )
      )
      await assertCurrent()
      const current = this.journal.get(record.handleId)
      const receipts = (current.detail['inferenceReceipts'] ?? {}) as Record<
        string,
        {
          turnKey: string
          nativeDigest: string
          usage: ReturnType<typeof RuntimeUsageSchema.parse>
        }
      >
      const value = { turnKey: turnKey(record), nativeDigest: digest(inference.usage), usage }
      if (receipts[key] && canonicalJsonStringify(receipts[key]) !== canonicalJsonStringify(value))
        fail('PI_INFERENCE_RECEIPT_CONFLICT', 'conflict')
      if (!receipts[key]) {
        if (Object.keys(receipts).length >= 1024) fail('PI_INFERENCE_RECEIPT_LIMIT', 'validation')
        this.journal.update(record.handleId, epoch, {
          detail: { ...current.detail, inferenceReceipts: { ...receipts, [key]: value } },
        })
      }
    }
    const receipts = this.journal.get(record.handleId).detail['inferenceReceipts'] as Record<
      string,
      { turnKey: string; usage: ReturnType<typeof RuntimeUsageSchema.parse> }
    >
    const total = aggregateUsage(Object.values(receipts).map((value) => value.usage))
    if (
      total.inputTokens + total.outputTokens > authority.request.attemptBudget!.maximumTokens ||
      (total.accounting?.chargedMicrounits ?? 0) >
        authority.request.attemptBudget!.maximumMicrounits
    )
      fail('PI_USAGE_EXCEEDS_AUTHORITY', 'validation')
    return aggregateUsage(
      Object.entries(receipts)
        .filter(([, value]) => value.turnKey === turnKey(record))
        .map(([, value]) => value.usage)
    )
  }

  async #authority(authority: DurableExecutionAuthority): Promise<void> {
    if (Date.parse(authority.admission.authority.expiresAt) <= Date.parse(this.#now()))
      fail('PI_AUTHORITY_EXPIRED', 'conflict')
    try {
      await this.#options.assertAuthority(authority)
      const plan = assertExecutionPlanIntegrity(authority.request.executionPlan)
      if (plan.schemaVersion === 2) {
        const actor = authority.admission.canonicalActorPrincipalId
        if (
          !actor ||
          !this.#options.scopeAuthority ||
          !(await currentExecutionScopeAllows(
            this.#options.scopeAuthority,
            {
              ...plan.correlation,
              callerPrincipalId: actor,
              executionPlan: {
                executionPlanId: plan.executionPlanId,
                contentDigest: plan.contentDigest,
                schemaVersion: plan.schemaVersion,
              },
            },
            this.#now()
          ))
        )
          fail('PI_EXECUTION_SCOPE_REJECTED', 'conflict')
      }
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

  #transitionInteraction(
    record: JournalRecord,
    kind: 'input' | 'approval',
    operation: Parameters<SqliteDurableJournal['transition']>[1]
  ): JournalRecord {
    this.#assertOpen()
    try {
      return this.journal.transition(record, (current) => {
        this.#assertInteractionQuiescent(current, kind)
        return operation(current)
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'STALE_STATE')
        fail('PI_RUNTIME_STATE_CONFLICT', 'conflict')
      throw error
    }
  }

  #assertInteractionQuiescent(current: JournalRecord, kind: 'input' | 'approval'): void {
    this.#assertOpen()
    if (current.detail['sessionClosed']) fail('PI_SESSION_CLOSED', 'conflict')
    if (this.#active.has(current.handleId)) fail('PI_EXECUTION_BUSY', 'conflict')
    if (
      current.detail['inferencePending'] ||
      ['starting', 'running', 'unknown', 'cancelling'].includes(current.state)
    )
      fail('PI_RECONCILIATION_REQUIRED', 'conflict')
    if (!['completed', 'awaiting_input'].includes(current.state))
      fail('PI_EXECUTION_TERMINAL', 'conflict')
    if (kind === 'input' && current.detail['pendingApproval'])
      fail('PI_APPROVAL_NOT_RESOLVED', 'conflict')
    if (kind === 'approval' && current.detail['pendingInput'])
      fail('PI_INPUT_NOT_RESOLVED', 'conflict')
    // A completed receipt can precede engine/store release. Consult the durable
    // owner rather than treating this adapter's empty #active map as quiescence.
    const ownerPid = current.detail['ownerPid']
    if (ownerPid !== undefined) {
      if (typeof ownerPid !== 'number' || !Number.isSafeInteger(ownerPid) || ownerPid < 1)
        fail('PI_EXECUTION_BUSY', 'conflict')
      let live = true
      try {
        process.kill(ownerPid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') fail('PI_EXECUTION_BUSY', 'conflict')
        live = false
      }
      if (live) fail('PI_EXECUTION_BUSY', 'conflict')
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

function delegateChildOutcome(outcome: DurableEffectGateOutcome, request: DurableToolCallRequest) {
  const toolCallId = 'call' in outcome ? outcome.call.toolCallId : outcome.toolCallId
  if (toolCallId !== request.toolCallId) fail('PI_CHILD_OUTCOME_INVALID', 'conflict')
  const identity = {
    schemaVersion: 'pi-delegate-child-outcome/v1' as const,
    state: outcome.state,
    toolCallId,
  }
  if (outcome.state === 'succeeded') {
    const refs = z
      .object({
        delegationId: IdentifierSchemas.delegationId,
        childExecutionId: IdentifierSchemas.executionId,
        childAttemptId: IdentifierSchemas.attemptId,
        externalSessionId: IdentifierSchemas.externalSessionId.optional(),
      })
      .parse(outcome.result.output)
    return PiDurableDelegateChildOutcomeSchema.parse({ ...identity, ...refs })
  }
  if (outcome.state === 'awaiting_approval') {
    if (!request.approval || outcome.call.approvalInteractionId !== request.approval.interactionId)
      fail('PI_CHILD_OUTCOME_INVALID', 'conflict')
    return PiDurableDelegateChildOutcomeSchema.parse({
      ...identity,
      interactionId: request.approval.interactionId,
      reasonCode: 'PI_CHILD_APPROVAL_PENDING',
    })
  }
  return PiDurableDelegateChildOutcomeSchema.parse({
    ...identity,
    reasonCode:
      outcome.state === 'denied' ? 'PI_CHILD_DELEGATION_DENIED' : 'PI_CHILD_OUTCOME_UNKNOWN',
  })
}

function aggregateUsage(receipts: readonly ReturnType<typeof RuntimeUsageSchema.parse>[]) {
  if (!receipts.length) fail('PI_INFERENCE_RECEIPT_REQUIRED', 'validation')
  if (receipts.length === 1) return receipts[0]!
  const accounting = receipts.map((item) => item.accounting)
  const costs = receipts.map((item) => item.cost)
  if (
    (accounting.some(Boolean) && accounting.some((item) => !item)) ||
    (costs.some(Boolean) && costs.some((item) => !item))
  )
    fail('PI_USAGE_ACCOUNTING_SCOPE_MISMATCH', 'conflict')
  const scope = accounting[0]
  if (
    (scope &&
      accounting.some(
        (item) =>
          item!.fundingSource !== scope.fundingSource ||
          item!.currency !== scope.currency ||
          item!.costExact !== scope.costExact
      )) ||
    (costs[0] && costs.some((item) => item!.currency !== costs[0]!.currency))
  )
    fail('PI_USAGE_ACCOUNTING_SCOPE_MISMATCH', 'conflict')
  const sum = (values: readonly number[]) => {
    const value = values.reduce((total, item) => total + BigInt(item), 0n)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('PI_USAGE_EXCEEDS_AUTHORITY', 'validation')
    return Number(value)
  }
  let cost
  if (costs[0]) {
    const charged = costs.reduce((total, item) => {
      const [whole, fraction = ''] = item!.amount.split('.')
      if (whole!.length > 10 || /[1-9]/.test(fraction.slice(6)))
        fail('PI_USAGE_ACCOUNTING_SCOPE_MISMATCH', 'conflict')
      return total + BigInt(whole!) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, '0'))
    }, 0n)
    if (charged > BigInt(Number.MAX_SAFE_INTEGER)) fail('PI_USAGE_EXCEEDS_AUTHORITY', 'validation')
    cost = {
      amount: `${charged / 1_000_000n}.${String(charged % 1_000_000n).padStart(6, '0')}`,
      currency: costs[0].currency,
    }
  }
  return RuntimeUsageSchema.parse({
    inputTokens: sum(receipts.map((item) => item.inputTokens)),
    outputTokens: sum(receipts.map((item) => item.outputTokens)),
    durationMs: sum(receipts.map((item) => item.durationMs)),
    ...(cost ? { cost } : {}),
    ...(scope
      ? {
          accounting: {
            ...scope,
            // A bounded composite provenance reference; each underlying source receipt stays retained.
            sourceId: `pi-turn-usage:${digest(accounting.map((item) => item!.sourceId).toSorted()).slice(7)}`,
            chargedMicrounits: sum(accounting.map((item) => item!.chargedMicrounits)),
          },
        }
      : {}),
  })
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
