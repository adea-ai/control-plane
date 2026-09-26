import { createHash, randomUUID } from 'node:crypto'
import { compareCodePointOrder } from '@control-plane/contracts'
import type { JsonValue, PersistenceProvider, PersistenceRecord } from '@control-plane/deployment'
import { z } from 'zod'
import {
  validateInteractionResponse,
  type ExecutionWorkflowResult,
  type WorkflowInteractionResponse,
} from './execution-workflow.js'

const namespaces = {
  jobs: 'workflow-jobs',
  interactions: 'workflow-interactions',
  cancellations: 'workflow-cancellations',
  journal: 'workflow-journal',
} as const

export const WorkflowJobStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
])

export const WorkflowJobOutcomeSchema = z.strictObject({
  executionId: z.string().min(1),
  attemptId: z.string().min(1).optional(),
  status: z.enum(['completed', 'failed', 'cancelled', 'timed_out']),
  resultReference: z.string().min(1).optional(),
  graphCheckpointId: z.string().min(1).optional(),
})

export const WorkflowJobLeaseSchema = z.strictObject({
  owner: z.string().min(1),
  token: z.string().min(1),
  expiresAt: validTimestampSchema(),
})

export const WorkflowJobRecordSchema = z.strictObject({
  workflowKey: z.string().min(1).max(512),
  status: WorkflowJobStatusSchema,
  input: z.unknown(),
  attempt: z.number().int().nonnegative(),
  maximumAttempts: z.number().int().positive().max(100),
  runAt: validTimestampSchema().optional(),
  lease: WorkflowJobLeaseSchema.optional(),
  outcome: WorkflowJobOutcomeSchema.optional(),
  lastError: z
    .strictObject({ message: z.string().min(1).max(2_048), failedAt: validTimestampSchema() })
    .optional(),
  createdAt: validTimestampSchema(),
  updatedAt: validTimestampSchema(),
})

export const WorkflowInteractionResponseSchema = z.strictObject({
  interactionId: z.string().min(1),
  responseId: z.string().min(1),
  action: z.enum(['approve', 'deny', 'input', 'grant', 'resume', 'cancel']),
  value: z.unknown().optional(),
})

export type WorkflowJobStatus = z.output<typeof WorkflowJobStatusSchema>
export type WorkflowJobOutcome = z.output<typeof WorkflowJobOutcomeSchema>
export type WorkflowJobLease = z.output<typeof WorkflowJobLeaseSchema>
export type WorkflowJobRecord = z.output<typeof WorkflowJobRecordSchema>
export type StoredWorkflowInteractionResponse = z.output<typeof WorkflowInteractionResponseSchema>

export interface WorkflowJobEnqueueInput {
  /** Durable identity of the workflow invocation; the execution id for the lifecycle workflow. */
  readonly workflowKey: string
  readonly input: unknown
  readonly maximumAttempts?: number
  /** Earliest claim time; defaults to `at` so accepted work is immediately due. */
  readonly runAt?: string
  readonly at: string
}

export interface WorkflowJobClaimInput {
  readonly owner: string
  readonly leaseMs: number
  readonly now: string
  readonly limit: number
}

export interface WorkflowJobCompletionInput {
  readonly workflowKey: string
  readonly owner: string
  readonly token: string
  readonly outcome: ExecutionWorkflowResult
  readonly at: string
}

export interface WorkflowJobFailureInput {
  readonly workflowKey: string
  readonly owner: string
  readonly token: string
  readonly error: string
  /** Next retry time; omitting it terminates the job. */
  readonly retryAt?: string
  readonly at: string
}

export interface WorkflowJobLeaseRenewalInput {
  readonly workflowKey: string
  readonly owner: string
  readonly token: string
  readonly leaseMs: number
  readonly now: string
}

export interface WorkflowInteractionSaveInput {
  readonly workflowKey: string
  readonly response: WorkflowInteractionResponse
  readonly at: string
}

export interface WorkflowCancellationRequestInput {
  readonly workflowKey: string
  readonly commandId: string
  readonly at: string
}

export interface WorkflowCancellation {
  readonly commandId: string
  readonly requestedAt: string
}

type RecordTransaction = Parameters<Parameters<PersistenceProvider['transaction']>[0]>[0]

export interface WorkflowJobStoreOptions {
  /** New-reference admission in the same writer transaction; duplicates skip it. */
  readonly beforeEnqueue?: (
    transaction: RecordTransaction,
    record: WorkflowJobRecord
  ) => Promise<void>
}

function validTimestampSchema() {
  return z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'INVALID_TIMESTAMP')
}

/**
 * Durable queue for embedded workflow execution. Jobs, interaction responses,
 * and cancellation intents are persisted through the composition's own
 * `PersistenceProvider`, so a restart (or crash) resumes with no job loss
 * beyond at-least-once semantics: claims are leased with single-use tokens
 * and reclaimed only after the lease expires.
 */
export class WorkflowJobStore {
  constructor(
    readonly provider: PersistenceProvider,
    readonly options: WorkflowJobStoreOptions = {}
  ) {}

  /** Creates the job on first sight; replays of the same workflow key are duplicates. */
  async enqueue(
    input: WorkflowJobEnqueueInput
  ): Promise<{ outcome: 'created' | 'duplicate'; record: WorkflowJobRecord }> {
    const at = validTimestamp(input.at)
    const workflowKey = validWorkflowKey(input.workflowKey)
    const record = WorkflowJobRecordSchema.parse({
      workflowKey,
      status: 'queued',
      input: json(input.input),
      attempt: 0,
      maximumAttempts: input.maximumAttempts ?? 5,
      runAt: input.runAt === undefined ? at : validTimestamp(input.runAt),
      createdAt: at,
      updatedAt: at,
    })
    return await this.provider.transaction(async (transaction) => {
      const id = recordId(workflowKey)
      const existing = await transaction.get(namespaces.jobs, id)
      if (existing !== undefined) {
        return { outcome: 'duplicate' as const, record: decodeJob(existing.value) }
      }
      await this.options.beforeEnqueue?.(transaction, record)
      await transaction.put({ namespace: namespaces.jobs, id, value: json(record) })
      return { outcome: 'created' as const, record }
    })
  }

  async get(workflowKey: string): Promise<WorkflowJobRecord | undefined> {
    const id = recordId(validWorkflowKey(workflowKey))
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(namespaces.jobs, id)
      return record === undefined ? undefined : decodeJob(record.value)
    })
  }

  /**
   * Claims due work for `owner`: queued or retryable jobs whose `runAt` has
   * passed, plus running or waiting jobs whose lease expired (crash recovery).
   * Each claim stamps a single-use lease token and counts one attempt.
   */
  async claimDue(input: WorkflowJobClaimInput): Promise<WorkflowJobRecord[]> {
    const now = validTimestamp(input.now)
    const leaseMs = validLeaseMs(input.leaseMs)
    validLimit(input.limit)
    if (input.owner.length === 0) throw new Error('WORKFLOW_JOB_INVALID_OWNER')
    return this.provider.transaction(async (transaction) => {
      const due: { record: PersistenceRecord; job: WorkflowJobRecord }[] = []
      for (const record of await transaction.list(namespaces.jobs)) {
        const job = decodeJob(record.value)
        if (!claimable(job, now)) continue
        due.push({ record, job })
      }
      due.sort(
        (left, right) =>
          compareCodePointOrder(left.job.runAt ?? '', right.job.runAt ?? '') ||
          compareCodePointOrder(left.record.id, right.record.id)
      )
      const claimed: WorkflowJobRecord[] = []
      for (const candidate of due.slice(0, input.limit)) {
        const next = WorkflowJobRecordSchema.parse({
          ...candidate.job,
          status: 'running',
          attempt: candidate.job.attempt + 1,
          lease: {
            owner: input.owner,
            token: randomUUID(),
            expiresAt: new Date(Date.parse(now) + leaseMs).toISOString(),
          },
          updatedAt: now,
        })
        await transaction.put({
          namespace: namespaces.jobs,
          id: candidate.record.id,
          expectedRevision: candidate.record.revision,
          value: json(next),
        })
        claimed.push(next)
      }
      return claimed
    })
  }

  /** Extends the live lease; only the current token holder may renew. */
  async renewLease(input: WorkflowJobLeaseRenewalInput): Promise<boolean> {
    const now = validTimestamp(input.now)
    const leaseMs = validLeaseMs(input.leaseMs)
    return this.provider.transaction(async (transaction) => {
      const current = await this.#leasedJob(
        transaction,
        input.workflowKey,
        input.owner,
        input.token
      )
      if (current === undefined) return false
      const [record, job] = current
      await transaction.put({
        namespace: namespaces.jobs,
        id: record.id,
        expectedRevision: record.revision,
        value: json(
          WorkflowJobRecordSchema.parse({
            ...job,
            lease: { ...job.lease, expiresAt: new Date(Date.parse(now) + leaseMs).toISOString() },
            updatedAt: now,
          })
        ),
      })
      return true
    })
  }

  /** Marks a live claim succeeded; stale tokens are rejected without effect. */
  async complete(input: WorkflowJobCompletionInput): Promise<boolean> {
    return this.provider.transaction(async (transaction) => {
      const current = await this.#leasedJob(
        transaction,
        input.workflowKey,
        input.owner,
        input.token
      )
      if (current === undefined) return false
      const [record, job] = current
      const outcome = WorkflowJobOutcomeSchema.parse(json(input.outcome))
      await transaction.put({
        namespace: namespaces.jobs,
        id: record.id,
        expectedRevision: record.revision,
        value: json(
          WorkflowJobRecordSchema.parse({
            ...job,
            status: 'succeeded',
            runAt: undefined,
            lease: undefined,
            outcome,
            updatedAt: validTimestamp(input.at),
          })
        ),
      })
      return true
    })
  }

  /**
   * Marks a live claim failed. With `retryAt` the job returns to the queue for
   * another attempt; without it the job terminates and is never reclaimed.
   */
  async fail(input: WorkflowJobFailureInput): Promise<boolean> {
    return this.provider.transaction(async (transaction) => {
      const current = await this.#leasedJob(
        transaction,
        input.workflowKey,
        input.owner,
        input.token
      )
      if (current === undefined) return false
      const [record, job] = current
      const at = validTimestamp(input.at)
      await transaction.put({
        namespace: namespaces.jobs,
        id: record.id,
        expectedRevision: record.revision,
        value: json(
          WorkflowJobRecordSchema.parse({
            ...job,
            status: 'failed',
            runAt: input.retryAt === undefined ? undefined : validTimestamp(input.retryAt),
            lease: undefined,
            lastError: { message: input.error.slice(0, 2_048), failedAt: at },
            updatedAt: at,
          })
        ),
      })
      return true
    })
  }

  /** Parks a live claim while the workflow awaits an interaction response. */
  async markWaiting(input: {
    readonly workflowKey: string
    readonly owner: string
    readonly token: string
    readonly at: string
  }): Promise<boolean> {
    return this.provider.transaction(async (transaction) => {
      const current = await this.#leasedJob(
        transaction,
        input.workflowKey,
        input.owner,
        input.token
      )
      if (current === undefined) return false
      const [record, job] = current
      if (job.status !== 'running') return false
      await transaction.put({
        namespace: namespaces.jobs,
        id: record.id,
        expectedRevision: record.revision,
        value: json(
          WorkflowJobRecordSchema.parse({
            ...job,
            status: 'waiting',
            updatedAt: validTimestamp(input.at),
          })
        ),
      })
      return true
    })
  }

  /** Resumes a parked job to running under its live lease, once. */
  async markRunning(input: {
    readonly workflowKey: string
    readonly owner: string
    readonly token: string
    readonly at: string
  }): Promise<boolean> {
    return this.provider.transaction(async (transaction) => {
      const current = await this.#leasedJob(
        transaction,
        input.workflowKey,
        input.owner,
        input.token
      )
      if (current === undefined) return false
      const [record, job] = current
      if (job.status !== 'waiting') return false
      await transaction.put({
        namespace: namespaces.jobs,
        id: record.id,
        expectedRevision: record.revision,
        value: json(
          WorkflowJobRecordSchema.parse({
            ...job,
            status: 'running',
            updatedAt: validTimestamp(input.at),
          })
        ),
      })
      return true
    })
  }

  /**
   * Persists the first result for a workflow activity effect. Replays return
   * the recorded result so a resumed run replays persisted activities instead
   * of re-executing them — the embedded equivalent of the Restate journal.
   * A `null` result records an activity that returned no value.
   */
  async recordEffect(
    workflowKey: string,
    effectKey: string,
    result: unknown
  ): Promise<{ outcome: 'created' | 'existing'; result?: JsonValue }> {
    const id = effectRecordId(workflowKey, effectKey)
    const value = result === undefined ? null : json(result)
    return this.provider.transaction(async (transaction) => {
      const existing = await transaction.get(namespaces.journal, id)
      if (existing !== undefined) {
        return { outcome: 'existing' as const, result: existing.value }
      }
      await transaction.put({ namespace: namespaces.journal, id, value })
      return { outcome: 'created' as const, result: value }
    })
  }

  async getEffect(workflowKey: string, effectKey: string): Promise<JsonValue | undefined> {
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(
        namespaces.journal,
        effectRecordId(workflowKey, effectKey)
      )
      return record === undefined ? undefined : record.value
    })
  }

  /**
   * Persists the first response for an interaction; replays are duplicates so
   * redelivered signals never replace the response the workflow observes.
   */
  async saveInteractionResponse(
    input: WorkflowInteractionSaveInput
  ): Promise<{ outcome: 'created' | 'duplicate' }> {
    validTimestamp(input.at)
    const response = WorkflowInteractionResponseSchema.parse(json(input.response))
    // Same validation the Restate endpoint applies before resolving its promise.
    validateInteractionResponse(response as WorkflowInteractionResponse)
    const id = interactionRecordId(input.workflowKey, response.interactionId)
    return this.provider.transaction(async (transaction) => {
      const existing = await transaction.get(namespaces.interactions, id)
      if (existing !== undefined) return { outcome: 'duplicate' as const }
      await transaction.put({ namespace: namespaces.interactions, id, value: json(response) })
      return { outcome: 'created' as const }
    })
  }

  async getInteractionResponse(
    workflowKey: string,
    interactionId: string
  ): Promise<StoredWorkflowInteractionResponse | undefined> {
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(
        namespaces.interactions,
        interactionRecordId(workflowKey, interactionId)
      )
      return record === undefined
        ? undefined
        : (WorkflowInteractionResponseSchema.parse(
            record.value
          ) as StoredWorkflowInteractionResponse)
    })
  }

  /** Records cancellation intent durably, even if the job has not been enqueued yet. */
  async requestCancellation(
    input: WorkflowCancellationRequestInput
  ): Promise<{ outcome: 'created' | 'duplicate' }> {
    const cancellation: WorkflowCancellation = {
      commandId: input.commandId,
      requestedAt: validTimestamp(input.at),
    }
    if (input.commandId.length === 0) throw new Error('WORKFLOW_JOB_INVALID_COMMAND')
    const id = recordId(validWorkflowKey(input.workflowKey))
    return this.provider.transaction(async (transaction) => {
      const existing = await transaction.get(namespaces.cancellations, id)
      if (existing !== undefined) return { outcome: 'duplicate' as const }
      await transaction.put({ namespace: namespaces.cancellations, id, value: json(cancellation) })
      return { outcome: 'created' as const }
    })
  }

  async getCancellation(workflowKey: string): Promise<WorkflowCancellation | undefined> {
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(
        namespaces.cancellations,
        recordId(validWorkflowKey(workflowKey))
      )
      return record === undefined ? undefined : decodeCancellation(record.value)
    })
  }

  async #leasedJob(
    transaction: RecordTransaction,
    workflowKey: string,
    owner: string,
    token: string
  ): Promise<[PersistenceRecord, WorkflowJobRecord] | undefined> {
    const record = await transaction.get(namespaces.jobs, recordId(validWorkflowKey(workflowKey)))
    if (record === undefined) return undefined
    const job = decodeJob(record.value)
    if (job.lease === undefined || job.lease.owner !== owner || job.lease.token !== token) {
      return undefined
    }
    if (job.status !== 'running' && job.status !== 'waiting') return undefined
    return [record, job]
  }
}

function claimable(job: WorkflowJobRecord, now: string): boolean {
  if (job.status === 'succeeded') return false
  if (job.status === 'failed' && job.runAt === undefined) return false
  if (job.runAt === undefined || job.runAt > now) return false
  return job.lease === undefined || job.lease.expiresAt <= now
}

function decodeJob(value: JsonValue): WorkflowJobRecord {
  return WorkflowJobRecordSchema.parse(value) as WorkflowJobRecord
}

function decodeCancellation(value: JsonValue): WorkflowCancellation {
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate['commandId'] !== 'string' ||
    candidate['commandId'].length === 0 ||
    typeof candidate['requestedAt'] !== 'string' ||
    Number.isNaN(Date.parse(candidate['requestedAt']))
  ) {
    throw new Error('WORKFLOW_CANCELLATION_RECORD_INVALID')
  }
  return { commandId: candidate['commandId'], requestedAt: candidate['requestedAt'] }
}

function interactionRecordId(workflowKey: string, interactionId: string): string {
  if (interactionId.length === 0) throw new Error('WORKFLOW_JOB_INVALID_INTERACTION')
  return recordId(`${validWorkflowKey(workflowKey)}\u001f${interactionId}`)
}

function effectRecordId(workflowKey: string, effectKey: string): string {
  if (typeof effectKey !== 'string' || effectKey.length === 0 || effectKey.length > 512) {
    throw new Error('WORKFLOW_JOB_INVALID_EFFECT_KEY')
  }
  return recordId(`${validWorkflowKey(workflowKey)}\u001f${effectKey}`)
}

function validWorkflowKey(workflowKey: string): string {
  if (typeof workflowKey !== 'string' || workflowKey.length === 0 || workflowKey.length > 512) {
    throw new Error('WORKFLOW_JOB_INVALID_KEY')
  }
  return workflowKey
}

function validTimestamp(value: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error('INVALID_TIMESTAMP')
  }
  return value
}

function validLeaseMs(leaseMs: number): number {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 3_600_000) {
    throw new Error('INVALID_LEASE_DURATION')
  }
  return leaseMs
}

function validLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new Error('INVALID_LIMIT')
  }
}

function recordId(value: string): string {
  return `r-${createHash('sha256').update(value).digest('hex')}`
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
