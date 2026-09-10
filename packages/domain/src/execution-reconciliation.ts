import { IdentifierSchemas } from '@control-plane/contracts'
import { createHash } from 'node:crypto'
import { z } from 'zod'

const TimestampSchema = z.iso.datetime()

export const ReconciliationReasonSchema = z.enum([
  'accepted_unstarted',
  'stale_heartbeat',
  'runtime_disconnected',
  'runtime_disappeared',
  'workflow_stalled',
  'runtime_terminal_unrecorded',
  'terminal_undelivered',
  'healthy',
])

export const ReconciliationActionSchema = z.enum([
  'none',
  'resume_existing_workflow',
  'wait_for_runtime',
  'manual_intervention',
  'apply_runtime_terminal',
  'replay_events',
])

export const ReconciliationCheckpointStateSchema = z.enum([
  'reconciling',
  'waiting',
  'remediated',
  'manual_intervention',
  'resolved',
])

const RuntimeObservationSchema = z
  .object({
    status: z.enum([
      'unknown',
      'running',
      'completed',
      'failed',
      'cancelled',
      'disconnected',
      'not_found',
    ]),
    observedAt: TimestampSchema,
    resultReference: IdentifierSchemas.artifactId.optional(),
    errorReference: z.string().max(512).optional(),
  })
  .strict()

export const ReconciliationObservationSchema = z
  .object({
    executionId: IdentifierSchemas.executionId,
    checkedAt: TimestampSchema,
    command: z
      .object({
        commandId: IdentifierSchemas.commandId,
        status: z.enum([
          'accepted',
          'processing',
          'completed',
          'failed',
          'reconciliation_required',
        ]),
      })
      .strict(),
    execution: z
      .object({
        state: z.enum([
          'accepted',
          'queued',
          'starting',
          'running',
          'awaiting_input',
          'cancelling',
          'completed',
          'failed',
          'cancelled',
          'timed_out',
          'reconciliation_required',
        ]),
        updatedAt: TimestampSchema,
        terminalResultRef: IdentifierSchemas.artifactId.optional(),
      })
      .strict(),
    attempt: z
      .object({
        attemptId: IdentifierSchemas.attemptId,
        sequence: z.number().int().positive(),
        state: z.enum([
          'queued',
          'starting',
          'running',
          'awaiting_input',
          'cancelling',
          'completed',
          'failed',
          'cancelled',
          'timed_out',
          'reconciliation_required',
        ]),
        updatedAt: TimestampSchema,
        runtimeCommandId: z.string().min(1).max(256).optional(),
      })
      .strict()
      .optional(),
    workflow: z
      .object({
        workflowId: IdentifierSchemas.workflowId.optional(),
        status: z.enum(['missing', 'running', 'completed', 'failed', 'cancelled']),
        lastProgressAt: TimestampSchema.optional(),
      })
      .strict(),
    runtime: RuntimeObservationSchema,
    delivery: z
      .object({
        pendingCount: z.number().int().nonnegative(),
        oldestPendingAt: TimestampSchema.optional(),
      })
      .strict(),
  })
  .strict()

export const ReconciliationCheckpointSchema = z
  .object({
    checkpointId: z.string().regex(/^rcp_[a-f0-9]{32}$/),
    executionId: IdentifierSchemas.executionId,
    commandId: IdentifierSchemas.commandId,
    attemptId: IdentifierSchemas.attemptId.optional(),
    workflowId: IdentifierSchemas.workflowId.optional(),
    runtimeCommandId: z.string().min(1).max(256).optional(),
    pendingEventCount: z.number().int().nonnegative(),
    observationHash: z.string().regex(/^[a-f0-9]{64}$/),
    reason: ReconciliationReasonSchema,
    action: ReconciliationActionSchema,
    state: ReconciliationCheckpointStateSchema,
    diagnostics: z.array(z.string().min(1).max(256)).max(16),
    version: z.number().int().positive(),
    checkedAt: TimestampSchema,
    updatedAt: TimestampSchema,
    resolvedAt: TimestampSchema.optional(),
  })
  .strict()

export type ReconciliationObservation = z.output<typeof ReconciliationObservationSchema>
export type ReconciliationCheckpoint = z.output<typeof ReconciliationCheckpointSchema>

export interface ReconciliationCheckpointRepository {
  getByObservationHash(observationHash: string): Promise<ReconciliationCheckpoint | undefined>
  insert(checkpoint: ReconciliationCheckpoint): Promise<boolean>
  compareAndSet(expectedVersion: number, checkpoint: ReconciliationCheckpoint): Promise<boolean>
}

export class InMemoryReconciliationCheckpointRepository implements ReconciliationCheckpointRepository {
  readonly #checkpoints = new Map<string, ReconciliationCheckpoint>()

  async getByObservationHash(hash: string): Promise<ReconciliationCheckpoint | undefined> {
    return cloneOptional(this.#checkpoints.get(hash))
  }

  async insert(checkpoint: ReconciliationCheckpoint): Promise<boolean> {
    const parsed = ReconciliationCheckpointSchema.parse(checkpoint)
    if (this.#checkpoints.has(parsed.observationHash)) return false
    this.#checkpoints.set(parsed.observationHash, clone(parsed))
    return true
  }

  async compareAndSet(
    expectedVersion: number,
    checkpoint: ReconciliationCheckpoint
  ): Promise<boolean> {
    const parsed = ReconciliationCheckpointSchema.parse(checkpoint)
    const current = this.#checkpoints.get(parsed.observationHash)
    if (current?.version !== expectedVersion || current.checkpointId !== parsed.checkpointId) {
      return false
    }
    this.#checkpoints.set(parsed.observationHash, clone(parsed))
    return true
  }
}

export interface ReconciliationSource {
  load(executionId: string): Promise<ReconciliationObservation>
  listCandidates(input: { readonly limit: number }): Promise<readonly string[]>
}

export interface ReconciliationEffects {
  markReconciliationRequired(input: {
    readonly executionId: string
    readonly attemptId?: string
    readonly reason: z.output<typeof ReconciliationReasonSchema>
    readonly checkpointId: string
    readonly observedAt: string
  }): Promise<void>
  resumeWorkflow(input: {
    readonly executionId: string
    readonly checkpointId: string
  }): Promise<void>
  applyRuntimeTerminal(input: {
    readonly executionId: string
    readonly attemptId: string
    readonly checkpointId: string
    readonly outcome: 'completed' | 'failed' | 'cancelled'
    readonly resultReference?: string
    readonly errorReference?: string
    readonly observedAt: string
  }): Promise<void>
  replayEvents(input: {
    readonly executionId: string
    readonly checkpointId: string
  }): Promise<void>
}

export interface ExecutionReconciliationServiceOptions {
  readonly repository: ReconciliationCheckpointRepository
  readonly source: ReconciliationSource
  readonly effects: ReconciliationEffects
  readonly policy?: { readonly staleAfterMs: number }
}

interface Decision {
  readonly reason: z.output<typeof ReconciliationReasonSchema>
  readonly action: z.output<typeof ReconciliationActionSchema>
  readonly state: z.output<typeof ReconciliationCheckpointStateSchema>
  readonly diagnostics: readonly string[]
  readonly markRequired: boolean
}

export class ExecutionReconciliationService {
  readonly #repository: ReconciliationCheckpointRepository
  readonly #source: ReconciliationSource
  readonly #effects: ReconciliationEffects
  readonly #staleAfterMs: number
  readonly #inFlight = new Map<
    string,
    Promise<{ checkpoint: ReconciliationCheckpoint; created: boolean }>
  >()

  constructor(options: ExecutionReconciliationServiceOptions) {
    this.#repository = options.repository
    this.#source = options.source
    this.#effects = options.effects
    this.#staleAfterMs = options.policy?.staleAfterMs ?? 60_000
    if (!Number.isInteger(this.#staleAfterMs) || this.#staleAfterMs < 1) {
      throw new Error('INVALID_RECONCILIATION_STALE_POLICY')
    }
  }

  async reconcile(executionId: string): Promise<ReconciliationCheckpoint> {
    return (await this.#reconcile(IdentifierSchemas.executionId.parse(executionId))).checkpoint
  }

  async runBatch(input: { readonly limit: number }): Promise<{
    examined: number
    reconciled: number
    remediated: number
    manualIntervention: number
    waiting: number
  }> {
    const limit = z.number().int().min(1).max(1_000).parse(input.limit)
    const executionIds = await this.#source.listCandidates({ limit })
    const results = await Promise.all(
      executionIds.map((executionId) => this.#reconcile(executionId))
    )
    return {
      examined: results.length,
      reconciled: results.filter(({ created }) => created).length,
      remediated: results.filter(({ checkpoint }) => checkpoint.state === 'remediated').length,
      manualIntervention: results.filter(
        ({ checkpoint }) => checkpoint.state === 'manual_intervention'
      ).length,
      waiting: results.filter(({ checkpoint }) => checkpoint.state === 'waiting').length,
    }
  }

  async #reconcile(executionId: string): Promise<{
    checkpoint: ReconciliationCheckpoint
    created: boolean
  }> {
    const active = this.#inFlight.get(executionId)
    if (active) return active
    const operation = this.#perform(executionId).finally(() => this.#inFlight.delete(executionId))
    this.#inFlight.set(executionId, operation)
    return operation
  }

  async #perform(executionId: string): Promise<{
    checkpoint: ReconciliationCheckpoint
    created: boolean
  }> {
    const observation = ReconciliationObservationSchema.parse(await this.#source.load(executionId))
    if (observation.executionId !== executionId) throw new Error('RECONCILIATION_SCOPE_MISMATCH')
    const decision = decide(observation, this.#staleAfterMs)
    const observationHash = hashObservation(observation, decision)
    const existing = await this.#repository.getByObservationHash(observationHash)
    if (existing) {
      if (existing.state !== 'reconciling') return { checkpoint: existing, created: false }
      return {
        checkpoint: await this.#complete(existing, decision, observation),
        created: false,
      }
    }

    const checkpointId = `rcp_${observationHash.slice(0, 32)}`
    const initial = ReconciliationCheckpointSchema.parse({
      checkpointId,
      executionId,
      commandId: observation.command.commandId,
      ...(observation.attempt ? { attemptId: observation.attempt.attemptId } : {}),
      ...(observation.workflow.workflowId ? { workflowId: observation.workflow.workflowId } : {}),
      ...(observation.attempt?.runtimeCommandId
        ? { runtimeCommandId: observation.attempt.runtimeCommandId }
        : {}),
      pendingEventCount: observation.delivery.pendingCount,
      observationHash,
      reason: decision.reason,
      action: decision.action,
      state: 'reconciling',
      diagnostics: decision.diagnostics,
      version: 1,
      checkedAt: observation.checkedAt,
      updatedAt: observation.checkedAt,
    })
    if (!(await this.#repository.insert(initial))) {
      const concurrent = await this.#repository.getByObservationHash(observationHash)
      if (!concurrent) throw new Error('RECONCILIATION_CHECKPOINT_RACE')
      return { checkpoint: concurrent, created: false }
    }

    return {
      checkpoint: await this.#complete(initial, decision, observation),
      created: true,
    }
  }

  async #complete(
    checkpoint: ReconciliationCheckpoint,
    decision: Decision,
    observation: ReconciliationObservation
  ): Promise<ReconciliationCheckpoint> {
    if (decision.markRequired) {
      await this.#effects.markReconciliationRequired({
        executionId: observation.executionId,
        ...(observation.attempt ? { attemptId: observation.attempt.attemptId } : {}),
        reason: decision.reason,
        checkpointId: checkpoint.checkpointId,
        observedAt: observation.checkedAt,
      })
    }
    await this.#apply(decision, observation, checkpoint.checkpointId)
    const completed = ReconciliationCheckpointSchema.parse({
      ...checkpoint,
      state: decision.state,
      version: checkpoint.version + 1,
      updatedAt: observation.checkedAt,
      ...(['remediated', 'resolved'].includes(decision.state)
        ? { resolvedAt: observation.checkedAt }
        : {}),
    })
    if (!(await this.#repository.compareAndSet(checkpoint.version, completed))) {
      const concurrent = await this.#repository.getByObservationHash(checkpoint.observationHash)
      if (!concurrent || concurrent.state === 'reconciling') {
        throw new Error('RECONCILIATION_CHECKPOINT_STALE')
      }
      return concurrent
    }
    return completed
  }

  async #apply(
    decision: Decision,
    observation: ReconciliationObservation,
    checkpointId: string
  ): Promise<void> {
    if (decision.action === 'resume_existing_workflow') {
      await this.#effects.resumeWorkflow({ executionId: observation.executionId, checkpointId })
    } else if (decision.action === 'replay_events') {
      await this.#effects.replayEvents({ executionId: observation.executionId, checkpointId })
    } else if (decision.action === 'apply_runtime_terminal') {
      if (!observation.attempt || !isRuntimeTerminal(observation.runtime.status)) {
        throw new Error('INVALID_RUNTIME_TERMINAL_OBSERVATION')
      }
      if (observation.runtime.status === 'completed' && !observation.runtime.resultReference) {
        throw new Error('RUNTIME_COMPLETION_RESULT_REQUIRED')
      }
      await this.#effects.applyRuntimeTerminal({
        executionId: observation.executionId,
        attemptId: observation.attempt.attemptId,
        checkpointId,
        outcome: observation.runtime.status,
        ...(observation.runtime.resultReference
          ? { resultReference: observation.runtime.resultReference }
          : {}),
        ...(observation.runtime.errorReference
          ? { errorReference: observation.runtime.errorReference }
          : {}),
        observedAt: observation.runtime.observedAt,
      })
    }
  }
}

function decide(observation: ReconciliationObservation, staleAfterMs: number): Decision {
  const terminal = ['completed', 'failed', 'cancelled', 'timed_out'].includes(
    observation.execution.state
  )
  if (terminal && observation.delivery.pendingCount > 0) {
    return makeDecision('terminal_undelivered', 'replay_events', 'remediated', false, [
      `pending_events=${observation.delivery.pendingCount}`,
    ])
  }
  if (
    observation.execution.state === 'accepted' &&
    !observation.attempt &&
    observation.workflow.status === 'missing'
  ) {
    return makeDecision('accepted_unstarted', 'resume_existing_workflow', 'remediated', true, [
      `command_status=${observation.command.status}`,
      'attempt=missing',
      'workflow=missing',
    ])
  }
  if (!terminal && isRuntimeTerminal(observation.runtime.status)) {
    return makeDecision(
      'runtime_terminal_unrecorded',
      'apply_runtime_terminal',
      'remediated',
      true,
      [
        `runtime_status=${observation.runtime.status}`,
        `runtime_observed_at=${observation.runtime.observedAt}`,
      ]
    )
  }
  if (!terminal && observation.runtime.status === 'disconnected') {
    return makeDecision(
      'runtime_disconnected',
      'manual_intervention',
      'manual_intervention',
      true,
      ['runtime_status=disconnected']
    )
  }
  if (!terminal && observation.runtime.status === 'not_found') {
    return makeDecision('runtime_disappeared', 'manual_intervention', 'manual_intervention', true, [
      'runtime_status=not_found',
    ])
  }
  if (
    !terminal &&
    observation.workflow.status === 'running' &&
    isStale(observation.workflow.lastProgressAt, observation.checkedAt, staleAfterMs) &&
    !isStale(observation.execution.updatedAt, observation.checkedAt, staleAfterMs)
  ) {
    return makeDecision('workflow_stalled', 'wait_for_runtime', 'waiting', true, [
      `workflow_last_progress_at=${observation.workflow.lastProgressAt ?? 'missing'}`,
      `runtime_status=${observation.runtime.status}`,
    ])
  }
  if (!terminal && isStale(observation.attempt?.updatedAt, observation.checkedAt, staleAfterMs)) {
    return makeDecision('stale_heartbeat', 'wait_for_runtime', 'waiting', true, [
      `attempt_updated_at=${observation.attempt?.updatedAt ?? 'missing'}`,
      `runtime_status=${observation.runtime.status}`,
    ])
  }
  return makeDecision('healthy', 'none', 'resolved', false, ['no_reconciliation_required'])
}

function makeDecision(
  reason: Decision['reason'],
  action: Decision['action'],
  state: Decision['state'],
  markRequired: boolean,
  diagnostics: readonly string[]
): Decision {
  return { reason, action, state, markRequired, diagnostics }
}

function isRuntimeTerminal(
  status: ReconciliationObservation['runtime']['status']
): status is 'completed' | 'failed' | 'cancelled' {
  return ['completed', 'failed', 'cancelled'].includes(status)
}

function isStale(value: string | undefined, checkedAt: string, staleAfterMs: number): boolean {
  return value !== undefined && Date.parse(checkedAt) - Date.parse(value) >= staleAfterMs
}

function hashObservation(observation: ReconciliationObservation, decision: Decision): string {
  const durableFacts = {
    ...observation,
    checkedAt: undefined,
    runtime: { ...observation.runtime, observedAt: undefined },
  }
  return createHash('sha256')
    .update(
      canonicalJson({
        ...durableFacts,
        decision: { reason: decision.reason, action: decision.action },
      })
    )
    .digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`
  }
  throw new Error('RECONCILIATION_OBSERVATION_MUST_BE_JSON')
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

function cloneOptional<Value>(value: Value | undefined): Value | undefined {
  return value === undefined ? undefined : clone(value)
}
