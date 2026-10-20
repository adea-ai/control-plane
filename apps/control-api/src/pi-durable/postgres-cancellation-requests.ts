import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
import { canonicalJsonStringify } from '@control-plane/contracts'
import {
  commandInbox,
  executions,
  executionAttempts,
  persistenceRecords,
  outboxEvents,
  type ControlPlaneDatabase,
} from '@control-plane/database'
import {
  PiCancellationRetainedIntentSchema,
  assertPiCancellationIntentReplay,
  piCancellationTargetDigest,
  type PiCancellationRetainedIntent,
} from '@control-plane/pi-durable-adapter'
import { deterministicPiLeadIntentIds } from './node-admission.js'

export const piCancellationRequestNamespace = 'pi.cancellation.requests.v1'
export const piCancellationRequestEvent = 'pi.cancellation.requested.v1'
const aggregateType = 'pi_cancellation_request'
const RecordSchema = z.strictObject({
  schemaVersion: z.literal('pi-cancellation-request-record/v1'),
  intent: PiCancellationRetainedIntentSchema,
  outboxId: z.uuid(),
  retainedAt: z.iso.datetime({ precision: 3 }),
})
const RetrySchema = z.strictObject({
  schemaVersion: z.literal('pi-cancellation-request-retry/v1'),
  requestKey: z.string().regex(/^[a-f0-9]{64}$/),
  requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  targetDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
})
type StoredRequest = z.infer<typeof RecordSchema>
type Transaction = Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0]

export function piCancellationRequestKey(intent: PiCancellationRetainedIntent): string {
  const parsed = PiCancellationRetainedIntentSchema.parse(intent)
  return createHash('sha256')
    .update(
      canonicalJsonStringify([
        parsed.target.workspaceId,
        parsed.target.productIntentId,
        parsed.target.servicePrincipalId,
        parsed.idempotencyKey,
      ])
    )
    .digest('hex')
}
function retryPayload(key: string, intent: PiCancellationRetainedIntent) {
  return RetrySchema.parse({
    schemaVersion: 'pi-cancellation-request-retry/v1',
    requestKey: key,
    requestDigest: intent.requestDigest,
    targetDigest: piCancellationTargetDigest(intent.target),
  })
}
function fail(code: string): never {
  throw new Error(code)
}

/** Request persistence only. No permit, current product authorization, lifecycle transition or effect. */
export class PostgresPiCancellationRequests {
  constructor(readonly database: ControlPlaneDatabase) {}

  async retain(
    input: PiCancellationRetainedIntent
  ): Promise<{ record: StoredRequest; replayed: boolean }> {
    const intent = PiCancellationRetainedIntentSchema.parse(input)
    const key = piCancellationRequestKey(intent)
    return this.database.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${piCancellationRequestNamespace}:${key}`}, 0))`
      )
      const existing = await read(tx, key)
      if (existing) {
        assertPiCancellationIntentReplay(existing.intent, intent)
        await assertOutbox(tx, key, existing)
        // Historical request evidence can replay after CP state advances. It grants no current permission.
        return { record: existing, replayed: true }
      }
      const target = intent.target
      const ids = deterministicPiLeadIntentIds(target.workspaceId, target.productIntentId)
      if (ids.executionId !== target.executionId || ids.attemptId !== target.attemptId)
        fail('PI_CANCELLATION_REQUEST_BINDING_REJECTED')
      // Command -> execution -> attempt matches acceptance ownership. SHARE blocks non-key
      // lifecycle/version updates as well as deletion while both records are inserted.
      const [command] = await tx
        .select()
        .from(commandInbox)
        .where(eq(commandInbox.commandId, ids.commandId))
        .for('share')
      const [execution] = await tx
        .select()
        .from(executions)
        .where(eq(executions.executionId, target.executionId))
        .for('share')
      const [attempt] = await tx
        .select()
        .from(executionAttempts)
        .where(eq(executionAttempts.attemptId, target.attemptId))
        .for('share')
      if (
        !command ||
        !execution ||
        !attempt ||
        command.operation !== 'execution.accept' ||
        command.requestId !== ids.requestId ||
        command.idempotencyKey !== `lead-turn:${target.productIntentId}` ||
        command.callerPrincipalId !== target.servicePrincipalId ||
        command.workspaceId !== target.workspaceId ||
        command.executionId !== target.executionId ||
        execution.workspaceId !== target.workspaceId ||
        execution.latestAttemptId !== target.attemptId ||
        attempt.executionId !== target.executionId ||
        attempt.sequence !== execution.attemptCount ||
        command.projectId !== execution.projectId ||
        command.taskId !== execution.taskId ||
        command.agentId !== execution.agentId ||
        canonicalJsonStringify(command.executionScope) !==
          canonicalJsonStringify(execution.executionScope) ||
        command.executionPlanId !== execution.executionPlanId ||
        command.executionPlanDigest !== execution.executionPlanDigest ||
        command.executionPlanSchemaVersion !== execution.executionPlanSchemaVersion ||
        (attempt.externalSessionId !== null &&
          attempt.externalSessionId !== target.handle.externalSessionId)
      )
        fail('PI_CANCELLATION_REQUEST_BINDING_REJECTED')
      if (
        execution.version !== target.executionVersion ||
        attempt.version !== target.attemptVersion
      )
        fail('PI_CANCELLATION_REQUEST_STALE_VERSION')
      const record = RecordSchema.parse({
        schemaVersion: 'pi-cancellation-request-record/v1',
        intent,
        outboxId: randomUUID(),
        retainedAt: new Date().toISOString(),
      })
      await tx.insert(persistenceRecords).values({
        namespace: piCancellationRequestNamespace,
        id: key,
        revision: 1,
        value: record,
        updatedAt: record.retainedAt,
      })
      await tx.insert(outboxEvents).values({
        id: record.outboxId,
        aggregateType,
        aggregateId: key,
        eventType: piCancellationRequestEvent,
        payload: retryPayload(key, intent),
      })
      return { record, replayed: false }
    })
  }

  /** Internal exact-request retrieval, never an audience/read grant or a current-authority result. */
  async get(input: PiCancellationRetainedIntent): Promise<StoredRequest | undefined> {
    const intent = PiCancellationRetainedIntentSchema.parse(input)
    const key = piCancellationRequestKey(intent)
    return this.database.transaction(async (tx) => {
      const record = await read(tx, key)
      if (!record) return undefined
      assertPiCancellationIntentReplay(record.intent, intent)
      await assertOutbox(tx, key, record)
      return record
    })
  }
}
async function read(tx: Transaction, key: string): Promise<StoredRequest | undefined> {
  const [row] = await tx
    .select()
    .from(persistenceRecords)
    .where(
      and(
        eq(persistenceRecords.namespace, piCancellationRequestNamespace),
        eq(persistenceRecords.id, key)
      )
    )
    .for('share')
  if (!row) return undefined
  if (row.revision !== 1) fail('PI_CANCELLATION_REQUEST_RECORD_CORRUPT')
  const record = RecordSchema.parse(row.value)
  if (piCancellationRequestKey(record.intent) !== key || row.updatedAt !== record.retainedAt)
    fail('PI_CANCELLATION_REQUEST_RECORD_CORRUPT')
  return record
}
async function assertOutbox(tx: Transaction, key: string, record: StoredRequest): Promise<void> {
  const [outbox] = await tx
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.id, record.outboxId))
    .for('share')
  if (
    !outbox ||
    outbox.aggregateType !== aggregateType ||
    outbox.aggregateId !== key ||
    outbox.eventType !== piCancellationRequestEvent ||
    canonicalJsonStringify(RetrySchema.parse(outbox.payload)) !==
      canonicalJsonStringify(retryPayload(key, record.intent))
  )
    fail('PI_CANCELLATION_REQUEST_OUTBOX_CORRUPT')
}
